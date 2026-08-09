// ── Enums ──────────────────────────────────────────────

export type ComplianceStatus = "compliant" | "expiring_soon" | "expired" | "needs_review";
export type PaymentStatus = "approved" | "review" | "hold";
export type DocumentType = "COI" | "W-9" | "Workers Comp" | "Commercial Auto" | "General Liability" | "Umbrella" | "Business License" | "Other";

export const ALL_DOCUMENT_TYPES: DocumentType[] = [
  "COI", "W-9", "Workers Comp", "Commercial Auto", "General Liability", "Umbrella", "Business License", "Other"
];
export type EntityType = "document" | "vendor" | "client";

// ── Client ────────────────────────────────────────────

export interface Client {
  id: number;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientRequiredDocument {
  id: number;
  client_id: number;
  document_type: DocumentType;
  created_at: string;
}

export interface ClientWithRequiredDocs extends Client {
  required_documents: DocumentType[];
}

// ── Vendor ────────────────────────────────────────────

export interface Vendor {
  id: number;
  client_id: number;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  updated_at: string;
}

// ── Document ──────────────────────────────────────────

export interface Document {
  id: number;
  vendor_id: number | null;
  client_id: number | null;
  document_type: DocumentType;
  file_path: string;
  original_filename: string;
  content_type: string | null;
  file_size: number | null;
  sender_name: string | null;
  sender_email: string | null;
  received_date: string;
  created_at: string;
}

export interface DocumentExtraction {
  id: number;
  document_id: number;
  vendor_name: string | null;
  insurance_carrier: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  certificate_holder: string | null;
  document_type: string | null;
  ai_confidence_score: number;
  is_reviewed: boolean;
  extracted_at: string;
}

// ── Compliance ────────────────────────────────────────

export interface ComplianceRecord {
  id: number;
  vendor_id: number;
  client_id: number;
  status: ComplianceStatus;
  payment_status: PaymentStatus;
  calculated_at: string;
}

// ── Audit ─────────────────────────────────────────────

export interface AuditLog {
  id: number;
  entity_type: EntityType;
  entity_id: number;
  action: string;
  changes: Record<string, unknown> | null;
  performed_by: string | null;
  created_at: string;
}

// ── API ───────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  db: string;
}

// ── Vendor API ────────────────────────────────────────

export interface VendorListItem {
  id: number;
  client_id: number;
  client_name: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  compliance_status: ComplianceStatus;
  payment_status: PaymentStatus;
  created_at: string;
  updated_at: string;
}

export interface VendorDetail extends VendorListItem {
  document_count: number;
  latest_extraction_date: string | null;
}

export interface VendorCreateBody {
  client_id: number;
  name: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}

// ── Document API ──────────────────────────────────────

export type IngestionStatus = "uploaded" | "processing" | "ready" | "error";

export interface DocumentListItem {
  id: number;
  vendor_id: number | null;
  client_id: number | null;
  vendor_name: string | null;
  client_name: string | null;
  document_type: DocumentType;
  file_path: string;
  original_filename: string;
  content_type: string | null;
  file_size: number | null;
  sender_name: string | null;
  sender_email: string | null;
  received_date: string;
  created_at: string;
  ingestion_status: IngestionStatus;
  ai_confidence_score: number | null;
  is_reviewed: boolean;
  insurance_carrier: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  certificate_holder: string | null;
  extracted_document_type: string | null;
}

export interface DocumentDetail extends DocumentListItem {
  extractions: DocumentExtraction[];
}

export interface ExtractionUpdateBody {
  vendor_name?: string | null;
  insurance_carrier?: string | null;
  policy_number?: string | null;
  effective_date?: string | null;
  expiration_date?: string | null;
  certificate_holder?: string | null;
  document_type?: string | null;
  is_reviewed?: boolean;
}

export interface DocumentUploadResponse {
  document: {
    id: number;
    original_filename: string;
    content_type: string;
    file_size: number;
  };
  ingestion_status: IngestionStatus;
}

// ── Dashboard ─────────────────────────────────────────

