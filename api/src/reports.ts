import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { getDb } from "./db";
import {
  calculateClientCompliance,
  calculatePaymentWeek,
  calculateVendorCompliance,
  type PerTypeDetail,
  type VendorComplianceResult,
} from "./compliance";

// ── Types ───────────────────────────────────────────────

export interface ReportVendor {
  vendor_id: number;
  vendor_name: string;
  contact_name: string | null;
  contact_email: string | null;
  payment_status: string;
  details: PerTypeDetail[];
  reason?: string;
}

export interface ReportData {
  client_id: number;
  client_name: string;
  report_date: string;
  payment_week: { monday: string; sunday: string };
  approved: ReportVendor[];
  review: ReportVendor[];
  hold: ReportVendor[];
  expiring_during_week: Array<{
    vendor_name: string;
    document_type: string;
    expiration_date: string;
  }>;
  missing_docs: Array<{
    vendor_name: string;
    missing_types: string[];
  }>;
}

const REPORTS_DIR = path.join(import.meta.dir, "..", "data", "reports");

function ensureReportsDir() {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

// ── Report Data Gathering ───────────────────────────────

export function gatherReportData(clientId: number): ReportData {
  const db = getDb();

  const client = db
    .query("SELECT id, name FROM clients WHERE id = $id")
    .get({ $id: clientId }) as { id: number; name: string } | undefined;

  if (!client) {
    throw new Error(`Client not found: ${clientId}`);
  }

  const tenantRow = db.query("SELECT tenant_id FROM clients WHERE id = $id").get({ $id: clientId }) as { tenant_id: number } | undefined;
  if (!tenantRow?.tenant_id) throw new Error(`Client tenant not found: ${clientId}`);

  // Ensure fresh compliance data
  calculateClientCompliance(clientId, tenantRow.tenant_id);

  const { monday, sunday } = calculatePaymentWeek();
  const today = new Date().toISOString().slice(0, 10);

  // Get all vendors for this client with full compliance details
  const vendorRows = db
    .query(
      `SELECT v.id, v.name, v.contact_name, v.contact_email,
              cs.payment_status
       FROM vendors v
       LEFT JOIN compliance_status cs ON cs.vendor_id = v.id
       WHERE v.client_id = $client_id
       ORDER BY v.name ASC`
    )
    .all({ $client_id: clientId }) as Array<{
    id: number;
    name: string;
    contact_name: string | null;
    contact_email: string | null;
    payment_status: string | null;
  }>;

  const approved: ReportVendor[] = [];
  const review: ReportVendor[] = [];
  const hold: ReportVendor[] = [];
  const expiringDuringWeek: ReportData["expiring_during_week"] = [];
  const missingDocs: ReportData["missing_docs"] = [];

  for (const v of vendorRows) {
    const compliance: VendorComplianceResult = calculateVendorCompliance(
      v.id,
      clientId,
      tenantRow.tenant_id
    );

    const rv: ReportVendor = {
      vendor_id: v.id,
      vendor_name: v.name,
      contact_name: v.contact_name,
      contact_email: v.contact_email,
      payment_status: compliance.payment_status,
      details: compliance.details,
    };

    // Determine reason for review/hold
    if (compliance.payment_status === "hold") {
      const missing = compliance.details
        .filter((d) => d.status === "missing")
        .map((d) => d.document_type);
      const expired = compliance.details
        .filter((d) => d.status === "expired")
        .map((d) => d.document_type);
      const expiringInWeek = compliance.details.filter((d) => {
        return (
          d.is_reviewed &&
          d.expiration_date &&
          d.expiration_date >= today &&
          d.expiration_date <= sunday
        );
      });

      const reasons: string[] = [];
      if (missing.length > 0) reasons.push(`Missing: ${missing.join(", ")}`);
      if (expired.length > 0) reasons.push(`Expired: ${expired.join(", ")}`);
      if (expiringInWeek.length > 0) {
        reasons.push(
          `Expiring during payment week: ${expiringInWeek
            .map((e) => e.document_type)
            .join(", ")}`
        );
      }
      rv.reason = reasons.join("; ");
      hold.push(rv);
    } else if (compliance.payment_status === "review") {
      const reasons: string[] = [];
      if (compliance.details.some((d) => d.has_unreviewed)) {
        reasons.push("Documents in review");
      }
      if (
        compliance.details.some((d) => {
          if (!d.is_reviewed || !d.expiration_date) return false;
          const expDate = d.expiration_date;
          const sevenDays = new Date(today);
          sevenDays.setDate(sevenDays.getDate() + 7);
          const sevenDaysStr = sevenDays.toISOString().slice(0, 10);
          return expDate >= today && expDate <= sevenDaysStr;
        })
      ) {
        reasons.push("Expiring within 7 days");
      }
      rv.reason = reasons.join("; ") || "Needs review";
      review.push(rv);
    } else {
      approved.push(rv);
    }

    // Collect expiring-during-week entries
    for (const d of compliance.details) {
      if (
        d.is_reviewed &&
        d.expiration_date &&
        d.expiration_date >= monday &&
        d.expiration_date <= sunday
      ) {
        expiringDuringWeek.push({
          vendor_name: v.name,
          document_type: d.document_type,
          expiration_date: d.expiration_date,
        });
      }
    }

    // Collect missing docs
    const missing = compliance.details
      .filter((d) => d.status === "missing")
      .map((d) => d.document_type);
    if (missing.length > 0) {
      missingDocs.push({
        vendor_name: v.name,
        missing_types: missing,
      });
    }
  }

  return {
    client_id: client.id,
    client_name: client.name,
    report_date: today,
    payment_week: { monday, sunday },
    approved,
    review,
    hold,
    expiring_during_week: expiringDuringWeek,
    missing_docs: missingDocs,
  };
}

// ── Colors ───────────────────────────────────────────────

const COLORS = {
  blue: "#1a56db",
  green: "#059669",
  amber: "#d97706",
  red: "#dc2626",
  dark: "#1f2937",
  gray: "#6b7280",
  lightGray: "#e5e7eb",
  white: "#ffffff",
};

function paymentStatusColor(status: string): string {
  if (status === "approved") return COLORS.green;
  if (status === "review") return COLORS.amber;
  return COLORS.red;
}

function paymentStatusLabel(status: string): string {
  if (status === "approved") return "Approved for Payment";
  if (status === "review") return "Review Before Payment";
  return "Hold Payment";
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── PDF Generation ──────────────────────────────────────

export function generatePdfReport(data: ReportData): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
  });

  // Page counter
  let pageNumber = 1;
  const footer = () => {
    doc.fontSize(8).fillColor(COLORS.gray).text(
      `Page ${pageNumber} — Generated by ClearToPay Compliance on ${formatDate(data.report_date)}`,
      50,
      doc.page.height - 40,
      { align: "center", width: doc.page.width - 100 }
    );
    pageNumber++;
  };

  // Footer on first page
  footer();

  // ── Header ──
  doc
    .fontSize(22)
    .fillColor(COLORS.blue)
    .font("Helvetica-Bold")
    .text("Clear-to-Pay Report", { align: "left" });

  doc.moveDown(0.3);
  doc
    .fontSize(13)
    .fillColor(COLORS.dark)
    .font("Helvetica")
    .text(data.client_name);

  doc.moveDown(0.1);
  doc
    .fontSize(9)
    .fillColor(COLORS.gray)
    .text(`Report Date: ${formatDate(data.report_date)}`);

  doc
    .fontSize(9)
    .fillColor(COLORS.gray)
    .text(
      `Payment Week: ${formatDate(data.payment_week.monday)} – ${formatDate(data.payment_week.sunday)}`
    );

  doc.moveDown(0.8);

  // ── Section 1: Approved ──
  renderSection(
    doc,
    "1. Approved for Payment This Week",
    COLORS.green,
    data.approved,
    ["Vendor Name", "Contact", "Payment Status"],
    (v) => [
      v.vendor_name,
      v.contact_name || v.contact_email || "—",
      paymentStatusLabel(v.payment_status),
    ],
    COLORS.green
  );

  // ── Section 2: Review ──
  renderSection(
    doc,
    "2. Review Before Payment",
    COLORS.amber,
    data.review,
    ["Vendor Name", "Contact", "Payment Status", "Reason"],
    (v) => [
      v.vendor_name,
      v.contact_name || v.contact_email || "—",
      paymentStatusLabel(v.payment_status),
      v.reason || "—",
    ],
    COLORS.amber
  );

  // ── Section 3: Hold ──
  renderSection(
    doc,
    "3. Hold Payment",
    COLORS.red,
    data.hold,
    ["Vendor Name", "Contact", "Payment Status", "Reason"],
    (v) => [
      v.vendor_name,
      v.contact_name || v.contact_email || "—",
      paymentStatusLabel(v.payment_status),
      v.reason || "—",
    ],
    COLORS.red
  );

  // ── Section 4: Expiring During Payment Week ──
  renderSection(
    doc,
    "4. Expiring During Payment Week",
    COLORS.amber,
    data.expiring_during_week,
    ["Vendor Name", "Document Type", "Expiration Date"],
    (e) => [e.vendor_name, e.document_type, formatDate(e.expiration_date)],
    COLORS.amber
  );

  // ── Section 5: Missing Required Documents ──
  renderSection(
    doc,
    "5. Missing Required Documents",
    COLORS.red,
    data.missing_docs,
    ["Vendor Name", "Missing Document Types"],
    (m) => [m.vendor_name, m.missing_types.join(", ")],
    COLORS.red
  );

  // Finalize
  doc.end();
  return doc;
}

