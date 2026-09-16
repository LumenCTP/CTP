import { useCallback, useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "error";

interface CopyButtonProps {
  /** Text placed on the clipboard (code, link, …). */
  text: string;
  /** Idle label, e.g. "Copy Code" / "Copy Link". */
  label?: string;
  className?: string;
}

/**
 * Copies `text` to the clipboard and shows feedback.
 *
 * Primary path: the async Clipboard API (navigator.clipboard.writeText). Some
 * browsers only allow that in a secure context and/or with a user gesture, so
 * if it throws (or isn't available) we fall back to a hidden textarea plus
 * document.execCommand("copy"). The button reads "Copied!" for two seconds,
 * or "Copy failed" if neither path worked — the caller is expected to render
 * the copied text in a selectable element so it can still be copied by hand.
 */
export default function CopyButton({
  text,
  label = "Copy",
  className = "btn btn-outline btn-sm copy-btn",
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  // Clear any pending "state reset" timeout if the button unmounts.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    let ok = false;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false; // fall through to the legacy path
    }

    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }

    setState(ok ? "copied" : "error");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }, [text]);

  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      title={state === "error" ? "Copying failed — select the text and copy it manually." : undefined}
    >
      {state === "copied" ? "Copied!" : state === "error" ? "Copy failed" : label}
    </button>
  );
}