export interface DashboardStats {
  total_clients: number;
  total_vendors: number;
  vendors_approved: number;
  vendors_review: number;
  vendors_hold: number;
  vendors_on_hold: number; // kept for backward compat
  expiring_this_week: number;
  needs_review: number;
}

// ── Compliance Detail ──────────────────────────────────

export interface CompliancePerTypeDetail {
  document_type: string;
  status: ComplianceStatus | "missing";
  document_id: number | null;
  expiration_date: string | null;
  is_reviewed: boolean;
  has_unreviewed: boolean;
}

export interface ComplianceDetailResponse {
  vendor_id: number;
  client_id: number;
  vendor_name: string;
  client_name: string;
  status: ComplianceStatus;
  payment_status: PaymentStatus;
  details: CompliancePerTypeDetail[];
}

export interface RecalculateSummary {
  vendor_count: number;
  approved: number;
  review: number;
  hold: number;
}

// ── Email Config ──────────────────────────────────────

export interface ClientEmailConfig {
  id: number;
  client_id: number;
  weekly_report_recipients: string | null;
  monthly_report_recipients: string | null;
  renewal_reminders_enabled: number;
  created_at: string;
  updated_at: string;
}

export type EmailType = "weekly_report" | "monthly_report" | "renewal_reminder";
export type EmailStatus = "sent" | "error";

export interface EmailLog {
  id: number;
  client_id: number | null;
  vendor_id: number | null;
  email_type: EmailType;
  recipient_email: string;
  subject: string;
  sent_at: string;
  status: EmailStatus;
  error_message: string | null;
}

export interface Tenant {
  id: number;
  name: string;
  inbox_slug: string | null;
  subscription_status: string;
}

// ── Users & Roles ────────────────────────────────────

export type UserRole = "user" | "partner" | "admin";

export interface User {
  id: number;
  full_name: string;
  company_name: string;
  email: string;
  role: UserRole;
  tenant_id: number | null;
  created_at: string;
}

// ── Partner Program ──────────────────────────────────

export type PartnerStatus = "pending" | "approved" | "suspended" | "rejected" | "terminated";

export interface Partner {
  id: number;
  user_id: number | null;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  website: string | null;
  states_served: string | null;
  partner_type: string;
  tax_info_status: string;
  preferred_payout_method: string | null;
  status: PartnerStatus;
  referral_code: string | null;
  commission_percentage: number;
  created_at: string;
  updated_at: string;
}

export type ReferralCustomerStatus = "lead" | "trial" | "active" | "past_due" | "cancelled" | "refunded";

export interface Referral {
  id: number;
  partner_id: number;
  partner_code: string;
  referred_company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  referral_date: string;
  signup_date: string | null;
  subscription_start_date: string | null;
  subscription_plan: string | null;
  subscription_amount: number | null;
  customer_status: ReferralCustomerStatus;
  tenant_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type CommissionStatus = "pending" | "approved" | "scheduled" | "paid" | "reversed" | "disputed";

export interface Commission {
  id: number;
  partner_id: number;
  referral_id: number | null;
  tenant_id: number | null;
  billing_period: string | null;
  eligible_revenue: number;
  commission_percentage: number;
  commission_amount: number;
  earned_date: string;
  status: CommissionStatus;
  payout_id: number | null;
  created_at: string;
}

export interface Payout {
  id: number;
  partner_id: number;
  amount: number;
  status: "pending" | "paid" | "cancelled";
  payment_date: string | null;
  payment_method: string | null;
  transaction_ref: string | null;
  notes: string | null;
  created_at: string;
}

export interface PartnerDashboardStats {
  referral_code: string | null;
  referral_link: string | null;
  total_referrals: number;
  active_customers: number;
  pending_referrals: number;
  cancelled_customers: number;
  current_month_earnings: number;
  pending_commission: number;
  approved_commission: number;
  paid_commission: number;
  lifetime_earnings: number;
  next_expected_payout: number;
}

export interface PartnerListItem {
  id: number;
  full_name: string;
  company_name: string | null;
  email: string;
  partner_type: string;
  status: PartnerStatus;
  referral_code: string | null;
  total_referrals: number;
  created_at: string;
}
