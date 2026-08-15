import { getDb } from "./db";
import { calculateVendorCompliance, type VendorComplianceResult } from "./compliance";
import { storageGet, storageKeyFromFilePath, storagePut } from "./storage";

// ── Types ───────────────────────────────────────────────

export interface AuditRequest {
  client_id: number;
  vendor_id?: number;
  document_type?: string;
  date_from?: string;
  date_to?: string;
}

export interface AuditResult {
  download_url: string;
  summary: {
    matching_documents: number;
    vendors: number;
    total_size: number;
  };
}

interface DocRow {
  id: number;
  vendor_id: number;
  client_id: number;
  document_type: string;
  file_path: string;
  original_filename: string;
  sender_name: string | null;
  sender_email: string | null;
  received_date: string;
  expiration_date: string | null;
  is_reviewed: number | null;
  vendor_name: string;
  vendor_contact_name: string | null;
  vendor_contact_email: string | null;
  client_name: string;
}

// ── Document Search ─────────────────────────────────────

function searchDocuments(req: AuditRequest, tenantId: number): DocRow[] {
  const db = getDb();

  let sql = `
    SELECT
      d.id, d.vendor_id, d.client_id, d.document_type,
      d.file_path, d.original_filename,
      d.sender_name, d.sender_email, d.received_date,
      de.expiration_date, de.is_reviewed,
      v.name AS vendor_name,
      v.contact_name AS vendor_contact_name,
      v.contact_email AS vendor_contact_email,
      c.name AS client_name
    FROM documents d
    JOIN vendors v ON d.vendor_id = v.id
    JOIN clients c ON d.client_id = c.id
    LEFT JOIN document_extractions de ON de.document_id = d.id
    WHERE d.client_id = $client_id AND d.tenant_id = $tenant_id
  `;

  const params: Record<string, unknown> = {
    $client_id: req.client_id,
    $tenant_id: tenantId,
  };

  if (req.vendor_id) {
    sql += " AND d.vendor_id = $vendor_id";
    params.$vendor_id = req.vendor_id;
  }

  if (req.document_type) {
    sql += " AND d.document_type = $doc_type";
    params.$doc_type = req.document_type;
  }

  if (req.date_from) {
    sql += " AND d.received_date >= $date_from";
    params.$date_from = req.date_from;
  }

  if (req.date_to) {
    sql += " AND d.received_date <= $date_to";
    params.$date_to = req.date_to;
  }

  sql += " ORDER BY v.name ASC, d.document_type ASC, d.received_date DESC";

  return db.query(sql).all(params) as DocRow[];
}

// ── Text Report Generators ──────────────────────────────

