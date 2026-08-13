const TOKEN_KEY = "cleartopay_token";

/**
 * Authenticated fetch wrapper for API requests.
 *
 * Handles two global auth states:
 * - 401 → token invalid/expired: clear the session and send the user to login.
 * - 402 with error "subscription_required" → the tenant is PENDING/PAST_DUE:
 *   send the user to /app, where the app shell renders the paywall.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init?.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // JSON is the default for requests with a body. Callers can override it
  // (for example, multipart uploads must let the browser set Content-Type).
  if (
    init?.body &&
    !(typeof FormData !== "undefined" && init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("cleartopay_user");
    window.location.href = "/app/login";
  }

  if (res.status === 402) {
    try {
      const data = await res.clone().json();
      if (data?.error === "subscription_required") {
        // Non-ACTIVE tenant hit a data route — the paywall (rendered by the app
        // shell from /me) is the destination. Redirecting here is a fallback
        // for any fetch that slipped past the shell gate.
        window.location.href = "/app";
      }
    } catch {
      // Non-JSON 402 — leave it for the caller to handle.
    }
  }

  return res;
}
