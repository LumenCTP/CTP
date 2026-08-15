#!/usr/bin/env bun
/**
 * backfill-placeholder-docs.ts
 *
 * Generates lightweight placeholder PDFs for seeded documents that have DB rows
 * but no file bytes in object storage, and uploads each to R2 under the
 * document's EXISTING storage key (derived from file_path via
 * storageKeyFromFilePath), so the audit package and document viewer pick them up.
 *
 * This is test-data tooling only. It never modifies DB rows or client-visible
 * product copy: the placeholder PDFs are explicitly marked as reference/test
 * copies inside the generated document body.
 *
 * Usage:
 *   bun run scripts/backfill-placeholder-docs.ts --input /path/docs.json [--prefix data/documents/tenant-84/seed/]
 *
 * Input JSON: array of doc rows (see the sqlite3 -json query in the commit
 * message / final report) with fields:
 *   id, document_type, file_path, original_filename,
 *   vendor_name, client_name, certificate_holder,
 *   insurance_carrier, policy_number, effective_date, expiration_date,
 *   w9_form_date
 *
 * Only docs whose file_path starts with --prefix (default
 * "data/documents/tenant-" — i.e. the seeded-doc layout) are generated.
 * Existing non-empty storage objects are skipped (idempotent). At the end the
 * script verifies every row in the input (including real uploads) resolves to a
 * non-empty storage object and prints a summary.
 */
import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import { storageGet, storagePut, storageKeyFromFilePath } from "../src/storage";

interface DocRow {
  id: number;
  vendor_id?: number;
  client_id?: number;
  document_type: string;
  file_path: string;
  original_filename: string;
  content_type?: string | null;
  file_size?: number | null;
  received_date?: string | null;
  ext_vendor?: string | null;
  insurance_carrier?: string | null;
  policy_number?: string | null;
  effective_date?: string | null;
  expiration_date?: string | null;
  certificate_holder?: string | null;
  w9_form_date?: string | null;
  vendor_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  client_name?: string | null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function titleFor(documentType: string): string {
  const n = norm(documentType);
  if (n === "coi" || n.startsWith("certificateofinsurance")) return "CERTIFICATE OF INSURANCE";
  if (n.startsWith("w9")) return "W-9 — REQUEST FOR TAXPAYER IDENTIFICATION NUMBER AND CERTIFICATION";
  if (n.startsWith("generalliability")) return "GENERAL LIABILITY INSURANCE";
  if (n.startsWith("workerscomp")) return "WORKERS' COMPENSATION INSURANCE";
  if (n.startsWith("commercialauto")) return "COMMERCIAL AUTO INSURANCE";
  if (n.startsWith("umbrella")) return "UMBRELLA INSURANCE";
  return documentType.toUpperCase();
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function makePlaceholderPdf(r: DocRow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      info: { Title: r.original_filename, Author: "ClearToPay (test data backfill)" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const isW9 = norm(r.document_type).startsWith("w9");

    // Reference/test banner — this PDF is test data, so the banner lives in the
    // generated body (no client-visible product copy is touched).
    doc.rect(60, 42, doc.page.width - 120, 16).fill("#b03a2e");
    doc
      .fillColor("white")
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .text(
        "REFERENCE / TEST COPY — FOR DEMONSTRATION ONLY — NOT AN ORIGINAL DOCUMENT",
        60,
        46,
        { align: "center", width: doc.page.width - 120 }
      );

    doc.y = 90;
    doc
      .fillColor("#1a3a6b")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(titleFor(r.document_type), { align: "left" });
    doc.moveDown(0.3);
    doc
      .fillColor("#555555")
      .font("Helvetica")
      .fontSize(8.5)
      .text(`Document reference: ${r.original_filename}`, { align: "left" });
    doc.moveDown(0.9);

    doc.fillColor("#222222").font("Helvetica").fontSize(11);
    const row = (label: string, value: string | null | undefined) => {
      doc.font("Helvetica-Bold").text(label, { continued: true });
      doc.font("Helvetica").text(value && String(value).trim() ? "  " + value : "  —");
      doc.moveDown(0.3);
    };

    row("Insured / Vendor:", r.vendor_name || r.ext_vendor || "Unknown vendor");
    row("Client / Project (Certificate Holder):", r.certificate_holder || r.client_name || "—");
    if (isW9) {
      row("Taxpayer Name (per W-9):", r.ext_vendor || r.vendor_name || "—");
      row("Form Date:", r.w9_form_date ? fmtDate(r.w9_form_date) : "—");
    } else {
      row("Insurance Carrier:", r.insurance_carrier || "—");
      row("Policy Number:", r.policy_number || "—");
      row("Policy Effective Date:", fmtDate(r.effective_date));
      row("Policy Expiration Date:", fmtDate(r.expiration_date));
    }

    doc.moveDown(1.2);
    doc
      .fillColor("#666666")
      .font("Helvetica")
      .fontSize(8)
      .text(
        "This is a reference/test copy generated by ClearToPay for demonstration purposes. " +
          "It does not evidence coverage and is not a valid compliance document.",
        { align: "left" }
      );

    doc.end();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : "/tmp/docs.json";
  const prefixIdx = args.indexOf("--prefix");
  const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : "data/documents/tenant-";

  const rows = JSON.parse(readFileSync(inputPath, "utf-8")) as DocRow[];
  console.log(`[backfill] loaded ${rows.length} rows from ${inputPath}`);

  let uploaded = 0;
  let skipped = 0;
  let skippedEmpty = 0;
  let failed = 0;
  const targets = rows.filter((r) => (r.file_path || "").startsWith(prefix));
  console.log(`[backfill] ${targets.length} rows match prefix "${prefix}" (candidates for generation)`);

  for (const r of targets) {
    const key = storageKeyFromFilePath(r.file_path);
    try {
      const existing = await storageGet(key);
      if (existing && existing.data.length > 0) {
        skipped++;
        console.log(`[backfill] skip (object exists) doc ${r.id} -> ${key}`);
        continue;
      }
      if (existing) skippedEmpty++;
      const pdf = await makePlaceholderPdf(r);
      await storagePut(key, pdf, "application/pdf");
      uploaded++;
      console.log(`[backfill] uploaded doc ${r.id} (${r.document_type}, ${r.vendor_name || "?"}, ${pdf.length} bytes) -> ${key}`);
    } catch (err) {
      failed++;
      console.error(`[backfill] FAILED doc ${r.id} -> ${key}:`, String(err).slice(0, 300));
    }
  }

  // Verify every input row (including real uploads) resolves to a non-empty object.
  let missing = 0;
  let withObj = 0;
  for (const r of rows) {
    const key = storageKeyFromFilePath(r.file_path);
    const obj = await storageGet(key);
    if (obj && obj.data.length > 0) withObj++;
    else {
      missing++;
      console.error(`[backfill] MISSING OBJECT doc ${r.id} -> ${key}`);
    }
  }

  console.log(
    `[backfill] done: uploaded=${uploaded} skipped(existing)=${skipped} skipped(empty-object)=${skippedEmpty} failed=${failed} | ` +
      `object coverage: ${withObj}/${rows.length} rows have non-empty objects (missing=${missing})`
  );
  process.exit(missing > 0 || failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
