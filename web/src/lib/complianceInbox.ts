// The single branded compliance inbox every tenant shares.
//
// /api/auth/me returns the address as `user.inbox_address`; this constant is
// only a fallback so onboarding guidance ("email your vendor list / your
// vendors' documents here") is never rendered blank if that field is missing
// or hasn't loaded yet.
export const COMPLIANCE_INBOX = "documents@cleartopayconstruction.com";

export function inboxAddress(user?: { inbox_address?: string | null } | null): string {
  const addr = user?.inbox_address?.trim();
  return addr && addr.length > 0 ? addr : COMPLIANCE_INBOX;
}
