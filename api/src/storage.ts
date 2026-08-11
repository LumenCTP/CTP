/**
 * Object storage abstraction — Cloudflare R2 (S3-compatible) with a
 * local-disk fallback.
 *
 * When ALL of these env vars are set, every file operation goes to R2:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_R2_ACCESS_KEY_ID
 *   CLOUDFLARE_R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME
 *
 * When any of them is missing (`isStorageConfigured()` === false), every
 * operation falls back to the exact local-disk layout the app used before R2,
 * so the product keeps working identically without object storage:
 *   documents/<tenantId>/<file>  → api/data/uploads/<tenantId>/<file>
 *   reports/tenant-<id>/<file>   → api/data/reports/tenant-<id>/<file>
 *   audits/tenant-<id>/<file>    → api/data/audits/tenant-<id>/<file>
 *
 * Keys mirror the tenant-scoped local paths, so mapping a DB `file_path`
 * (e.g. "data/uploads/49/1785_x.pdf") to a storage key is a pure function
 * (`storageKeyFromFilePath`) and existing rows keep resolving in local mode.
 *
 * The R2 client is a small fetch-based SigV4 signer (service "s3", region
 * "auto") — no AWS SDK dependency, runs in Bun, testable against the real
 * bucket via `storageList`/`storageGet`.
 */

import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";

// ── Config / capability ──────────────────────────────────

const R2_ENV_VARS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

/** True only when ALL four R2 env vars are set. */
export function isStorageConfigured(): boolean {
  return R2_ENV_VARS.every((k) => !!process.env[k]);
}

const DATA_ROOT = path.join(import.meta.dir, "..", "data");

// ── Key ↔ local-path mapping (pure functions) ─────────────

/**
 * Converts a DB `file_path` (relative to api/, e.g. "data/uploads/49/x.pdf")
 * into the storage key used for the object (documents/49/x.pdf). Reports and
 * audits already live under data/reports/tenant-<id>/ and
 * data/audits/tenant-<id>/, so those map 1:1 (minus the "data/" prefix).
 */
export function storageKeyFromFilePath(filePath: string): string {
  const p = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (p.startsWith("data/uploads/")) return "documents/" + p.slice("data/uploads/".length);
  if (p.startsWith("data/documents/")) return "documents/" + p.slice("data/documents/".length);
  if (p.startsWith("data/reports/")) return p.slice("data/".length);
  if (p.startsWith("data/audits/")) return p.slice("data/".length);
  if (p.startsWith("data/")) return p.slice("data/".length);
  return p;
}

/**
 * Local-disk path for a storage key (only used in fallback mode). The
 * documents prefix maps to data/uploads/ to keep existing on-disk uploads and
 * DB `file_path` values resolving exactly as they did before R2.
 */
export function storageLocalPathForKey(key: string): string {
  const k = key.replace(/\\/g, "/");
  if (k.startsWith("documents/")) return path.join(DATA_ROOT, "uploads", k.slice("documents/".length));
  return path.join(DATA_ROOT, k);
}

// ── Local fallback implementation ────────────────────────

async function localPut(key: string, body: Uint8Array | Buffer | string): Promise<void> {
  const p = storageLocalPathForKey(key);
  mkdirSync(path.dirname(p), { recursive: true });
  await Bun.write(p, body);
}

async function localGet(key: string): Promise<Buffer | null> {
  const p = storageLocalPathForKey(key);
  if (!existsSync(p)) return null;
  return Buffer.from(await Bun.file(p).arrayBuffer());
}

function localGetStream(key: string): ReadableStream<Uint8Array> | null {
  const p = storageLocalPathForKey(key);
  if (!existsSync(p)) return null;
  return Bun.file(p).stream() as ReadableStream<Uint8Array>;
}

async function localDelete(key: string): Promise<void> {
  const p = storageLocalPathForKey(key);
  try {
    rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

function localList(prefix: string): string[] {
  const dir = storageLocalPathForKey(prefix);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, base: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, base ? `${base}/${e.name}` : e.name);
      else out.push(base ? `${base}/${e.name}` : e.name);
    }
  };
  walk(dir, "");
  return out;
}

// ── R2 SigV4 client (fetch-based, no SDK) ─────────────────