// ── Section Rendering Helper ─────────────────────────────

function renderSection<T>(
  doc: PDFKit.PDFDocument,
  title: string,
  color: string,
  rows: T[],
  headers: string[],
  rowMapper: (item: T) => string[],
  _accentColor: string
) {
  // Check if we need a new page (rough estimate: need ~120pt for header + first row)
  if (doc.y > doc.page.height - 140) {
    doc.addPage();
  }

  // Section heading
  doc.moveDown(0.5);
  doc
    .fontSize(12)
    .fillColor(color)
    .font("Helvetica-Bold")
    .text(title, { underline: false });

  doc.moveDown(0.3);

  if (rows.length === 0) {
    doc
      .fontSize(10)
      .fillColor(COLORS.gray)
      .font("Helvetica-Oblique")
      .text("No vendors in this category.");
    doc.moveDown(0.5);
    return;
  }

  // Column widths (approximate)
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = availableWidth / headers.length;

  // Table header
  const startX = doc.x;
  const headerY = doc.y;

  drawTableHeader(doc, headers, startX, headerY, colWidth, color);

  // Table rows
  doc.font("Helvetica").fontSize(9);
  let rowY = headerY + 22;
  const rowHeight = 20;

  for (const row of rows) {
    if (rowY > doc.page.height - 80) {
      doc.addPage();
      rowY = doc.page.margins.top + 10;
      // Redraw header on new page
      drawTableHeader(doc, headers, startX, rowY, colWidth, color);
      rowY += 22;
      doc.font("Helvetica").fontSize(9);
    }

    const cells = rowMapper(row);
    for (let i = 0; i < cells.length; i++) {
      doc.fillColor(COLORS.dark).text(
        cells[i],
        startX + i * colWidth + 4,
        rowY,
        {
          width: colWidth - 8,
          height: rowHeight,
          ellipsis: true,
          lineBreak: false,
        }
      );
    }

    // Row separator
    rowY += rowHeight;
    doc
      .moveTo(startX, rowY)
      .lineTo(startX + availableWidth, rowY)
      .strokeColor(COLORS.lightGray)
      .lineWidth(0.5)
      .stroke();
  }

  doc.y = rowY + 10;
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  headers: string[],
  startX: number,
  y: number,
  colWidth: number,
  color: string
) {
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Header background
  doc
    .rect(startX, y, availableWidth, 20)
    .fillColor(color)
    .fill();

  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.white);

  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], startX + i * colWidth + 4, y + 4, {
      width: colWidth - 8,
      height: 14,
      ellipsis: true,
      lineBreak: false,
    });
  }
}

