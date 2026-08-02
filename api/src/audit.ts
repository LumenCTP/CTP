import { getDb } from "./db";
import { calculateVendorCompliance, type VendorComplianceResult } from "./compliance";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

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

const AUDITS_DIR = path.join(import.meta.dir, "..", "data", "audits");
const API_BASE = path.join(import.meta.dir, "..");

function ensureAuditsDir() {
  if (!existsSync(AUDITS_DIR)) {
    mkdirSync(AUDITS_DIR, { recursive: true });
  }
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

export function generateAuditPackage(req: AuditRequest, tenantId: number): AuditResult {
  const db = getDb();

  // Verify client exists
  const client = db
    .query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id")
    .get({ $id: req.client_id, $tenant_id: tenantId }) as { id: number; name: string } | undefined;

  if (!client) {
    throw new Error(`Client not found: ${req.client_id}`);
  }

  // Search documents
  const docs = searchDocuments(req, tenantId);

  // Group by vendor
  const vendorMap = new Map<number, {
    vendorName: string;
    vendorContact: string | null;
    vendorEmail: string | null;
    docs: DocRow[];
  }>();

  for (const doc of docs) {
    if (!vendorMap.has(doc.vendor_id)) {
      vendorMap.set(doc.vendor_id, {
        vendorName: doc.vendor_name,
        vendorContact: doc.vendor_contact_name,
        vendorEmail: doc.vendor_contact_email,
        docs: [],
      });
    }
    vendorMap.get(doc.vendor_id)!.docs.push(doc);
  }

  const clientSlug = client.name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
  const dateStr = new Date().toISOString().slice(0, 10);
  const rootDir = `audit_${clientSlug}_${dateStr}`;

  // Build ZIP entries
  const zipEntries: ZipEntry[] = [];

  // Track report data
  const allMissingLines: string[] = [];
  const allExpiredLines: string[] = [];
  const vendorSummaries: Array<{ vendor_name: string; doc_count: number }> = [];
  let totalDocCount = 0;

  // Process each vendor
  for (const [vendorId, vdata] of vendorMap) {
    const vendorDir = `${rootDir}/vendor_${vdata.vendorName.replace(/[^a-zA-Z0-9]/g, "_")}`;

    // Calculate compliance
    const compliance = calculateVendorCompliance(vendorId, req.client_id, tenantId);

    // Vendor summary
    const summaryText = generateVendorSummary(
      vdata.vendorName,
      vdata.vendorContact,
      vdata.vendorEmail,
      compliance,
      vdata.docs.length,
    );
    zipEntries.push({
      name: `${vendorDir}/vendor_summary.txt`,
      data: Buffer.from(summaryText, "utf-8"),
    });

    vendorSummaries.push({
      vendor_name: vdata.vendorName,
      doc_count: vdata.docs.length,
    });

    // Missing documents report
    const missingText = generateMissingDocsReport(vdata.vendorName, compliance);
    if (missingText) {
      allMissingLines.push(missingText);
    }

    // Expired documents report
    const expiredText = generateExpiredDocsReport(vdata.vendorName, compliance);
    if (expiredText) {
      allExpiredLines.push(expiredText);
    }

    // Add document files
    const seenFiles = new Set<string>();
    for (const doc of vdata.docs) {
      totalDocCount++;
      // file_path is relative to api/ (e.g., "data/documents/1_apex_coi_2026.pdf")
      const fullPath = path.join(API_BASE, doc.file_path);

      if (existsSync(fullPath) && !seenFiles.has(fullPath)) {
        seenFiles.add(fullPath);
        try {
          const fileData = readFileSync(fullPath);
          zipEntries.push({
            name: `${vendorDir}/${doc.original_filename}`,
            data: fileData,
          });
        } catch (err) {
          console.error(`[audit] Could not read file: ${fullPath}`, err);
          // Include a note about the missing file
          zipEntries.push({
            name: `${vendorDir}/${doc.original_filename}.error.txt`,
            data: Buffer.from(`File could not be read: ${doc.file_path}`, "utf-8"),
          });
        }
      }
    }
  }

  // Missing documents report (global)
  if (allMissingLines.length > 0) {
    const header = `MISSING REQUIRED DOCUMENTS REPORT\n` +
      `========================================\n` +
      `Generated: ${dateStr}\n` +
      `Client: ${client.name}\n\n`;
    zipEntries.push({
      name: `${rootDir}/missing_documents.txt`,
      data: Buffer.from(header + allMissingLines.join(""), "utf-8"),
    });
  } else {
    zipEntries.push({
      name: `${rootDir}/missing_documents.txt`,
      data: Buffer.from(`MISSING REQUIRED DOCUMENTS REPORT\n========================================\nGenerated: ${dateStr}\nClient: ${client.name}\n\nNo missing documents found.\n`, "utf-8"),
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
      data: Buffer.from(header + allExpiredLines.join(""), "utf-8"),
    });
  } else {
    zipEntries.push({
      name: `${rootDir}/expired_documents.txt`,
      data: Buffer.from(`EXPIRED DOCUMENTS REPORT\n========================================\nGenerated: ${dateStr}\nClient: ${client.name}\n\nNo expired documents found.\n`, "utf-8"),
    });
  }

  // Summary JSON
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
    matching_documents: totalDocCount,
    vendors_included: vendorSummaries.length,
    vendors: vendorSummaries,
  };

  zipEntries.push({
    name: `${rootDir}/summary.json`,
    data: Buffer.from(JSON.stringify(summaryJson, null, 2), "utf-8"),
  });

  // Generate ZIP
  ensureAuditsDir();
  const zipBuffer = createZipBuffer(zipEntries);

  const zipFilename = `audit_${clientSlug}_${Date.now()}.zip`;
  const zipPath = path.join(AUDITS_DIR, zipFilename);
  Bun.write(zipPath, zipBuffer);

  return {
    download_url: `/api/audit/download/${encodeURIComponent(zipFilename)}`,
    summary: {
      matching_documents: totalDocCount,
      vendors: vendorSummaries.length,
      total_size: zipBuffer.length,
    },
  };
}
