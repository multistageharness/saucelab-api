#!/usr/bin/env node
/**
 * End-to-end smoke test: boots build/index.js over stdio against a local mock
 * of the Mural Public API and exercises every tool. No real credentials needed.
 *
 *   npm run build && npm run smoke
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "build/index.js");
const EXPECTED_TOOLS = [
  "mural_list_workspaces", "mural_get_board", "mural_get_widgets", "mural_create_sticky_note", "mural_update_widget",
  "mural_create_shape", "mural_create_textbox", "mural_create_title", "mural_create_arrow", "mural_create_area",
  "mural_delete_widget", "mural_create_widgets_raw",
  "mural_list_rooms", "mural_list_murals", "mural_create_board", "mural_duplicate_board", "mural_update_board",
  "mural_snapshot", "mural_export_pdf", "mural_list_tags", "mural_create_tag", "mural_get_widget",
  "mural_create_image", "mural_create_file", "mural_create_comment", "mural_draw", "mural_create_table",
];
const TOKEN = "smoke-token";
const NEW_TOKEN = "refreshed-token";
const NEW_REFRESH = "smoke-refresh-2";
const seen = [];
let acceptedToken = TOKEN;

// ---- mock Mural API --------------------------------------------------------
const api = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

  const send = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const p0 = url.pathname;
  if (!p0.includes("/oauth2/") && body && !body.trim().startsWith("[") && !body.trim().startsWith("{")) return send(400, { message: `mock: non-JSON body on ${p0}` });
  if (req.method === "POST" && p0 === "/api/public/v1/authorization/oauth2/token") {
    const form = Object.fromEntries(new URLSearchParams(body));
    if (form.grant_type === "refresh_token" && form.refresh_token === "smoke-refresh" && form.client_id === "cid" && form.client_secret === "sec" && !("scope" in form)) {
      acceptedToken = NEW_TOKEN;
      return send(200, { access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 900 });
    }
    return send(400, { message: "invalid refresh request" });
  }
  if (req.headers.authorization !== `Bearer ${acceptedToken}`) return send(401, { code: "UNAUTHORIZED", message: "bad token" });

  const p = url.pathname;
  if (req.method === "GET" && p === "/api/public/v1/workspaces")
    return send(200, { value: [{ id: "ws1", name: "Workspace One" }], next: url.searchParams.get("next") ? undefined : "page2" });
  if (req.method === "GET" && p === "/api/public/v1/murals/ws1.100")
    return send(200, { value: { id: "ws1.100", title: "Smoke Board", width: 9000, height: 6000, workspaceId: "ws1" } });
  if (req.method === "GET" && p === "/api/public/v1/murals/ws1.100/widgets") {
    const next = url.searchParams.get("next");
    return next
      ? send(200, { value: [{ id: "w2", type: "text", x: 10, y: 10 }] })
      : send(200, { value: [{ id: "w1", type: "sticky note", x: 0, y: 0 }], next: "p2" });
  }
  if (req.method === "GET" && p === "/api/public/v1/murals/ws1.100/widgets/w1")
    return send(200, { value: { id: "w1", type: "sticky note" } });
  if (req.method === "POST" && p === "/api/public/v1/murals/ws1.100/widgets/sticky-note") {
    const notes = JSON.parse(body);
    return send(201, { value: notes.map((n, i) => ({ id: `new${i}`, type: "sticky note", ...n })) });
  }
  const m = p.match(/^\/api\/public\/v1\/murals\/ws1\.100\/widgets\/(shape|textbox|title)$/);
  if (req.method === "POST" && m) { const items = JSON.parse(body); return send(201, { value: items.map((n, i) => ({ id: `${m[1]}${i}`, type: m[1], ...n })) }); }
  if (req.method === "POST" && p === "/api/public/v1/murals/ws1.100/widgets/area") { const o = JSON.parse(body); return send(201, { value: { id: "area0", type: "area", ...o } }); }
  if (req.method === "POST" && p === "/api/public/v1/murals/ws1.100/widgets/arrow") { const o = JSON.parse(body); return send(201, { value: { id: "arrow0", type: "arrow", ...o } }); }
  if (req.method === "DELETE" && p === "/api/public/v1/murals/ws1.100/widgets/w1") { res.writeHead(204); return res.end(); }
  if (req.method === "PATCH" && p === "/api/public/v1/murals/ws1.100/widgets/sticky-note/w1")
    return send(200, { value: { id: "w1", type: "sticky note", ...JSON.parse(body) } });
  if (req.method === "GET" && p === "/api/public/v1/murals/missing")
    return send(404, { code: "NOT_FOUND", message: "mural not found" });
  return send(500, { message: `unexpected ${req.method} ${p}` });
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const base = `http://127.0.0.1:${api.address().port}/api/public/v1`;

// ---- MCP client over stdio --------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, MURAL_ACCESS_TOKEN: TOKEN, MURAL_API_BASE_URL: base, MURAL_ENV_FILE: "/nonexistent/.env", MURAL_SECRETS_BACKEND: "env" },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
let failures = 0;
const check = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), `tools/list exposes all ${EXPECTED_TOOLS.length} tools`, names.join(","));

  const call = (name, args) => client.callTool({ name, arguments: args });
  const text = (r) => r.content.map((c) => c.text).join("\n");

  let r = await call("mural_list_workspaces", { limit: 10 });
  check(!r.isError && text(r).includes("Workspace One"), "mural_list_workspaces returns workspaces");

  r = await call("mural_get_board", { muralId: "ws1.100" });
  check(!r.isError && text(r).includes("9000x6000px"), "mural_get_board reports dimensions");

  r = await call("mural_get_widgets", { muralId: "ws1.100" });
  check(!r.isError && text(r).includes("2 widget(s)") && text(r).includes('"w2"'), "mural_get_widgets auto-paginates", text(r).split("\n")[0]);

  r = await call("mural_create_sticky_note", { muralId: "ws1.100", x: 200, y: 300, text: "smoke", color: "yellow", shape: "rectangle" });
  const post = seen.find((s) => s.method === "POST");
  const sent = post ? JSON.parse(post.body) : null;
  check(
    !r.isError && Array.isArray(sent) && sent[0].x === 200 && sent[0].y === 300 && sent[0].shape === "rectangle" && sent[0].style.backgroundColor === "#FCFE7DFF",
    "mural_create_sticky_note posts array body with normalised colour",
    post?.body,
  );

  r = await call("mural_update_widget", { muralId: "ws1.100", widgetId: "w1", text: "Updated", x: 50 });
  const patch = seen.find((s) => s.method === "PATCH");
  check(!r.isError && patch && patch.path.endsWith("/widgets/sticky-note/w1") && JSON.parse(patch.body).text === "Updated", "mural_update_widget resolves type -> sticky-note path", patch?.body);

  r = await call("mural_update_widget", { muralId: "ws1.100", widgetId: "w1" });
  check(r.isError === true, "mural_update_widget with no fields is an error");

  r = await call("mural_get_board", { muralId: "missing" });
  check(r.isError === true && text(r).includes("HTTP 404"), "API errors surface as isError with status", text(r).split("\n")[0]);

  r = await call("mural_create_shape", { muralId: "ws1.100", shape: "triangle", x: 10, y: 20, width: 50, height: 60, color: "blue", borderWidth: 2 });
  const sh = seen.filter((s) => s.method === "POST" && s.path.endsWith("/widgets/shape")).at(-1); const shb = sh ? JSON.parse(sh.body) : null;
  check(!r.isError && Array.isArray(shb) && shb[0].shape === "triangle" && shb[0].style.backgroundColor === "#8ED6FFFF" && shb[0].style.borderWidth === 2, "mural_create_shape posts array with normalised fill", sh?.body);
  r = await call("mural_create_arrow", { muralId: "ws1.100", points: [{ x: 100, y: 300 }, { x: 400, y: 100 }], tip: "no tip", color: "red", strokeWidth: 2 });
  const ar = seen.filter((s) => s.method === "POST" && s.path.endsWith("/widgets/arrow")).at(-1); const arb = ar ? JSON.parse(ar.body) : null;
  check(!r.isError && arb && !Array.isArray(arb) && arb.x === 100 && arb.y === 100 && arb.width === 300 && arb.height === 200 && arb.points[0].y === 200 && arb.points[1].x === 300 && arb.tip === "no tip" && arb.style.strokeColor === "#FF7A7AFF", "mural_create_arrow posts single object with computed bbox + relative points", ar?.body);
  r = await call("mural_create_shape", { muralId: "ws1.100", shape: "rectangle", x: 100, y: 100, width: 200, height: 100, rotation: 90, anchor: "center" });
  const rotB = JSON.parse(seen.filter((s) => s.method === "POST" && s.path.endsWith("/widgets/shape")).at(-1).body)[0];
  check(!r.isError && rotB.x === 150 && rotB.y === 0 && rotB.rotation === 90, "anchor=center converts to Mural's top-left pivot (200x100 @90° centred on 100,100 -> x150,y0)", JSON.stringify({ x: rotB.x, y: rotB.y }));
  r = await call("mural_create_sticky_note", { muralId: "ws1.100", x: 300, y: 300, text: "c", anchor: "center" });
  const stB = JSON.parse(seen.filter((s) => s.method === "POST" && s.path.endsWith("/widgets/sticky-note")).at(-1).body)[0];
  check(!r.isError && stB.x === 231 && stB.y === 231, "sticky anchor=center with no rotation subtracts half of 138", JSON.stringify({ x: stB.x, y: stB.y }));
  r = await call("mural_create_textbox", { muralId: "ws1.100", x: 1, y: 2, text: "hi", fontSize: 30 });
  check(!r.isError && text(r).includes("Created text box"), "mural_create_textbox");
  r = await call("mural_draw", { muralId: "ws1.100", items: [
    { kind: "shape", id: "a", shape: "process", x: 0, y: 0, width: 100, height: 50 },
    { kind: "shape", id: "b", shape: "decision", x: 300, y: 0, width: 100, height: 50 },
    { kind: "arrow", from: "a", to: "b", label: "go" } ] });
  const drawArrow = seen.filter((s) => s.method === "POST" && s.path.endsWith("/widgets/arrow")).at(-1); const da = drawArrow ? JSON.parse(drawArrow.body) : null;
  check(!r.isError && text(r).includes("Placed 3 item(s)") && da && da.startRefId === "shape0" && da.endRefId === "shape0" && da.x === 50 && da.width === 300 && da.label.labels[0].text === "go" && da.label.format.fontFamily, "mural_draw resolves handles -> ids and auto-routes arrow center-to-center", drawArrow?.body);
  r = await call("mural_create_area", { muralId: "ws1.100", title: "A", x: 0, y: 0, color: "white" });
  const arBody = seen.filter((s) => s.method === "POST" && s.path.endsWith("/widgets/area")).at(-1);
  check(!r.isError && arBody && !JSON.parse(arBody.body).length && JSON.parse(arBody.body).title === "A", "mural_create_area posts a single object", arBody?.body);
  r = await call("mural_delete_widget", { muralId: "ws1.100", widgetId: "w1" });
  check(!r.isError && seen.some((s) => s.method === "DELETE" && s.path.endsWith("/widgets/w1")), "mural_delete_widget sends DELETE");
  r = await call("mural_create_sticky_note", { muralId: "ws1.100", x: 0, y: 0, color: "not-a-colour" });
  check(r.isError === true && text(r).includes("Unrecognised colour"), "bad colour is rejected before any API call");
  await client.close();

  // ---- refresh scenario: stale token in .env, refresh token present -------
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "mcp-mural-smoke-"));
  const envFile = resolve(dir, ".env");
  writeFileSync(envFile, "MURAL_ACCESS_TOKEN=stale\nMURAL_REFRESH_TOKEN=smoke-refresh\nMURAL_CLIENT_ID=cid\nMURAL_CLIENT_SECRET=sec\n# keep me\n");
  seen.length = 0;
  const t2 = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH, MURAL_API_BASE_URL: base, MURAL_ENV_FILE: envFile, MURAL_SECRETS_BACKEND: "env" },
    stderr: "pipe",
  });
  const c2 = new Client({ name: "smoke2", version: "0.0.0" });
  await c2.connect(t2);
  const r2 = await c2.callTool({ name: "mural_get_board", arguments: { muralId: "ws1.100" } });
  const refreshed = seen.some((x) => x.path.endsWith("/oauth2/token"));
  const retried = seen.filter((x) => x.path.endsWith("/murals/ws1.100")).length === 2;
  check(!r2.isError && refreshed && retried, "401 triggers refresh then retries the request", seen.map((x) => `${x.method} ${x.path}`).join(" | "));
  const persisted = readFileSync(envFile, "utf8");
  check(
    persisted.includes(`MURAL_ACCESS_TOKEN=${NEW_TOKEN}`) && persisted.includes(`MURAL_REFRESH_TOKEN=${NEW_REFRESH}`) && persisted.includes("MURAL_TOKEN_EXPIRES_AT=") && persisted.includes("# keep me"),
    "refreshed tokens persisted to .env, other lines preserved",
  );
  await c2.close();
} catch (err) {
  failures++;
  console.error("FAIL  smoke crashed:", err);
} finally {
  await client.close().catch(() => undefined);
  api.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
