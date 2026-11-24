#!/usr/bin/env node
/**
 * Temporal JSON snapshot of an entire mural.
 *
 *   node scripts/snapshot.mjs --board <workspace>.<id> [--out DIR] [--no-render] [--no-thumbnail] [--max-px 1600] [--quiet]
 *
 * Writes  <out>/mural/<muralId>/<UTC timestamp>/
 *   board.json      mural metadata (title, size, room, settings…)
 *   widgets.json    every widget, all pages, sorted by id
 *   tags.json       tags defined on the mural
 *   board.pdf       PDF export (current state, full resolution)
 *   render.png      PNG rasterized from the PDF (sips/pdftoppm) — the CURRENT picture of the board
 *   thumbnail-cached.png  Mural's cached thumbnail (stale: refreshed rarely by Mural; kept for reference)
 *   manifest.json   counts by type, hashes, source, diff vs previous snapshot
 * and updates <out>/mural/<muralId>/latest.json -> pointer to the newest snapshot.
 * Default <out> is ./.artifacts (relative to the current working directory).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadConfig } = await import(resolve(root, "build/config.js"));
const { MuralClient } = await import(resolve(root, "build/mural-client.js"));
const { renderMural } = await import(resolve(root, "build/render.js"));

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const board = flag("--board");
const out = resolve(flag("--out") ?? process.env.MURAL_SNAPSHOT_DIR ?? ".artifacts");
const wantThumb = !args.includes("--no-thumbnail");
const wantRender = !args.includes("--no-render");
const maxPx = Number(flag("--max-px") ?? 1600);
const quiet = args.includes("--quiet");
if (!board || board.startsWith("--")) { console.error("usage: snapshot.mjs --board <workspace>.<id> [--out DIR] [--no-thumbnail]"); process.exit(2); }
const log = (...a) => { if (!quiet) console.error(...a); };

const cfg = await loadConfig();
const client = new MuralClient(cfg);
const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z"); // 20261009T205501Z
const dir = resolve(out, "mural", board, stamp);
mkdirSync(dir, { recursive: true });

const hash = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const stable = (w) => { const { updatedOn, updatedBy, contentEditedOn, contentEditedBy, viewLink, ...rest } = w; return rest; };

log(`snapshot ${board} -> ${dir}`);
const mural = await client.getMural(board);
const { widgets, truncated } = await client.listAllWidgets(board, { pageSize: 100, maxPages: 500 });
widgets.sort((a, b) => String(a.id).localeCompare(String(b.id)));
let tags = [];
try { tags = (await client.listTags(board)).value ?? []; } catch (e) { log("tags unavailable:", e.message); }

writeFileSync(resolve(dir, "board.json"), JSON.stringify(mural, null, 2) + "\n");
writeFileSync(resolve(dir, "widgets.json"), JSON.stringify(widgets, null, 2) + "\n");
writeFileSync(resolve(dir, "tags.json"), JSON.stringify(tags, null, 2) + "\n");

let render = null;
if (wantRender) {
  try {
    log("exporting PDF and rendering (5-30 s)…");
    const r = await renderMural(client, board, { maxPx });
    writeFileSync(resolve(dir, "board.pdf"), r.pdf);
    render = { pdfBytes: r.pdf.length, pdfUrl: r.pdfUrl, png: null, warning: r.warning ?? null };
    if (r.png) { writeFileSync(resolve(dir, "render.png"), r.png); render.png = { file: "render.png", bytes: r.png.length, width: r.width, height: r.height, renderer: r.renderer }; }
    else log("render:", r.warning);
  } catch (e) { log("render failed:", e.message); render = { error: e.message }; }
}
let thumbnail = null;
if (wantThumb && mural.thumbnailUrl) {
  try { const r = await fetch(mural.thumbnailUrl); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); writeFileSync(resolve(dir, "thumbnail-cached.png"), b); thumbnail = { file: "thumbnail-cached.png", bytes: b.length, contentType: r.headers.get("content-type"), note: "Mural's cached thumbnail; refreshed rarely by Mural, likely STALE. Use render.png for the current state." }; } }
  catch (e) { log("thumbnail failed:", e.message); }
}

// ---- diff against the previous snapshot --------------------------------
const boardDir = resolve(out, "mural", board);
const prevStamps = readdirSync(boardDir).filter((d) => /^\d{8}T\d{6}Z$/.test(d) && d < stamp).sort();
let diff = null;
if (prevStamps.length) {
  const prevDir = resolve(boardDir, prevStamps.at(-1));
  try {
    const prev = JSON.parse(readFileSync(resolve(prevDir, "widgets.json"), "utf8"));
    const pm = new Map(prev.map((w) => [w.id, w])), cm = new Map(widgets.map((w) => [w.id, w]));
    const added = widgets.filter((w) => !pm.has(w.id)).map((w) => ({ id: w.id, type: w.type }));
    const removed = prev.filter((w) => !cm.has(w.id)).map((w) => ({ id: w.id, type: w.type }));
    const changed = widgets.filter((w) => pm.has(w.id) && hash(stable(pm.get(w.id))) !== hash(stable(w))).map((w) => {
      const p = pm.get(w.id); const fields = Object.keys({ ...p, ...w }).filter((k) => !["updatedOn", "updatedBy", "contentEditedOn", "contentEditedBy", "viewLink"].includes(k) && JSON.stringify(p[k]) !== JSON.stringify(w[k]));
      return { id: w.id, type: w.type, fields };
    });
    diff = { previous: prevStamps.at(-1), added, removed, changed };
  } catch (e) { log("diff skipped:", e.message); }
}

const byType = widgets.reduce((acc, w) => ((acc[w.type ?? "unknown"] = (acc[w.type ?? "unknown"] ?? 0) + 1), acc), {});
const manifest = {
  muralId: board, title: mural.title, takenAt: new Date().toISOString(), stamp, dir,
  board: { width: mural.width, height: mural.height, workspaceId: mural.workspaceId, roomId: mural.roomId, updatedOn: mural.updatedOn },
  widgets: { count: widgets.length, byType, truncated, hash: hash(widgets.map(stable)) },
  tags: tags.length, render, thumbnail,
  files: ["board.json", "widgets.json", "tags.json", ...(render?.pdfBytes ? ["board.pdf"] : []), ...(render?.png ? ["render.png"] : []), ...(thumbnail ? ["thumbnail-cached.png"] : []), "manifest.json"],
  source: { apiBaseUrl: cfg.apiBaseUrl, envFile: cfg.envFile ?? null }, diff,
};
writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(resolve(boardDir, "latest.json"), JSON.stringify({ stamp, dir, takenAt: manifest.takenAt, widgets: widgets.length, hash: manifest.widgets.hash }, null, 2) + "\n");

const summary = `${widgets.length} widget(s)${render?.png ? ` | render ${render.png.width}x${render.png.height}` : render ? " | no render" : ""} [${Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(", ")}]${diff ? ` | vs ${diff.previous}: +${diff.added.length} −${diff.removed.length} ~${diff.changed.length}` : " | first snapshot"}`;
console.log(JSON.stringify({ dir, stamp, summary, hash: manifest.widgets.hash }));
log(summary);