// ── Excel Generation ────────────────────────────────────

export async function generateExcelReport(data: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ClearToPay Compliance";
  wb.created = new Date();

  // ── Summary Sheet ──
  const summarySheet = wb.addWorksheet("Summary");
  buildSummarySheet(summarySheet, data);

  // ── Approved Sheet ──
  buildVendorSheet(wb.addWorksheet("Approved"), data.approved, "Approved for Payment", COLORS.green, [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Contact Name", key: "contact_name", width: 22 },
    { header: "Contact Email", key: "contact_email", width: 28 },
    { header: "Payment Status", key: "payment_status", width: 22 },
  ]);

  // ── Review Sheet ──
  buildVendorSheet(wb.addWorksheet("Review"), data.review, "Review Before Payment", COLORS.amber, [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Contact Name", key: "contact_name", width: 22 },
    { header: "Contact Email", key: "contact_email", width: 28 },
    { header: "Payment Status", key: "payment_status", width: 22 },
    { header: "Reason", key: "reason", width: 40 },
  ]);

  // ── Hold Sheet ──
  buildVendorSheet(wb.addWorksheet("Hold"), data.hold, "Hold Payment", COLORS.red, [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Contact Name", key: "contact_name", width: 22 },
    { header: "Contact Email", key: "contact_email", width: 28 },
    { header: "Payment Status", key: "payment_status", width: 22 },
    { header: "Reason", key: "reason", width: 40 },
  ]);

  // ── Expiring Sheet ──
  buildExpiringSheet(wb.addWorksheet("Expiring"), data.expiring_during_week);

  // ── Missing Sheet ──
  buildMissingSheet(wb.addWorksheet("Missing"), data.missing_docs);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildSummarySheet(
  sheet: ExcelJS.Worksheet,
  data: ReportData
) {
  // Title
  sheet.mergeCells("A1:C1");
  const titleCell = sheet.getCell("A1");
  titleCell.value = "Clear-to-Pay Report";
  titleCell.font = { name: "Helvetica", size: 18, bold: true, color: { argb: "FF1a56db" } };

  sheet.mergeCells("A2:C2");
  sheet.getCell("A2").value = data.client_name;
  sheet.getCell("A2").font = { name: "Helvetica", size: 13, bold: true };

  sheet.mergeCells("A3:C3");
  sheet.getCell("A3").value = `Report Date: ${formatDate(data.report_date)}`;
  sheet.getCell("A3").font = { name: "Helvetica", size: 10, color: { argb: "FF6b7280" } };

  sheet.mergeCells("A4:C4");
  sheet.getCell("A4").value = `Payment Week: ${formatDate(data.payment_week.monday)} – ${formatDate(data.payment_week.sunday)}`;
  sheet.getCell("A4").font = { name: "Helvetica", size: 10, color: { argb: "FF6b7280" } };

  // Section counts
  const sections = [
    { label: "Approved for Payment", count: data.approved.length, color: COLORS.green },
    { label: "Review Before Payment", count: data.review.length, color: COLORS.amber },
    { label: "Hold Payment", count: data.hold.length, color: COLORS.red },
    { label: "Expiring During Payment Week", count: data.expiring_during_week.length, color: COLORS.amber },
    { label: "Missing Required Documents", count: data.missing_docs.length, color: COLORS.red },
  ];

  let row = 6;
  sheet.getCell(`A${row}`).value = "Section";
  sheet.getCell(`B${row}`).value = "Count";
  sheet.getCell(`A${row}`).font = { bold: true, size: 10 };
  sheet.getCell(`B${row}`).font = { bold: true, size: 10 };
  const headerRow = sheet.getRow(row);
  headerRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1a56db" } };
    c.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const s of sections) {
    row++;
    sheet.getCell(`A${row}`).value = s.label;
    sheet.getCell(`B${row}`).value = s.count;
    sheet.getCell(`B${row}`).font = { bold: true, color: { argb: s.color.replace("#", "FF") } };
  }

  sheet.getColumn("A").width = 35;
  sheet.getColumn("B").width = 12;
  sheet.getColumn("C").width = 20;
}

function buildVendorSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportVendor[],
  _title: string,
  color: string,
  columns: Array<{ header: string; key: string; width: number }>
) {
  sheet.columns = columns.map((c) => ({ ...c, key: c.key }));

  // Header styling
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: color.replace("#", "FF") },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  // Data rows
  for (const v of rows) {
    sheet.addRow({
      vendor_name: v.vendor_name,
      contact_name: v.contact_name || "",
      contact_email: v.contact_email || "",
      payment_status: paymentStatusLabel(v.payment_status),
      reason: v.reason || "",
    });
  }

  // If empty, show a note
  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No vendors in this category" });
  }
}

function buildExpiringSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportData["expiring_during_week"]
) {
  sheet.columns = [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Document Type", key: "document_type", width: 22 },
    { header: "Expiration Date", key: "expiration_date", width: 18 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFd97706" },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const e of rows) {
    sheet.addRow({
      vendor_name: e.vendor_name,
      document_type: e.document_type,
      expiration_date: e.expiration_date,
    });
  }

  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No documents expiring this week" });
  }
}

function buildMissingSheet(
  sheet: ExcelJS.Worksheet,
  rows: ReportData["missing_docs"]
) {
  sheet.columns = [
    { header: "Vendor Name", key: "vendor_name", width: 30 },
    { header: "Missing Document Types", key: "missing_types", width: 50 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFdc2626" },
    };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  });

  for (const m of rows) {
    sheet.addRow({
      vendor_name: m.vendor_name,
      missing_types: m.missing_types.join(", "),
    });
  }

  if (rows.length === 0) {
    sheet.addRow({ vendor_name: "No vendors have missing documents" });
  }
}
