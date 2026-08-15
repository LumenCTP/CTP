import { Hono } from "hono";
import path from "node:path";
import { getDb } from "../db";
import { slugFromToAddress } from "../lib/inbox";
import { QUEUE_SECRET } from "../secrets";
import { logAudit, requireQueueSecret } from "../middleware";
import { extractDocumentInfoFromBytes } from "../extract";
import { mapCOIToEntities } from "../mapping";
import { calculateVendorCompliance } from "../compliance";
import { storageGetStream, storageKeyFromFilePath, storagePut } from "../storage";

const app = new Hono();

// ── Documents ──────────────────────────────────────────
const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

export async function ingestDocumentAttachment(opts: {
  db: ReturnType<typeof getDb>;
  tenantId: number;
  filename: string;
  content: Uint8Array;
  contentType: string;
  senderName?: string | null;
  senderEmail?: string | null;
  clientId?: number | null;
  vendorId?: number | null;
}) {
  const { db, tenantId } = opts;
  if (!ALLOWED_TYPES.includes(opts.contentType)) throw new Error("Unsupported file type. Allowed: PDF, JPG, PNG");
  if (opts.content.length > MAX_UPLOAD_SIZE) throw new Error("File too large. Maximum size is 10MB");
  const originalFilename = path.basename(opts.filename).replace(/[\\/]/g, "_") || "attachment";
  const clientId = opts.clientId ?? null;
  let vendorId = opts.vendorId ?? null;
  if (vendorId === null && opts.senderEmail) { const matches = db.query("SELECT id FROM vendors WHERE lower(contact_email)=lower($email) AND tenant_id=$tid").all({$email:opts.senderEmail,$tid:tenantId}) as Array<{id:number}>; if (matches.length === 1) { vendorId = matches[0].id; console.log(`[inbox] matched sender ${opts.senderEmail} to vendor ${vendorId}`); } }
  if (clientId !== null && !db.query("SELECT id FROM clients WHERE id=$id AND tenant_id=$tid").get({$id:clientId,$tid:tenantId})) throw new Error("Client not found");
  if (vendorId !== null && !db.query("SELECT id FROM vendors WHERE id=$id AND tenant_id=$tid").get({$id:vendorId,$tid:tenantId})) throw new Error("Vendor not found");
  if (clientId !== null && vendorId !== null && !db.query("SELECT id FROM vendors WHERE id=$id AND client_id=$cid AND tenant_id=$tid").get({$id:vendorId,$cid:clientId,$tid:tenantId})) throw new Error("Vendor does not belong to client");
  // Persist to object storage (R2) when configured, otherwise the existing
  // local-disk layout (api/data/uploads/<tenantId>/...) — the storage key is
  // documents/<tenantId>/<basename> in both modes.
  const storedFilename = `${Date.now()}-${originalFilename}`;
  const storageKey = `documents/${tenantId}/${storedFilename}`;
  await storagePut(storageKey, opts.content, opts.contentType);
  // DB file_path stays in the historical layout so existing audit-trail
  // filters (file_path LIKE 'data/uploads/%') and local-mode resolution work
  // unchanged. storageKeyFromFilePath() maps it back to the storage key.
  const relPath = `data/uploads/${tenantId}/${storedFilename}`;
  const result = db.query(`INSERT INTO documents (vendor_id,client_id,document_type,file_path,original_filename,content_type,file_size,sender_name,sender_email,tenant_id) VALUES ($vid,$cid,'Other',$path,$name,$type,$size,$sender,$email,$tid)`).run({$vid:vendorId,$cid:clientId,$path:relPath,$name:originalFilename,$type:opts.contentType,$size:opts.content.length,$sender:opts.senderName || null,$email:opts.senderEmail || null,$tid:tenantId});
  const documentId = Number(result.lastInsertRowid);
  db.query("INSERT INTO ingestion_events (document_id,status) VALUES ($id,'uploaded')").run({$id:documentId});
  logAudit(db,"document",documentId,"uploaded",{filename:originalFilename,file_size:opts.content.length,content_type:opts.contentType,tenant_id:tenantId});
  db.query("UPDATE ingestion_events SET status='processing',updated_at=datetime('now') WHERE document_id=$id").run({$id:documentId});
  // Extraction runs on the in-memory bytes so it works whether the file is on
  // local disk (fallback mode) or only in R2.
  extractDocumentInfoFromBytes(opts.content, originalFilename).then((extraction) => {
    // is_reviewed intentionally stays at its default 0 (Needs Review) for every
    // new extraction — including high-confidence AI ones — until a human reviews
    // it. The honest filename fallback therefore lands in Needs Review too, and
    // no fabricated/filename-only data can ever drive compliance statuses.
    db.query(`INSERT OR REPLACE INTO document_extractions (document_id,vendor_name,insurance_carrier,policy_number,effective_date,expiration_date,certificate_holder,certificate_holder_address,certificate_holder_name_confidence,insured_address,w9_form_date,producer_name,producer_contact,producer_email,producer_phone,document_type,ai_confidence_score,extraction_method) VALUES ($id,$vendor,$carrier,$policy,$effective,$expiration,$holder,$holder_address,$holder_confidence,$insured_address,$w9_date,$prod_name,$prod_contact,$prod_email,$prod_phone,$type,$confidence,$method)`).run({$id:documentId,$vendor:extraction.vendor_name,$carrier:extraction.insurance_carrier,$policy:extraction.policy_number,$effective:extraction.effective_date,$expiration:extraction.expiration_date,$holder:extraction.certificate_holder,$holder_address:extraction.certificate_holder_address,$holder_confidence:extraction.certificate_holder_name_confidence,$insured_address:extraction.insured_address,$w9_date:extraction.form_date,$prod_name:extraction.producer_name,$prod_contact:extraction.producer_contact,$prod_email:extraction.producer_email,$prod_phone:extraction.producer_phone,$type:extraction.document_type,$confidence:extraction.ai_confidence_score,$method:extraction.extraction_method});
    db.query("UPDATE documents SET document_type=$type WHERE id=$id AND tenant_id=$tid").run({$type:extraction.document_type||"Other",$id:documentId,$tid:tenantId});
    // Auto-create client/vendor rows ONLY from real AI extraction with high
    // holder confidence. The honest fallback sets confidence 0 and
    // extraction_method 'filename', so it can never trigger this path.
    if (extraction.document_type === "COI" && extraction.extraction_method === "ai" && extraction.certificate_holder_name_confidence >= 0.8) { const mapped = mapCOIToEntities(db, tenantId, extraction, documentId); if (mapped) { db.query("UPDATE documents SET client_id=$cid, vendor_id=$vid WHERE id=$id AND tenant_id=$tid").run({$cid:mapped.clientId,$vid:mapped.vendorId,$id:documentId,$tid:tenantId}); calculateVendorCompliance(mapped.vendorId, mapped.clientId, tenantId); if (mapped.vendorPossibleDuplicate) { logAudit(db, "document", documentId, "possible_duplicate_vendor", { existing_vendor_id: mapped.vendorId, extracted_vendor_name: extraction.vendor_name, extracted_address: extraction.insured_address, note: "Document attached to existing same-name vendor; is_reviewed stays 0 until a human confirms" }); } } }
    else if (vendorId !== null && clientId !== null) calculateVendorCompliance(vendorId,clientId,tenantId);
    db.query("UPDATE ingestion_events SET status='ready',updated_at=datetime('now') WHERE document_id=$id").run({$id:documentId});
  }).catch((err) => { db.query("UPDATE ingestion_events SET status='error',error_message=$error,updated_at=datetime('now') WHERE document_id=$id").run({$error:String(err),$id:documentId}); });
  return { id: documentId, original_filename: originalFilename, content_type: opts.contentType, file_size: opts.content.length };
}

