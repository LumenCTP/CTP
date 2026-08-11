/**
 * PDF → PNG page rendering for the AI document extraction pipeline.
 *
 * Uses pdfjs-dist (legacy build) to parse the PDF and @napi-rs/canvas to
 * rasterize pages. Both run in Bun with zero system dependencies (no
 * ghostscript, poppler-utils, or ImageMagick required on the host).
 *
 * Both packages are lazy-imported so that if the renderer can't be loaded
 * (missing package, incompatible platform) this module degrades to returning
 * an empty array — the caller (extract.ts) then falls back to the HONEST
 * filename-only result instead of crashing ingestion.
 */
import path from "node:path";

const PDFJS_DIR = path.join(import.meta.dir, "..", "node_modules", "pdfjs-dist");
const WORKER_SRC = `file://${path.join(PDFJS_DIR, "legacy", "build", "pdf.worker.mjs")}`;
const STANDARD_FONTS_URL = `file://${path.join(PDFJS_DIR, "standard_fonts")}/`;
const CMAP_URL = `file://${path.join(PDFJS_DIR, "cmaps")}/`;

/** Render scale — ~918px wide for US Letter, plenty for vision models. */
const RENDER_SCALE = 1.5;
/** Skip renders that are degenerate (e.g. corrupted pages). */
const MIN_DIMENSION = 200;
/** Ignore renders whose PNG is trivially small (blank/corrupt). */
const MIN_PNG_BYTES = 2000;

/**
 * Renders up to `maxPages` pages of the PDF at `filePath` to PNG buffers.
 * Returns an empty array when the renderer is unavailable or the PDF cannot
 * be opened/rendered. Never throws.
 */
export async function renderPdfPagesToPngs(
  filePath: string,
  maxPages: number,
): Promise<Buffer[]> {
  let data: ArrayBuffer;
  try {
    data = await Bun.file(filePath).arrayBuffer();
  } catch {
    return [];
  }
  return renderPdfPagesFromBuffer(new Uint8Array(data), maxPages);
}

/**
 * Same as renderPdfPagesToPngs but takes the PDF bytes directly — used when
 * the file lives in object storage (R2) rather than on local disk.
 */
export async function renderPdfPagesFromBuffer(
  pdfBytes: Uint8Array | Buffer,
  maxPages: number,
): Promise<Buffer[]> {
  let pdfjsLib: any;
  let createCanvas: ((w: number, h: number) => any) | undefined;
  try {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const canvasMod: any = await import("@napi-rs/canvas");
    createCanvas = canvasMod.createCanvas;
  } catch (err) {
    console.warn(
      `[pdf-render] PDF renderer unavailable (${err instanceof Error ? err.message : err}) — PDF will use honest filename fallback`,
    );
    return [];
  }
  if (!createCanvas) return [];

  const pages: Buffer[] = [];
  let pdf: any;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
    const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    const doc = await pdfjsLib
      .getDocument({
        data: new Uint8Array(data),
        standardFontDataUrl: STANDARD_FONTS_URL,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        isEvalSupported: false,
      })
      .promise;
    pdf = doc;

    const pageCount = Math.min(doc.numPages ?? 1, Math.max(1, maxPages));
    for (let i = 1; i <= pageCount; i++) {
      try {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const w = Math.max(1, Math.ceil(viewport.width));
        const h = Math.max(1, Math.ceil(viewport.height));
        if (w < MIN_DIMENSION || h < MIN_DIMENSION) {
          console.warn(`[pdf-render] page ${i} has degenerate size ${w}x${h} — skipping`);
          continue;
        }
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext("2d");
        await page
          .render({
            canvasContext: ctx,
            viewport,
            canvasFactory: {
              create: (cw: number, ch: number) => {
                const c = createCanvas(cw, ch);
                return { canvas: c, context: c.getContext("2d") };
              },
            },
          })
          .promise;
        const png = canvas.toBuffer("image/png");
        if (png.length > MIN_PNG_BYTES) {
          pages.push(png);
        } else {
          console.warn(`[pdf-render] page ${i} produced a blank/tiny PNG (${png.length} bytes) — skipping`);
        }
        try {
          page.cleanup();
        } catch {
          /* ignore */
        }
      } catch (err) {
        console.warn(
          `[pdf-render] page ${i} render failed (${err instanceof Error ? err.message : err}) — skipping`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[pdf-render] cannot open ${filePath} (${err instanceof Error ? err.message : err})`,
    );
  } finally {
    try {
      pdf?.destroy();
    } catch {
      /* ignore */
    }
  }
  return pages;
}