function formatDateStr(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Owner-specified document ordering: COI (Certificate of Insurance) first,
// then W-9/W9, then every other document type alphabetically.
function docTypeSortRank(documentType: string): [number, string] {
  const norm = documentType.trim().toLowerCase().replace(/[\s_\-]+/g, "");
  if (norm === "coi" || norm.startsWith("certificateofinsurance")) return [0, norm];
  if (norm === "w9" || norm === "w-9" || norm === "w9form" || norm.startsWith("w9")) return [1, norm];
  return [2, norm];
}

function sortDocs(docs: DocRow[]): DocRow[] {
  return [...docs].sort((a, b) => {
    const [ra, na] = docTypeSortRank(a.document_type);
    const [rb, nb] = docTypeSortRank(b.document_type);
    if (ra !== rb) return ra - rb;
    if (na !== nb) return na < nb ? -1 : 1;
    // Most recently received first within the same type
    return b.received_date.localeCompare(a.received_date);
  });
}

const AUDIT_TEXT_FOOTER = `\nThis file is part of an administrative audit package and may not include every relevant document or issue. Review the source documents and package contents before relying on or sharing it. ClearToPay does not verify coverage adequacy or provide legal or insurance advice.\n`;

// PAGE-ONE summary — the first file in the audit package (client info, date
// range, vendor count, unique doc count, missing/expired summary).
function generateAuditSummary(opts: {
  clientName: string;
  dateStr: string;
  dateFrom: string | null;
  dateTo: string | null;
  vendorCount: number;
  docCount: number;
  missingItemCount: number;
  missingVendorCount: number;
  expiredItemCount: number;
  expiredVendorCount: number;
}): string {
  const lines: string[] = [];
  lines.push(`========================================`);
  lines.push(`AUDIT PACKAGE SUMMARY`);
  lines.push(`========================================`);
  lines.push(`Client: ${opts.clientName}`);
  lines.push(`Generated: ${opts.dateStr}`);
  const range =
    opts.dateFrom || opts.dateTo
      ? `${opts.dateFrom ?? "earliest"} to ${opts.dateTo ?? "latest"}`
      : "All documents";
  lines.push(`Date Range: ${range}`);
  lines.push(`Vendors Included: ${opts.vendorCount}`);
  lines.push(`Total Documents: ${opts.docCount}`);
  lines.push(
    `Missing Required Documents: ${opts.missingItemCount} item(s) across ${opts.missingVendorCount} vendor(s)`,
  );
  lines.push(
    `Expired Documents: ${opts.expiredItemCount} item(s) across ${opts.expiredVendorCount} vendor(s)`,
  );
  lines.push(``);
  lines.push(
    `This package reflects the compliance documents on file and the criteria configured for ${opts.clientName} as of ${opts.dateStr}. It is an administrative tool, not legal advice. ClearToPay does not determine coverage adequacy; final payment and coverage decisions are the client's responsibility.`,
  );
  lines.push(``);
  lines.push(
    `This file is part of an administrative audit package and may not include every relevant document or issue. Review the source documents and package contents before relying on or sharing it. ClearToPay does not verify coverage adequacy or provide legal or insurance advice.`,
  );
  lines.push(``);
  return lines.join("\n");
}

function generateVendorSummary(
  vendorName: string,
  vendorContact: string | null,
  vendorEmail: string | null,
  compliance: VendorComplianceResult,
  docCount: number,
): string {
  const lines: string[] = [];
  lines.push(`========================================`);
  lines.push(`VENDOR COMPLIANCE SUMMARY`);
  lines.push(`========================================`);
  lines.push(`Vendor: ${vendorName}`);
  if (vendorContact) lines.push(`Contact: ${vendorContact}`);
  if (vendorEmail) lines.push(`Email: ${vendorEmail}`);
  lines.push(`Compliance Status: ${compliance.status.toUpperCase()}`);
  lines.push(`Payment Status: ${compliance.payment_status.toUpperCase()}`);
  lines.push(`Documents in Audit: ${docCount}`);
  lines.push(``);
  lines.push(`Per-Document-Type Breakdown:`);
  lines.push(`----------------------------------------`);
  for (const d of compliance.details) {
    const statusIcon =
      d.status === "compliant" ? "✓" :
      d.status === "expiring_soon" ? "⏰" :
      d.status === "expired" ? "✗" :
      d.status === "needs_review" ? "🔍" : "⚠";
    lines.push(`  ${statusIcon} ${d.document_type}: ${d.status.toUpperCase()}`);
    if (d.expiration_date) {
      lines.push(`     Expires: ${formatDateStr(d.expiration_date)}`);
    }
    if (d.has_unreviewed) {
      lines.push(`     Has unreviewed documents`);
    }
  }
  lines.push(``);
  lines.push(
    `This file is part of an administrative audit package and may not include every relevant document or issue. Review the source documents and package contents before relying on or sharing it. ClearToPay does not verify coverage adequacy or provide legal or insurance advice.`,
  );
  lines.push(``);
  return lines.join("\n");
}

function generateMissingDocsReport(
  vendorName: string,
  compliance: VendorComplianceResult,
): string | null {
  const missing = compliance.details.filter((d) => d.status === "missing");
  if (missing.length === 0) return null;

  const lines: string[] = [];
  lines.push(`Vendor: ${vendorName}`);
  lines.push(`Missing Required Documents:`);
  for (const m of missing) {
    lines.push(`  - ${m.document_type}`);
  }
  lines.push(``);
  return lines.join("\n");
}

function generateExpiredDocsReport(
  vendorName: string,
  compliance: VendorComplianceResult,
): string | null {
  const expired = compliance.details.filter((d) => d.status === "expired");
  if (expired.length === 0) return null;

  const lines: string[] = [];
  lines.push(`Vendor: ${vendorName}`);
  lines.push(`Expired Documents:`);
  for (const e of expired) {
    lines.push(`  - ${e.document_type} (Expired: ${formatDateStr(e.expiration_date)})`);
  }
  lines.push(``);
  return lines.join("\n");
}

// ── Lightweight ZIP Creator (stored / no compression) ──

interface ZipEntry {
  name: string;
  data: Buffer;
}

function createZipBuffer(entries: ZipEntry[]): Buffer {
  // Build local file entries + data
  const localBuffers: Buffer[] = [];
  const centralDirEntries: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf-8");
    const nameLength = nameBuffer.length;
    const data = entry.data;
    const crc = crc32(data);

    // DOS date/time (current time)
    const dosDateTime = dateToDosDateTime(new Date());

    // Local file header
    const localHeader = Buffer.alloc(30 + nameLength);
    let pos = 0;
    localHeader.writeUInt32LE(0x04034b50, pos); pos += 4; // signature
    localHeader.writeUInt16LE(20, pos); pos += 2;         // version needed
    localHeader.writeUInt16LE(0, pos); pos += 2;          // flags
    localHeader.writeUInt16LE(0, pos); pos += 2;          // compression: stored
    localHeader.writeUInt16LE(dosDateTime.time, pos); pos += 2;
    localHeader.writeUInt16LE(dosDateTime.date, pos); pos += 2;
    localHeader.writeUInt32LE(crc, pos); pos += 4;
    localHeader.writeUInt32LE(data.length, pos); pos += 4;  // compressed size
    localHeader.writeUInt32LE(data.length, pos); pos += 4;  // uncompressed size
    localHeader.writeUInt16LE(nameLength, pos); pos += 2;
    localHeader.writeUInt16LE(0, pos); pos += 2;           // extra field length
    nameBuffer.copy(localHeader, pos);

    localBuffers.push(localHeader);
    localBuffers.push(data);

    const entryOffset = offset;
    const headerSize = 30 + nameLength;
    offset += headerSize + data.length;

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameLength);
    pos = 0;
    cdEntry.writeUInt32LE(0x02014b50, pos); pos += 4; // signature
    cdEntry.writeUInt16LE(20, pos); pos += 2;          // version made by
    cdEntry.writeUInt16LE(20, pos); pos += 2;          // version needed
    cdEntry.writeUInt16LE(0, pos); pos += 2;           // flags
    cdEntry.writeUInt16LE(0, pos); pos += 2;           // compression
    cdEntry.writeUInt16LE(dosDateTime.time, pos); pos += 2;
    cdEntry.writeUInt16LE(dosDateTime.date, pos); pos += 2;
    cdEntry.writeUInt32LE(crc, pos); pos += 4;
    cdEntry.writeUInt32LE(data.length, pos); pos += 4;   // compressed size
    cdEntry.writeUInt32LE(data.length, pos); pos += 4;   // uncompressed size
    cdEntry.writeUInt16LE(nameLength, pos); pos += 2;
    cdEntry.writeUInt16LE(0, pos); pos += 2;             // extra field length
    cdEntry.writeUInt16LE(0, pos); pos += 2;             // file comment length
    cdEntry.writeUInt16LE(0, pos); pos += 2;             // disk number start
    cdEntry.writeUInt16LE(0, pos); pos += 2;             // internal attrs
    cdEntry.writeUInt32LE(0, pos); pos += 4;             // external attrs
    cdEntry.writeUInt32LE(entryOffset, pos); pos += 4;   // local header offset
    nameBuffer.copy(cdEntry, pos);

    centralDirEntries.push(cdEntry);
  }

  // End of central directory record
  const cdOffset = offset;
  const cdSize = centralDirEntries.reduce((s, e) => s + e.length, 0);

  const eocd = Buffer.alloc(22);
  let pos = 0;
  eocd.writeUInt32LE(0x06054b50, pos); pos += 4; // signature
  eocd.writeUInt16LE(0, pos); pos += 2;           // disk number
  eocd.writeUInt16LE(0, pos); pos += 2;           // disk with CD
  eocd.writeUInt16LE(entries.length, pos); pos += 2; // entries on disk
  eocd.writeUInt16LE(entries.length, pos); pos += 2; // total entries
  eocd.writeUInt32LE(cdSize, pos); pos += 4;
  eocd.writeUInt32LE(cdOffset, pos); pos += 4;
  eocd.writeUInt16LE(0, pos); // comment length

  return Buffer.concat([
    ...localBuffers,
    ...centralDirEntries,
    eocd,
  ]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc >>>= 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dateToDosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getSeconds() >> 1) | (d.getMinutes() << 5) | (d.getHours() << 11);
  const date = d.getDate() | ((d.getMonth() + 1) << 5) | ((d.getFullYear() - 1980) << 9);
  return { time, date };
}