// POST /api/documents/upload — persist immediately, extract asynchronously
app.post("/api/documents/upload", async (c) => {
  try {
    const form = await c.req.formData(); const file = form.get("file");
    if (!file || !(file instanceof File)) return c.json({ error: "File is required" }, 400);
    const clientRaw = form.get("client_id"); const vendorRaw = form.get("vendor_id");
    const clientId = clientRaw ? Number(clientRaw) : null; const vendorId = vendorRaw ? Number(vendorRaw) : null;
    if (clientRaw && !Number.isInteger(clientId)) return c.json({ error: "Invalid client_id" }, 400);
    if (vendorRaw && !Number.isInteger(vendorId)) return c.json({ error: "Invalid vendor_id" }, 400);
    const document = await ingestDocumentAttachment({db:getDb(),tenantId:c.get("tenant_id") as number,filename:file.name,content:new Uint8Array(await file.arrayBuffer()),contentType:file.type,senderName:form.get("sender_name")?.toString(),senderEmail:form.get("sender_email")?.toString(),clientId,vendorId});
    return c.json({document,ingestion_status:"processing"},201);
  } catch (err) { console.error("[upload]",err); return c.json({error:String(err)},500); }
});

// POST /api/inbox/ingest — receive attachments from an email-ingestion worker.
app.post("/api/inbox/ingest", async (c) => {
  try {
    const body = await c.req.json();
    if (!Array.isArray(body?.attachments) || body.attachments.length === 0) return c.json({error:"attachments must be a non-empty array"},400);
    const db = getDb();
    let tenantId = c.get("tenant_id") as number | undefined;
    if (!tenantId && c.req.header("X-Queue-Secret") === QUEUE_SECRET && typeof body.tenant_slug === "string") { const t = db.query("SELECT id FROM tenants WHERE inbox_slug=$slug COLLATE NOCASE").get({$slug:body.tenant_slug}) as {id:number}|undefined; if (!t) return c.json({error:"Unknown tenant_slug"},404); tenantId=t.id; }
    if (!tenantId) return c.json({error:"Tenant is required"},401);
    const clientId = body.client_id == null ? null : Number(body.client_id), vendorId = body.vendor_id == null ? null : Number(body.vendor_id);
    if (clientId !== null && !Number.isInteger(clientId) || vendorId !== null && !Number.isInteger(vendorId)) return c.json({error:"Invalid client_id or vendor_id"},400);
    const documents = [];
    for (const a of body.attachments) {
      if (!a || typeof a.filename !== "string" || typeof a.content_base64 !== "string" || typeof a.content_type !== "string") return c.json({error:"Each attachment requires filename, content_base64, and content_type"},400);
      let content: Uint8Array; try { content = Uint8Array.from(atob(a.content_base64.replace(/^data:[^;]+;base64,/, "")), ch => ch.charCodeAt(0)); } catch { return c.json({error:`Invalid base64 for ${a.filename}`},400); }
      documents.push(await ingestDocumentAttachment({db,tenantId,filename:a.filename,content,contentType:a.content_type,senderName:body.sender_name,senderEmail:body.sender_email,clientId,vendorId}));
    }
    return c.json({documents,ingested_count:documents.length},201);
  } catch (err) { console.error("[inbox/ingest]",err); return c.json({error:String(err)},400); }
});

