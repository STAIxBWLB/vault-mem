import { appendLog } from "../../src/vault-log.ts";
const [home, vault, prefix, rawCount] = process.argv.slice(2);
if (!home || !vault || !prefix || !rawCount) throw new Error("worker arguments required");
const count = Number(rawCount);
if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("invalid worker count");
const results = [];
for (let i = 0; i < count; i++) results.push(appendLog(home, { vault, event: { type: "EXTRACT", project: "-", source: `${prefix}:${i}`, note: `Synthetic event ${i}` }, channel: "cli" }, { env: { CODEX_THREAD_ID: "synthetic-agent" } }));
console.log(JSON.stringify({ ok: results.every(result => result.ok), count: results.filter(result => result.appended).length }));