function r2Endpoint(): string {
  return `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

const S3_SERVICE = "s3";
const S3_REGION = "auto";

function sha256Hex(data: string | Uint8Array | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 percent-encode; keeps '/' when encodeSlash is false (path segments). */
function uriEncode(str: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      out += encodeURIComponent(ch).replace(/[!'()*]/g, (c) =>
        "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      );
    }
  }
  return out;
}

async function r2Fetch(opts: {
  method: string;
  key: string; // object key; "" for bucket-level operations
  query?: Record<string, string>;
  body?: Uint8Array | Buffer | string;
  contentType?: string;
}): Promise<Response> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID!;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!;
  const bucket = process.env.R2_BUCKET_NAME!;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = `/${bucket}${opts.key ? "/" + uriEncode(opts.key, false) : ""}`;

  const queryKeys = Object.keys(opts.query || {}).sort();
  const canonicalQueryString = queryKeys
    .map((k) => `${uriEncode(k, true)}=${uriEncode((opts.query as Record<string, string>)[k], true)}`)
    .join("&");

  const payload = opts.body != null ? Buffer.from(opts.body as ArrayBufferView) : Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);

  const headers: Record<string, string> = {
    host: new URL(r2Endpoint()).host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.contentType) headers["content-type"] = opts.contentType;

  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((h) => `${h}:${headers[h]}`).join("\n") + "\n";
  const signedHeaders = headerNames.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, S3_REGION);
  const kService = hmac(kRegion, S3_SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${r2Endpoint()}${canonicalUri}${canonicalQueryString ? "?" + canonicalQueryString : ""}`;
  const init: RequestInit = {
    method: opts.method,
    headers: { ...headers, Authorization: authorization },
  };
  if (opts.body != null) init.body = payload;
  return fetch(url, init);
}

// ── Public storage API ────────────────────────────────────

/**
 * Stores an object. Content-Type is persisted as object metadata so downloads
 * can return the correct MIME type.
 */
export async function storagePut(
  key: string,
  body: Uint8Array | Buffer | string,
  contentType?: string,
): Promise<void> {
  if (!isStorageConfigured()) {
    await localPut(key, body);
    return;
  }
  const res = await r2Fetch({ method: "PUT", key, body, contentType });
  if (!res.ok) {
    throw new Error(`R2 PUT failed for ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/** Returns the full object (Buffer) plus stored Content-Type, or null. */
export async function storageGet(
  key: string,
): Promise<{ data: Buffer; contentType: string | null } | null> {
  if (!isStorageConfigured()) {
    const data = await localGet(key);
    if (!data) return null;
    return { data, contentType: null };
  }
  const res = await r2Fetch({ method: "GET", key });
  if (!res.ok) return null;
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType: res.headers.get("content-type") };
}

/**
 * Streaming variant for downloads: returns a ReadableStream (R2 response body
 * or Bun.file stream) without buffering the whole object in memory.
 */
export async function storageGetStream(
  key: string,
): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | null } | null> {
  if (!isStorageConfigured()) {
    const stream = localGetStream(key);
    if (!stream) return null;
    return { stream, contentType: null };
  }
  const res = await r2Fetch({ method: "GET", key });
  if (!res.ok || !res.body) return null;
  return { stream: res.body as ReadableStream<Uint8Array>, contentType: res.headers.get("content-type") };
}

/** Deletes an object. No-op when the key does not exist. */
export async function storageDelete(key: string): Promise<void> {
  if (!isStorageConfigured()) {
    await localDelete(key);
    return;
  }
  const res = await r2Fetch({ method: "DELETE", key });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE failed for ${key}: HTTP ${res.status}`);
  }
}

/**
 * Lists object keys under a prefix (R2: ListObjectsV2; local: directory walk).
 * Mainly a verification/dev helper.
 */
export async function storageList(prefix: string): Promise<string[]> {
  if (!isStorageConfigured()) {
    return localList(prefix);
  }
  const res = await r2Fetch({
    method: "GET",
    key: "",
    query: { "list-type": "2", prefix, "max-keys": "1000" },
  });
  if (!res.ok) throw new Error(`R2 LIST failed for prefix ${prefix}: HTTP ${res.status}`);
  const xml = await res.text();
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) keys.push(m[1]);
  return keys;
}
