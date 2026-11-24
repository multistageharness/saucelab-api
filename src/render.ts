/**
 * Current-state rendering of a mural.
 *
 * Mural's `thumbnailUrl` is a cached image that is refreshed rarely (same bytes
 * for hours while the board changed), so it must not be presented as "now".
 * The PDF export IS current. We export, then rasterize the PDF to PNG with
 * whatever is available locally:
 *   - macOS: `sips` (built in)           - Linux: `pdftoppm` (poppler-utils)
 * If neither exists we still return the PDF and fall back to the cached
 * thumbnail, labelled as stale.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuralClient } from "./mural-client.js";

export interface RenderResult {
  pdf: Buffer;
  pdfUrl: string;
  png?: Buffer;
  renderer?: "sips" | "pdftoppm";
  width?: number;
  height?: number;
  warning?: string;
}

function which(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

/** Export the mural as PDF, polling until ready (404 while rendering). */
export async function exportPdf(client: MuralClient, muralId: string, waitMs = 90_000): Promise<{ url: string; pdf: Buffer; exportId: string }> {
  const { exportId } = await client.startExport(muralId, "pdf");
  const deadline = Date.now() + waitMs;
  let url: string | undefined;
  while (Date.now() < deadline) {
    try { const s = await client.getExport(muralId, exportId); if (typeof s.url === "string") { url = s.url; break; } }
    catch (e) { if (!(e as { status?: number }).status || (e as { status?: number }).status !== 404) throw e; }
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (!url) throw new Error(`PDF export ${exportId} not ready after ${Math.round(waitMs / 1000)}s`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download of export failed: HTTP ${res.status}`);
  return { url, pdf: Buffer.from(await res.arrayBuffer()), exportId };
}

/** Rasterize the first page of a PDF to PNG. `maxPx` bounds the longest side (0 = native). */
export function pdfToPng(pdf: Buffer, maxPx = 1600): { png: Buffer; renderer: "sips" | "pdftoppm"; width: number; height: number } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "mural-render-"));
  try {
    const src = join(dir, "board.pdf"), out = join(dir, "board.png");
    writeFileSync(src, pdf);
    let renderer: "sips" | "pdftoppm" | undefined;
    if (which("sips")) {
      const args = ["-s", "format", "png", ...(maxPx > 0 ? ["-Z", String(maxPx)] : []), src, "--out", out];
      if (spawnSync("sips", args, { stdio: "ignore" }).status === 0 && existsSync(out)) renderer = "sips";
    }
    if (!renderer && which("pdftoppm")) {
      const args = ["-png", "-singlefile", "-f", "1", "-l", "1", ...(maxPx > 0 ? ["-scale-to", String(maxPx)] : ["-r", "150"]), src, join(dir, "board")];
      if (spawnSync("pdftoppm", args, { stdio: "ignore" }).status === 0 && existsSync(out)) renderer = "pdftoppm";
    }
    if (!renderer) return undefined;
    const png = readFileSync(out);
    // PNG IHDR: width/height at bytes 16..24
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    return { png, renderer, width, height };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Full pipeline: export -> rasterize. Never throws on rasterizer absence; `warning` explains. */
export async function renderMural(client: MuralClient, muralId: string, opts: { maxPx?: number; waitMs?: number } = {}): Promise<RenderResult> {
  const { url, pdf } = await exportPdf(client, muralId, opts.waitMs);
  const r = pdfToPng(pdf, opts.maxPx ?? 1600);
  if (!r) return { pdf, pdfUrl: url, warning: "No PDF rasterizer found (need `sips` on macOS or `pdftoppm` from poppler-utils); returning PDF only." };
  return { pdf, pdfUrl: url, png: r.png, renderer: r.renderer, width: r.width, height: r.height };
}
