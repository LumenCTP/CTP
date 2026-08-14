/**
 * In-App AI Chat Assistant — API routes (v1).
 *
 * POST /api/chat/ask          — one tenant-scoped Q&A exchange (rate limited)
 * GET  /api/chat/messages     — session history (tenant-scoped)
 *
 * Mounted in index.ts via app.route("/", chatRoutes). Tenant gating comes
 * from TENANT_DATA_PATHS in middleware.ts (this module adds no auth of its
 * own — it inherits requireAuth + requireTenant).
 */

import { Hono } from "hono";
import { getDb } from "../db";
import {
  buildSystemPrompt,
  callChatCompletion,
  gatherTenantSnapshot,
  postValidate,
  type ChatSnapshot,
} from "../chat";

const app = new Hono();

// ── In-memory per-tenant rate limiting ──────────────────
// Sliding-window timestamps. 30 questions/hour/tenant, burst 6/minute.
// Correct for the single-process Bun server; if the API ever runs
// multi-process this resets per process (still safe, just permissive).
const rateHits = new Map<number, number[]>();
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const RATE_LIMIT_HOUR = 30;
const RATE_LIMIT_MINUTE = 6;

function isRateLimited(tenantId: number): boolean {
  const now = Date.now();
  const hits = (rateHits.get(tenantId) ?? []).filter((t) => now - t < HOUR_MS);
  const burst = hits.filter((t) => now - t < MINUTE_MS);
  if (burst.length >= RATE_LIMIT_MINUTE) return true;
  if (hits.length >= RATE_LIMIT_HOUR) return true;
  hits.push(now);
  rateHits.set(tenantId, hits);
  return false;
}

const MAX_MESSAGE_CHARS = 1500;
const HISTORY_TURNS = 8; // last 8 messages (4 user turns) of context

// ── POST /api/chat/ask ───────────────────────────────────
app.post("/api/chat/ask", async (c) => {
  const tenantId = c.get("tenant_id") as number;

  if (isRateLimited(tenantId)) {
    return c.json(
      { error: "rate_limited", message: "You've reached the chat limit for now. Please wait a bit and try again." },
      429
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "Message is required" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return c.json({ error: `Message must be ${MAX_MESSAGE_CHARS} characters or fewer` }, 400);
  }
  const sessionId =
    typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim()
      : crypto.randomUUID();

  const db = getDb();
  const user = c.get("user") as { user_id: number } | undefined;
  const userId = user?.user_id ?? null;

  // Persist the user message first (tenant-scoped), then fetch history so the
  // LLM context includes the new question exactly once.
  db.query(
    `INSERT INTO chat_messages (tenant_id, user_id, session_id, role, message)
     VALUES ($tid, $uid, $sid, 'user', $msg)`
  ).run({ $tid: tenantId, $uid: userId, $sid: sessionId, $msg: message });

  const history = db
    .query(
      `SELECT role, message FROM chat_messages
       WHERE tenant_id = $tid AND session_id = $sid
       ORDER BY id DESC LIMIT ${HISTORY_TURNS}`
    )
    .all({ $tid: tenantId, $sid: sessionId })
    .reverse() as Array<{ role: "user" | "assistant"; message: string }>;

  let snapshot: ChatSnapshot;
  try {
    snapshot = gatherTenantSnapshot(tenantId);
  } catch (err) {
    console.error(`[chat] snapshot build failed for tenant ${tenantId}:`, err);
    return c.json(
      { error: "assistant_unavailable", message: "The assistant couldn't load your compliance data right now. Please try again in a moment." },
      502
    );
  }

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: buildSystemPrompt(snapshot) },
    ...history.map((h) => ({ role: h.role, content: h.message })),
  ];

  // One LLM call; retry once if the output isn't usable JSON.
  let result = await callChatCompletion(messages);
  if (result && !result.parsed) result = await callChatCompletion(messages);
  if (!result || !result.parsed) {
    console.warn(`[chat] assistant unavailable for tenant ${tenantId} (no usable LLM response)`);
    return c.json(
      { error: "assistant_unavailable", message: "The assistant is temporarily unavailable. Please try again in a moment." },
      502
    );
  }

  const validated = postValidate(result.parsed, snapshot);
  const usage = result.usage;

  const statusCards =
    validated.payment_status || validated.vendor_name
      ? JSON.stringify({ payment_status: validated.payment_status, vendor_name: validated.vendor_name })
      : null;

  const asstInsert = db.query(
    `INSERT INTO chat_messages
       (tenant_id, user_id, session_id, role, message, status_cards, escalate, model, prompt_tokens, completion_tokens, cost_estimate)
     VALUES ($tid, $uid, $sid, 'assistant', $msg, $cards, $esc, $model, $pt, $ct, $cost)`
  ).run({
    $tid: tenantId,
    $uid: userId,
    $sid: sessionId,
    $msg: validated.answer,
    $cards: statusCards,
    $esc: validated.escalate ? 1 : 0,
    $model: usage.model,
    $pt: usage.prompt_tokens,
    $ct: usage.completion_tokens,
    $cost: usage.cost_estimate_usd,
  });
  const assistantMessageId = Number(asstInsert.lastInsertRowid);

  console.log(
    `[chat] ok session=${sessionId} model=${usage.model} in=${usage.prompt_tokens} out=${usage.completion_tokens} cost=$${usage.cost_estimate_usd.toFixed(6)} escalate=${validated.escalate}`
  );

  return c.json({
    session_id: sessionId,
    message_id: assistantMessageId,
    answer: validated.answer,
    payment_status: validated.payment_status,
    vendor_name: validated.vendor_name,
    escalate: validated.escalate,
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cost_estimate_usd: usage.cost_estimate_usd,
    },
  });
});

// ── GET /api/chat/messages?session_id= ───────────────────
app.get("/api/chat/messages", (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return c.json({ error: "session_id is required" }, 400);
  const rows = getDb()
    .query(
      `SELECT id, role, message, status_cards, escalate, created_at
       FROM chat_messages
       WHERE tenant_id = $tid AND session_id = $sid
       ORDER BY id ASC`
    )
    .all({ $tid: c.get("tenant_id") as number, $sid: sessionId });
  return c.json(rows);
});

export default app;
