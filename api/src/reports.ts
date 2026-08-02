// Stub: heavy deps (pdfkit, exceljs) not available in this environment.
// Full implementation preserved in reports.ts.bak

export interface ReportVendor {
  vendor_id: number;
  vendor_name: string;
  client_id: number;
  client_name: string;
  compliance_status: string;
  payment_status: string;
  missing_docs: string[];
  expiring_docs: string[];
  has_expiring_this_week: boolean;
  documents: Array<{
    document_type: string;
    policy_number: string | null;
    expiration_date: string | null;
    is_reviewed: boolean;
  }>;
}

export interface ReportData {
  client_id: number;
  client_name: string;
  report_date: string;
  payment_week: { monday: string; sunday: string };
  approved: ReportVendor[];
  review: ReportVendor[];
  hold: ReportVendor[];
  expiring_during_week: ReportVendor[];
  missing_docs: ReportVendor[];
}

export function gatherReportData(clientId: number): ReportData {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    client_id: clientId,
    client_name: "Unknown",
    report_date: now.toISOString().slice(0, 10),
    payment_week: {
      monday: monday.toISOString().slice(0, 10),
      sunday: sunday.toISOString().slice(0, 10),
    },
    approved: [],
    review: [],
    hold: [],
    expiring_during_week: [],
    missing_docs: [],
  };
}

export function generatePdfReport(_data: ReportData): any {
  throw new Error("PDF generation unavailable — pdfkit not installed");
}

export async function generateExcelReport(_data: ReportData): Promise<Buffer> {
  throw new Error("Excel generation unavailable — exceljs not installed");
}
