/**
 * tools/rescore-seed.mjs — rewrite the seed's SCORES from the current model.
 *
 *   node tools/rescore-seed.mjs [--write]
 *
 * The sibling tool, reprofile-seed.mjs, refuses to let a score move: it exists
 * for the case where the PARSER learned to read more off the same page, and a
 * score moving there would be a bug. This one is the opposite case — the MODEL
 * moved, so every score must move with it, and holding them still would be the
 * bug.
 *
 * Run it after any change to model/bracelet.js that shifts a line's damage, and
 * bump the model's VERSION in the same pass so the Worker re-scores its stored
 * records too. Reads the seed's own `rawStats`; makes no network requests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { __test } from "../worker/bracelet.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = join(root, "data", "leaderboard-seed.json");
const write = process.argv.includes("--write");

const seed = JSON.parse(readFileSync(seedPath, "utf8"));
let moved = 0, still = 0;
const rows = [];

for (const e of seed.entries) {
  const s = __test.score(e.rawStats);
  const d = [];
  if (Math.abs(s.pct - e.damagePct) > 1e-9) d.push("pct " + e.damagePct.toFixed(4) + " -> " + s.pct.toFixed(4));
  if (Math.abs(s.linesPct - e.linesPct) > 1e-9) d.push("lines " + e.linesPct.toFixed(4) + " -> " + s.linesPct.toFixed(4));
  if (d.length) { moved++; rows.push({ name: e.name, why: d.join("; ") }); } else still++;
  e.damagePct = s.pct;
  e.linesPct = s.linesPct;
  if (s.grade) e.grade = s.grade;
}

rows.sort((a, b) => a.name.localeCompare(b.name));
for (const r of rows) console.log("  " + r.name.padEnd(18) + r.why);
console.log("\n" + moved + " scores moved, " + still + " unchanged, " + seed.entries.length + " total");

if (!write) { console.log("dry run — pass --write to save"); process.exit(0); }
writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");
console.log("wrote data/leaderboard-seed.json");
