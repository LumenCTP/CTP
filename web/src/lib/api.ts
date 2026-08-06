const TOKEN_KEY = "cleartopay_token";

/** Authenticated fetch wrapper for API requests. */
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

  return res;
}
