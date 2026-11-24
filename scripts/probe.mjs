#!/usr/bin/env node
// Live probe through the compiled stdio server. Read-only unless --write is passed.
//   node scripts/probe.mjs --board <workspace>.<id> [--write]
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const board = args[args.indexOf("--board") + 1];
const write = args.includes("--write");
if (!board || board.startsWith("--")) { console.error("usage: probe.mjs --board <id> [--write]"); process.exit(2); }
const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../build/index.js");
const t = new StdioClientTransport({ command: process.execPath, args: [entry], env: { PATH: process.env.PATH }, stderr: "pipe" });
const c = new Client({ name: "probe", version: "0" });
await c.connect(t);
let fails = 0;
const call = async (label, name, a) => {
  const r = await c.callTool({ name, arguments: a });
  const text = r.content.map((x) => x.text).join("\n");
  console.log(`${r.isError ? "FAIL" : "PASS"}  ${label}: ${text.split("\n")[0]}`);
  if (r.isError) { fails++; console.log(text.slice(0, 600)); return null; }
  const i = text.indexOf("\n\n"); try { return JSON.parse(text.slice(i + 2)); } catch { return null; }
};
await call("list_workspaces", "mural_list_workspaces", {});
await call("get_board", "mural_get_board", { muralId: board });
await call("get_widgets", "mural_get_widgets", { muralId: board });
if (write) {
  const made = await call("create_sticky_note", "mural_create_sticky_note", { muralId: board, x: 200, y: 300, text: "probe", color: "yellow", shape: "rectangle" });
  const id = made?.value?.[0]?.id;
  if (id) await call("update_widget", "mural_update_widget", { muralId: board, widgetId: id, text: "probe (updated)", x: 220 });
}
await c.close();
console.log(fails ? `${fails} probe(s) failed` : "all probes passed");
process.exit(fails ? 1 : 0);