// POST /api/inbox/receive — queue raw email from an external mailbox poller.
app.post("/api/inbox/receive", async (c) => {
  const denied = requireQueueSecret(c); if (denied) return denied;
  try { const body = await c.req.json(); const slug=slugFromToAddress(String(body.to_address||""));
    if (!slug || !Array.isArray(body.attachments)) return c.json({error:"to_address with a tenant address and attachments are required"},400);
    const db=getDb(); const t=db.query("SELECT id FROM tenants WHERE inbox_slug=$slug COLLATE NOCASE").get({$slug:slug}) as {id:number}|undefined; if(!t) return c.json({error:"Unknown tenant slug"},404);
    const raw={...body,tenant_slug:slug}; const q=db.query("INSERT INTO inbox_queue (raw_email_json,processed) VALUES ($raw,1)").run({$raw:JSON.stringify(raw)});
    const docs=[]; for(const a of body.attachments) { if(typeof a.filename!=="string"||typeof a.content_base64!=="string"||typeof a.content_type!=="string") return c.json({error:"Invalid attachment"},400); const content=Uint8Array.from(atob(a.content_base64.replace(/^data:[^;]+;base64,/,"")),ch=>ch.charCodeAt(0)); docs.push(await ingestDocumentAttachment({db,tenantId:t.id,filename:a.filename,content,contentType:a.content_type,senderName:body.from_name,senderEmail:body.from_address})); }
    return c.json({queued:true,queue_id:Number(q.lastInsertRowid),documents:docs},201); } catch(err){ console.error("[inbox/receive]",err); return c.json({error:String(err)},400); }
});

