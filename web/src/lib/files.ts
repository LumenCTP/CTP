import { apiFetch } from "./api";

/**
 * Auth-protected file helpers. The API authenticates via the Authorization
 * header only, so browser-native navigation (<a href>, <img src>, window.open)
 * cannot fetch API files — they 401. These helpers fetch with the Bearer token,
 * then hand the result to the browser as a Blob object URL.
 */

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = header.match(/filename="?([^";]+)"?/i);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

/** Fetch a file with auth and trigger a browser download of it. */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition"), fallbackName);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** Fetch a file with auth and open it in a new tab (PDFs, images). */
export async function openFileInNewTab(url: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load file (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const win = window.open(objectUrl, "_blank", "noopener");
  // If popups are blocked, fall back to a download so the user still gets the file.
  if (!win) {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filenameFromDisposition(res.headers.get("Content-Disposition"), fallbackName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  // The new tab fetches the blob immediately; give it time before revoking.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** Fetch a file with auth and return an object URL. Caller must revoke it. */
export async function fetchFileObjectUrl(url: string): Promise<string> {
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load file (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