// ── Main Audit Generation ───────────────────────────────

export async function generateAuditPackage(req: AuditRequest, tenantId: number): Promise<AuditResult> {
  const db = getDb();

  // Verify client exists (tenant-scoped)
  const client = db
    .query("SELECT id, name, contact_email, contact_phone, address FROM clients WHERE id = $id AND tenant_id = $tenant_id")
    .get({ $id: req.client_id, $tenant_id: tenantId }) as
    | { id: number; name: string; contact_email: string | null; contact_phone: string | null; address: string | null }
    | undefined;

  if (!client) {
    throw new Error(`Client not found: ${req.client_id}`);
  }

  // Every vendor for this client (tenant-scoped) — INCLUDING vendors with zero
  // documents, so they show up in the missing-docs report instead of being
  // silently dropped. When a vendor filter is applied, only that vendor is
  // audited.
  const vendors = req.vendor_id
    ? (db
        .query(
          `SELECT id, name, contact_name, contact_email FROM vendors
           WHERE id = $vendor_id AND client_id = $client_id AND tenant_id = $tenant_id`,
        )
        .all({ $vendor_id: req.vendor_id, $client_id: req.client_id, $tenant_id: tenantId }) as Array<{
        id: number;
        name: string;
        contact_name: string | null;
        contact_email: string | null;
      }>)
    : (db
        .query(
          `SELECT id, name, contact_name, contact_email FROM vendors
           WHERE client_id = $client_id AND tenant_id = $tenant_id
           ORDER BY name ASC`,
        )
        .all({ $client_id: req.client_id, $tenant_id: tenantId }) as Array<{
        id: number;
        name: string;
        contact_name: string | null;
        contact_email: string | null;
      }>);

  // Search documents (tenant- and client-scoped)
  const docs = searchDocuments(req, tenantId);

  // Group documents by vendor, deduped by document id — the LEFT JOIN on
  // document_extractions can repeat a document row (joined rows duplicating),
  // and the same physical file can be referenced by multiple rows; the same
  // document must never be counted or embedded twice.
  const vendorMap = new Map<number, {
    vendorName: string;
    vendorContact: string | null;
    vendorEmail: string | null;
    docs: DocRow[];
  }>();
  for (const v of vendors) {
    vendorMap.set(v.id, {
      vendorName: v.name,
      vendorContact: v.contact_name,
      vendorEmail: v.contact_email,
      docs: [],
    });
  }

  const seenDocIds = new Set<number>();
  for (const doc of docs) {
    if (seenDocIds.has(doc.id)) continue;
    seenDocIds.add(doc.id);
    const v = vendorMap.get(doc.vendor_id);
    if (v) v.docs.push(doc);
  }

  const clientSlug = client.name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
  const dateStr = new Date().toISOString().slice(0, 10);
  const rootDir = `audit_${clientSlug}_${dateStr}`;

  // Per-vendor entries + global report data
  const vendorEntries: ZipEntry[] = [];
  const allMissingLines: string[] = [];
  const allExpiredLines: string[] = [];
  const vendorSummaries: Array<{ vendor_name: string; doc_count: number }> = [];

  let totalDocCount = 0;
  let missingItemCount = 0;
  let missingVendorCount = 0;
  let expiredItemCount = 0;
  let expiredVendorCount = 0;

  // Process each vendor (alphabetical; zero-doc vendors get a summary + their
  // required docs appear in the missing report)
  for (const [vendorId, vdata] of vendorMap) {
    const vendorDir = `${rootDir}/vendor_${vdata.vendorName.replace(/[^a-zA-Z0-9]/g, "_")}`;

    // Calculate compliance
    const compliance = calculateVendorCompliance(vendorId, req.client_id, tenantId);

    // Order documents: COI → W-9 → other types (alphabetical)
    const orderedDocs = sortDocs(vdata.docs);

    // Add document files — dedupe by document id (done above) AND by physical
    // file, so a file referenced by multiple rows is only counted/embedded once.
    // Files are read through the storage abstraction (R2 when configured,
    // local disk otherwise) keyed off the DB file_path.
    const seenFiles = new Set<string>();
    const docEntries: ZipEntry[] = [];
    let vendorUniqueDocCount = 0;
    for (const doc of orderedDocs) {
      // file_path is relative to api/ (e.g., "data/uploads/49/x.pdf")
      const storageKey = storageKeyFromFilePath(doc.file_path);
      if (seenFiles.has(storageKey)) continue;
      seenFiles.add(storageKey);
      totalDocCount++;
      vendorUniqueDocCount++;

      const obj = await storageGet(storageKey);
      if (obj) {
        try {
          docEntries.push({
            name: `${vendorDir}/${doc.original_filename}`,
            data: obj.data,
          });
        } catch (err) {
          console.error(`[audit] Could not read file: ${storageKey}`, err);
          // Include a note about the missing file — client-visible, so it must
          // never carry internal storage paths (owner confidentiality directive).
          docEntries.push({
            name: `${vendorDir}/${doc.original_filename}.error.txt`,
            data: Buffer.from("The source file for this document could not be read. Please contact support.", "utf-8"),
          });
        }
      } else {
        docEntries.push({
          name: `${vendorDir}/${doc.original_filename}.error.txt`,
          data: Buffer.from("The source file for this document could not be read. Please contact support.", "utf-8"),
        });
      }
    }

    // Vendor summary (doc count = unique documents embedded for this vendor)
    const summaryText = generateVendorSummary(
      vdata.vendorName,
      vdata.vendorContact,
      vdata.vendorEmail,
      compliance,
      vendorUniqueDocCount,
    );
    vendorEntries.push({
      name: `${vendorDir}/vendor_summary.txt`,
      data: Buffer.from(summaryText, "utf-8"),
    });
    vendorEntries.push(...docEntries);

    vendorSummaries.push({
      vendor_name: vdata.vendorName,
      doc_count: vendorUniqueDocCount,
    });

    // Missing documents report
    const missingText = generateMissingDocsReport(vdata.vendorName, compliance);
    if (missingText) {
      allMissingLines.push(missingText);
      missingVendorCount++;
      missingItemCount += compliance.details.filter((d) => d.status === "missing").length;
    }

    // Expired documents report
    const expiredText = generateExpiredDocsReport(vdata.vendorName, compliance);
    if (expiredText) {
      allExpiredLines.push(expiredText);
      expiredVendorCount++;
      expiredItemCount += compliance.details.filter((d) => d.status === "expired").length;
    }
  }

  // ── PAGE-ONE SUMMARY — first file in the package ──
  const zipEntries: ZipEntry[] = [];
  zipEntries.push({
    name: `${rootDir}/00_Summary.txt`,
    data: Buffer.from(
      generateAuditSummary({
        clientName: client.name,
        dateStr,
        dateFrom: req.date_from || null,
        dateTo: req.date_to || null,
        vendorCount: vendorMap.size,
        docCount: totalDocCount,
        missingItemCount,
        missingVendorCount,
        expiredItemCount,
        expiredVendorCount,
      }),
      "utf-8",
    ),
  });
  zipEntries.push(...vendorEntries);

  // Missing documents report (global) — always present so a package can never
  // falsely claim "none missing" when vendors were simply omitted.
  if (allMissingLines.length > 0) {
    const header = `MISSING REQUIRED DOCUMENTS REPORT\n` +
      `========================================\n` +
      `Generated: ${dateStr}\n` +
      `Client: ${client.name}\n\n`;
    zipEntries.push({
      name: `${rootDir}/missing_documents.txt`,
      data: Buffer.from(header + allMissingLines.join("") + AUDIT_TEXT_FOOTER, "utf-8"),
    });
  } else {
    zipEntries.push({
      name: `${rootDir}/missing_documents.txt`,
      data: Buffer.from(`MISSING REQUIRED DOCUMENTS REPORT\n========================================\nGenerated: ${dateStr}\nClient: ${client.name}\n\nNo missing documents found.\n${AUDIT_TEXT_FOOTER}`, "utf-8"),
    });
  }

  // Expired documents report (global)
  if (allExpiredLines.length > 0) {
    const header = `EXPIRED DOCUMENTS REPORT\n` +
      `========================================\n` +
      `Generated: ${dateStr}\n` +
      `Client: ${client.name}\n\n`;
    zipEntries.push({
      name: `${rootDir}/expired_documents.txt`,
      data: Buffer.from(header + allExpiredLines.join("") + AUDIT_TEXT_FOOTER, "utf-8"),
    });
  } else {
    zipEntries.push({
      name: `${rootDir}/expired_documents.txt`,
      data: Buffer.from(`EXPIRED DOCUMENTS REPORT\n========================================\nGenerated: ${dateStr}\nClient: ${client.name}\n\nNo expired documents found.\n${AUDIT_TEXT_FOOTER}`, "utf-8"),
    });
  }

  // Summary JSON (machine-readable; kept in sync with the page-one summary)
  const summaryJson = {
    audit_date: dateStr,
    client_name: client.name,
    client_id: req.client_id,
    filters: {
      vendor_id: req.vendor_id || null,
      document_type: req.document_type || null,
      date_from: req.date_from || null,
      date_to: req.date_to || null,
    },
    total_documents: totalDocCount,
    matching_documents: totalDocCount,
    vendors_included: vendorMap.size,
    missing_documents: { vendors: missingVendorCount, items: missingItemCount },
    expired_documents: { vendors: expiredVendorCount, items: expiredItemCount },
    vendors: vendorSummaries,
  };

  zipEntries.push({
    name: `${rootDir}/summary.json`,
    data: Buffer.from(JSON.stringify(summaryJson, null, 2), "utf-8"),
  });

  // Generate ZIP — stored under the tenant's own key prefix
  // (audits/tenant-<id>/, local: data/audits/tenant-<id>/)
  const zipBuffer = createZipBuffer(zipEntries);

  const zipFilename = `audit_${clientSlug}_${Date.now()}.zip`;
  await storagePut(`audits/tenant-${tenantId}/${zipFilename}`, zipBuffer, "application/zip");

  return {
    download_url: `/api/audit/download/${encodeURIComponent(zipFilename)}`,
    summary: {
      matching_documents: totalDocCount,
      vendors: vendorMap.size,
      total_size: zipBuffer.length,
    },
  };
}
