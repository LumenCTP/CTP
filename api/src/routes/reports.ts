import { Hono } from "hono";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { getDb } from "../db";
import { gatherReportData, generatePdfReport, generateExcelReport } from "../reports";

const app = new Hono();

// ── Reports ─────────────────────────────────────────────

// POST /api/reports/clear-to-pay — generate Clear-to-Pay report
app.post("/api/reports/clear-to-pay", async (c) => {
  try {
    const body = await c.req.json();
    const clientId = body.client_id ? Number(body.client_id) : undefined;
    const format = body.format || "both"; // "pdf" | "excel" | "csv" | "both"

    if (!clientId || isNaN(clientId)) {
      return c.json({ error: "Valid client_id is required" }, 400);
    }

    // Verify client exists
    const db = getDb();
    const client = db
      .query("SELECT id, name FROM clients WHERE id = $id AND tenant_id = $tenant_id")
      .get({ $id: clientId, $tenant_id: c.get("tenant_id") as number }) as { id: number; name: string } | undefined;

    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    // Gather report data (recalculates compliance first)
    const reportData = gatherReportData(clientId);

    const timestamp = Date.now();
    const clientSlug = client.name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
    const reportsDir = path.join(import.meta.dir, "..", "..", "data", "reports");
    if (!existsSync(reportsDir)) {
      mkdirSync(reportsDir, { recursive: true });
    }

    if (format === "pdf") {
      const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
      const pdfPath = path.join(reportsDir, pdfFilename);

      const doc = generatePdfReport(reportData);
      const buffers: Buffer[] = [];
      for await (const chunk of doc) {
        buffers.push(Buffer.from(chunk));
      }
      const pdfBuffer = Buffer.concat(buffers);
      Bun.write(pdfPath, pdfBuffer);

      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdfFilename}"`,
        },
      });
    }

    if (format === "csv") {
      const csvFilename = `ClearToPay_${clientSlug}_${timestamp}.csv`;
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows: string[] = ["Section,Vendor,Contact,Status,Reason,Document,Expiration,Missing Documents"];
      const addVendor = (section: string, v: any) => rows.push([section, v.vendor_name, v.contact_email || v.contact_name || "", v.payment_status, v.reason || "", "", "", ""].map(esc).join(","));
      reportData.approved.forEach(v => addVendor("Approved", v));
      reportData.review.forEach(v => addVendor("Review", v));
      reportData.hold.forEach(v => addVendor("Hold", v));
      reportData.expiring_during_week.forEach(e => rows.push(["Expiring", e.vendor_name, "", "", "", e.document_type, e.expiration_date, ""].map(esc).join(",")));
      reportData.missing_docs.forEach(m => rows.push(["Missing", m.vendor_name, "", "", "", "", "", m.missing_types.join("; ")].map(esc).join(",")));
      const csv = Buffer.from(rows.join("\r\n") + "\r\n", "utf8");
      Bun.write(path.join(reportsDir, csvFilename), csv);
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvFilename}"` } });
    }

    if (format === "excel") {
      const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
      const xlsxPath = path.join(reportsDir, xlsxFilename);

      const xlsxBuffer = await generateExcelReport(reportData);
      Bun.write(xlsxPath, xlsxBuffer);

      return new Response(xlsxBuffer, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${xlsxFilename}"`,
        },
      });
    }

    // "both" — generate both, but we can only return one. Return a summary JSON
    // with download URLs for both files.
    const pdfFilename = `ClearToPay_${clientSlug}_${timestamp}.pdf`;
    const pdfPath = path.join(reportsDir, pdfFilename);

    const doc = generatePdfReport(reportData);
    const pdfBuffers: Buffer[] = [];
    for await (const chunk of doc) {
      pdfBuffers.push(Buffer.from(chunk));
    }
    Bun.write(pdfPath, Buffer.concat(pdfBuffers));

    const xlsxFilename = `ClearToPay_${clientSlug}_${timestamp}.xlsx`;
    const xlsxPath = path.join(reportsDir, xlsxFilename);
    const xlsxBuffer = await generateExcelReport(reportData);
    Bun.write(xlsxPath, xlsxBuffer);

    // Return summary with download URLs
    return c.json({
      pdf_url: `/api/reports/download/${encodeURIComponent(pdfFilename)}`,
      excel_url: `/api/reports/download/${encodeURIComponent(xlsxFilename)}`,
      summary: {
        client_name: reportData.client_name,
        report_date: reportData.report_date,
        payment_week: reportData.payment_week,
        approved_count: reportData.approved.length,
        review_count: reportData.review.length,
        hold_count: reportData.hold.length,
        expiring_count: reportData.expiring_during_week.length,
        missing_count: reportData.missing_docs.length,
      },
    });
  } catch (err) {
    console.error("[reports] Error generating report:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/reports/download/:filename — download a generated report file
app.get("/api/reports/download/:filename", (c) => {
  try {
    const filename = decodeURIComponent(c.req.param("filename"));
    const reportsDir = path.join(import.meta.dir, "..", "..", "data", "reports");
    const filePath = path.join(reportsDir, filename);

    // Security: prevent directory traversal
    if (!filePath.startsWith(reportsDir)) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    if (!existsSync(filePath)) {
      return c.json({ error: "Report file not found" }, 404);
    }

    const ext = path.extname(filename).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".pdf") contentType = "application/pdf";
    else if (ext === ".xlsx")
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