// POST /api/inbox/relay — multipart receiver for future email webhook providers.
app.post("/api/inbox/relay", async (c) => {
  try {
    const form = await c.req.formData(), files = Array.from(form.values()).filter((v): v is File => v instanceof File && v.size > 0);
    if (!files.length) return c.json({error:"At least one attachment is required"},400);
    const clientRaw=form.get("client_id"), vendorRaw=form.get("vendor_id"), clientId=clientRaw?Number(clientRaw):null, vendorId=vendorRaw?Number(vendorRaw):null;
    const documents=[]; for (const file of files) documents.push(await ingestDocumentAttachment({db:getDb(),tenantId:c.get("tenant_id") as number,filename:file.name,content:new Uint8Array(await file.arrayBuffer()),contentType:file.type,senderName:form.get("sender_name")?.toString() || form.get("from_name")?.toString(),senderEmail:form.get("sender_email")?.toString() || form.get("from")?.toString(),clientId,vendorId}));
    return c.json({documents,ingested_count:documents.length},201);
  } catch (err) { console.error("[inbox/relay]",err); return c.json({error:String(err)},400); }
});
// GET /api/documents — list documents with filters
app.get("/api/documents", (c) => {
  try {
    const db = getDb();
    const clientId = c.req.query("client_id");
    const vendorId = c.req.query("vendor_id");
    const needsReview = c.req.query("needs_review");

    let sql = `
      SELECT
        d.id, d.vendor_id, d.client_id,
        v.name AS vendor_name,
        c.name AS client_name,
        d.document_type, d.file_path, d.original_filename,
        d.sender_name, d.sender_email,
        d.received_date, d.created_at, ie.status AS ingestion_status, d.content_type, d.file_size,
        de.ai_confidence_score,
        de.is_reviewed,
        de.insurance_carrier,
        de.policy_number,
        de.effective_date,
        de.expiration_date,
        de.certificate_holder,
        de.certificate_holder_address,
        de.certificate_holder_name_confidence,
        de.insured_address,
        de.w9_form_date,
        de.producer_name,
        de.producer_contact,
        de.producer_email,
        de.producer_phone,
        de.extraction_method,
        de.document_type AS extracted_document_type
      FROM documents d
      LEFT JOIN clients c ON d.client_id = c.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      LEFT JOIN document_extractions de ON de.document_id = d.id
      LEFT JOIN ingestion_events ie ON ie.document_id = d.id
      WHERE d.tenant_id = $tenant_id
    `;

    const params: Record<string, unknown> = { $tenant_id: c.get("tenant_id") as number };

    if (clientId) {
      sql += " AND d.client_id = $client_id";
      params.$client_id = Number(clientId);
    }

    if (vendorId) {
      sql += " AND d.vendor_id = $vendor_id";
      params.$vendor_id = Number(vendorId);
    }

    if (needsReview === "true") {
      sql += " AND de.is_reviewed = 0";
    }

    sql += " ORDER BY d.created_at DESC";

    const rows = db.query(sql).all(params) as any[];
    const result = rows.map((r) => ({
      ...r,
      is_reviewed: !!r.is_reviewed,
    }));

    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/documents/:id — single document with all extractions
app.get("/api/documents/:id", (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const doc = db.query(`
      SELECT
        d.id, d.vendor_id, d.client_id,
        v.name AS vendor_name,
        c.name AS client_name,
        d.document_type, d.file_path, d.original_filename,
        d.sender_name, d.sender_email,
        d.received_date, d.created_at, ie.status AS ingestion_status, d.content_type, d.file_size,
        de.ai_confidence_score,
        de.is_reviewed,
        de.insurance_carrier,
        de.policy_number,
        de.effective_date,
        de.expiration_date,
        de.certificate_holder,
        de.certificate_holder_address,
        de.certificate_holder_name_confidence,
        de.insured_address,
        de.w9_form_date,
        de.producer_name,
        de.producer_contact,
        de.producer_email,
        de.producer_phone,
        de.extraction_method,
        de.document_type AS extracted_document_type
      FROM documents d
      LEFT JOIN clients c ON d.client_id = c.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      LEFT JOIN document_extractions de ON de.document_id = d.id
      LEFT JOIN ingestion_events ie ON ie.document_id = d.id
      WHERE d.id = $id AND d.tenant_id = $tenant_id
    `).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as any | undefined;

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    // Get all extraction history
    const extractions = db.query(`
      SELECT id, document_id, vendor_name, insurance_carrier, policy_number,
             effective_date, expiration_date, certificate_holder, document_type,
             ai_confidence_score, certificate_holder_address, certificate_holder_name_confidence, insured_address, w9_form_date, producer_name, producer_contact, producer_email, producer_phone, is_reviewed, extraction_method, extracted_at
      FROM document_extractions
      WHERE document_id = $document_id
      ORDER BY extracted_at DESC
    `).all({ $document_id: id, $tenant_id: c.get("tenant_id") as number }) as any[];

    return c.json({
      ...doc,
      is_reviewed: !!doc.is_reviewed,
      extractions: extractions.map((e) => ({ ...e, is_reviewed: !!e.is_reviewed })),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/documents/:id/file — serve the document file
app.get("/api/documents/:id/file", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    // Tenant scope is enforced here (id + tenant_id) — the auth middleware
    // already required a valid token, so 401/403 semantics are unchanged.
    const doc = db.query(
      "SELECT file_path, original_filename, content_type FROM documents WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: c.get("tenant_id") as number }) as { file_path: string; original_filename: string; content_type: string | null } | undefined;

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const key = storageKeyFromFilePath(doc.file_path);
    const obj = await storageGetStream(key);
    if (!obj) {
      return c.json({ error: "File not found" }, 404);
    }

    const contentType =
      doc.content_type || obj.contentType || "application/octet-stream";
    return new Response(obj.stream, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${doc.original_filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/documents/:id/extraction — manually update extraction
app.put("/api/documents/:id/extraction", async (c) => {
  try {
    const db = getDb();
    const id = Number(c.req.param("id"));

    const tenantId = c.get("tenant_id");
    const existing = db.query(
      `SELECT de.id, de.document_id FROM document_extractions de
       JOIN documents d ON d.id = de.document_id
       WHERE de.document_id = $document_id AND d.tenant_id = $tenant_id
       ORDER BY de.extracted_at DESC LIMIT 1`
    ).get({ $document_id: id, $tenant_id: tenantId }) as { id: number; document_id: number } | undefined;

    if (!existing) {
      return c.json({ error: "No extraction found for this document" }, 404);
    }

    const body = await c.req.json();
    const {
      vendor_name,
      insurance_carrier,
      policy_number,
      effective_date,
      expiration_date,
      certificate_holder,
      document_type,
      producer_name,
      producer_contact,
      producer_email,
      producer_phone,
      is_reviewed,
      vendor_id,
      client_id,
    } = body;

    // Build dynamic update
    const updates: string[] = [];
    const params: Record<string, unknown> = { $extraction_id: existing.id, $document_id: id };

    if (vendor_name !== undefined) {
      updates.push("vendor_name = $vendor_name");
      params.$vendor_name = vendor_name?.trim() || null;
    }
    if (insurance_carrier !== undefined) {
      updates.push("insurance_carrier = $insurance_carrier");
      params.$insurance_carrier = insurance_carrier?.trim() || null;
    }
    if (policy_number !== undefined) {
      updates.push("policy_number = $policy_number");
      params.$policy_number = policy_number?.trim() || null;
    }
    if (effective_date !== undefined) {
      updates.push("effective_date = $effective_date");
      params.$effective_date = effective_date?.trim() || null;
    }
    if (expiration_date !== undefined) {
      updates.push("expiration_date = $expiration_date");
      params.$expiration_date = expiration_date?.trim() || null;
    }
    if (certificate_holder !== undefined) {
      updates.push("certificate_holder = $certificate_holder");
      params.$certificate_holder = certificate_holder?.trim() || null;
    }
    if (document_type !== undefined) {
      updates.push("document_type = $document_type");
      params.$document_type = document_type?.trim() || null;
    }
    if (producer_name !== undefined) {
      updates.push("producer_name = $producer_name");
      params.$producer_name = producer_name?.trim() || null;
    }
    if (producer_contact !== undefined) {
      updates.push("producer_contact = $producer_contact");
      params.$producer_contact = producer_contact?.trim() || null;
    }
    if (producer_email !== undefined) {
      updates.push("producer_email = $producer_email");
      params.$producer_email = producer_email?.trim() || null;
    }
    if (producer_phone !== undefined) {
      updates.push("producer_phone = $producer_phone");
      params.$producer_phone = producer_phone?.trim() || null;
    }
    if (is_reviewed !== undefined) {
      updates.push("is_reviewed = $is_reviewed");
      params.$is_reviewed = is_reviewed ? 1 : 0;
    }

    // Always update document_type on the parent document if it changed
    if (document_type !== undefined && document_type) {
      db.query("UPDATE documents SET document_type = $document_type WHERE id = $id AND tenant_id = $tenant_id")
        .run({ $document_type: document_type.trim(), $id: id, $tenant_id: tenantId });
    }

    if (updates.length > 0) {
      updates.push("extracted_at = datetime('now')");
      db.query(
        `UPDATE document_extractions SET ${updates.join(", ")} WHERE id = $extraction_id`
      ).run(params);
    }

    // ── Manual entity assignment ────────────────────────────────────────────
    // Persist an explicit vendor/client assignment from the review UI, or fall
    // back to the same auto-mapping used on upload (mapCOIToEntities) when the
    // document is still unassigned. Then recalculate compliance so the new
    // assignment immediately affects the vendor's payment status + dashboard.
    const doc = db.query(
      "SELECT vendor_id, client_id FROM documents WHERE id = $id AND tenant_id = $tenant_id"
    ).get({ $id: id, $tenant_id: tenantId }) as { vendor_id: number | null; client_id: number | null } | undefined;
    // Prior assignment — the old vendor's compliance must be recalculated too
    // when a document is reassigned or unassigned.
    const priorVendorId: number | null = doc?.vendor_id ?? null;
    const priorClientId: number | null = doc?.client_id ?? null;

    const explicitIdsGiven = vendor_id !== undefined || client_id !== undefined;
    let vendorId: number | null = doc?.vendor_id ?? null;
    let clientId: number | null = doc?.client_id ?? null;

    if (explicitIdsGiven) {
      if (vendor_id !== undefined) {
        if (vendor_id === null || vendor_id === 0) {
          vendorId = null;
        } else {
          const v = db.query("SELECT id FROM vendors WHERE id = $id AND tenant_id = $tid").get({ $id: Number(vendor_id), $tid: tenantId });
          if (!v) return c.json({ error: "Vendor does not belong to this tenant" }, 400);
          vendorId = Number(vendor_id);
        }
      }
      if (client_id !== undefined) {
        if (client_id === null || client_id === 0) {
          clientId = null;
        } else {
          const cl = db.query("SELECT id FROM clients WHERE id = $id AND tenant_id = $tid").get({ $id: Number(client_id), $tid: tenantId });
          if (!cl) return c.json({ error: "Client does not belong to this tenant" }, 400);
          clientId = Number(client_id);
        }
      }
    }

    // Auto-map from the (possibly corrected) extraction names when the document
    // is still unassigned and the reviewer did not explicitly choose "no match"
    // — the same logic the upload path uses.
    if (!explicitIdsGiven && !vendorId && !clientId) {
      const ext = db.query(
        "SELECT certificate_holder, certificate_holder_address, vendor_name, insured_address FROM document_extractions WHERE id = $id"
      ).get({ $id: existing.id }) as
        | { certificate_holder: string | null; certificate_holder_address: string | null; vendor_name: string | null; insured_address: string | null }
        | undefined;
      if (ext) {
        const mapped = mapCOIToEntities(db, tenantId, ext, id);
        if (mapped) {
          vendorId = mapped.vendorId;
          clientId = mapped.clientId;
          if (mapped.vendorPossibleDuplicate) {
            // Possible duplicate: a same-name vendor already exists under this
            // client (addresses differ or absent). Attach the document to the
            // existing vendor but force it back into the needs-review surface
            // (is_reviewed = 0) so a human must explicitly confirm this
            // document belongs to that vendor before it can affect compliance.
            db.query("UPDATE document_extractions SET is_reviewed = 0 WHERE id = $id").run({ $id: existing.id });
            logAudit(db, "document", id, "possible_duplicate_vendor", { existing_vendor_id: mapped.vendorId, extracted_vendor_name: ext.vendor_name, extracted_address: ext.insured_address, note: "Document auto-attached to existing same-name vendor; forced back to needs-review" });
          }
        }
      }
    }

    // Persist whenever the reviewer supplied ids (set OR explicit clear) or the
    // auto-mapping produced an assignment — a null/void clear must land too.
    if (explicitIdsGiven || vendorId !== null || clientId !== null) {
      db.query("UPDATE documents SET client_id = $cid, vendor_id = $vid WHERE id = $id AND tenant_id = $tid")
        .run({ $cid: clientId, $vid: vendorId, $id: id, $tid: tenantId });
    }

    // Recalculate compliance with the engine — same call as the upload path — so
    // the assignment flows through to payment status and the dashboard
    // immediately. The PRIOR vendor is recalculated as well when it changed: a
    // document removed from a vendor can flip that vendor's payment status back
    // to hold/review.
    if (priorVendorId !== null && priorVendorId !== vendorId) {
      const priorVendor = db.query("SELECT client_id FROM vendors WHERE id = $id AND tenant_id = $tid").get({ $id: priorVendorId, $tid: tenantId }) as { client_id: number } | undefined;
      if (priorVendor) calculateVendorCompliance(priorVendorId, priorVendor.client_id, tenantId);
    }
    if (vendorId !== null && clientId !== null) {
      calculateVendorCompliance(vendorId, clientId, tenantId);
    }
    logAudit(db, "document", id, "extraction_updated", { ...body, is_reviewed, prior_vendor_id: priorVendorId });

    // Return updated extraction
    const updated = db.query(
      "SELECT id, document_id, vendor_name, insurance_carrier, policy_number, effective_date, expiration_date, certificate_holder, document_type, producer_name, producer_contact, producer_email, producer_phone, ai_confidence_score, is_reviewed, extracted_at FROM document_extractions WHERE id = $id"
    ).get({ $id: existing.id }) as any;

    return c.json({ ...updated, is_reviewed: !!updated.is_reviewed });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/needs-review — documents needing review
app.get("/api/needs-review", (c) => {
  try {
    const db = getDb();

    const rows = db.query(`
      SELECT
        d.id, d.vendor_id, d.client_id,
        v.name AS vendor_name,
        c.name AS client_name,
        d.document_type, d.file_path, d.original_filename,
        d.sender_name, d.sender_email,
        d.received_date, d.created_at,
        de.ai_confidence_score,
        de.is_reviewed,
        de.insurance_carrier,
        de.policy_number,
        de.effective_date,
        de.expiration_date,
        de.certificate_holder,
        de.certificate_holder_address,
        de.certificate_holder_name_confidence,
        de.insured_address,
        de.w9_form_date,
        de.producer_name,
        de.producer_contact,
        de.producer_email,
        de.producer_phone,
        de.extraction_method,
        de.document_type AS extracted_document_type,
        de.id AS extraction_id,
        de.vendor_name AS extracted_vendor_name
      FROM documents d
      LEFT JOIN clients c ON d.client_id = c.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      JOIN document_extractions de ON de.document_id = d.id
      WHERE de.is_reviewed = 0 AND d.tenant_id = $tenant_id
      ORDER BY de.ai_confidence_score ASC, d.created_at DESC
    `).all({ $tenant_id: c.get("tenant_id") as number }) as any[];

    const result = rows.map((r) => ({
      ...r,
      is_reviewed: false,
    }));

    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
