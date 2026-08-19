/**
 * tools/rescore-seed.mjs — rewrite the baked characters' SCORES from the current
 * model, then re-bake the board summary from them.
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
 * records too. Reads data/characters.json's own `rawStats`; makes no network
 * requests.
 *
 * TWO FILES MOVE. data/characters.json holds the scores, and
 * data/leaderboard-seed.json is the summary built from it — so this writes the
 * characters and then runs the same builder tools/split-seed.mjs runs. Rewriting
 * one without the other is exactly the state the board must never ship in.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { __test } from "../worker/bracelet.js";
import { charsPath, readCharacters, orderedEntries } from "./split-seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const write = process.argv.includes("--write");

const src = readCharacters();
if (!src) {
  console.error("no character store — data/characters.json is missing and the board is already split.");
  process.exit(2);
}
if (!src.split) {
  console.error("the seed has not been split yet. Run tools/split-seed.mjs --write first.");
  process.exit(2);
}

const entries = orderedEntries(src.store);
let moved = 0, still = 0;
const rows = [];

for (const e of entries) {
  const s = __test.score(e.rawStats);
  const d = [];
  if (Math.abs(s.pct - e.damagePct) > 1e-9) d.push("pct " + e.damagePct.toFixed(4) + " -> " + s.pct.toFixed(4));
  if (Math.abs(s.linesPct - e.linesPct) > 1e-9) d.push("lines " + e.linesPct.toFixed(4) + " -> " + s.linesPct.toFixed(4));
  if (d.length) { moved++; rows.push({ name: e.name, why: d.join("; ") }); } else still++;
  e.damagePct = s.pct;
  e.linesPct = s.linesPct;
  if (s.grade) e.grade = s.grade;

  // Each loadout carries its own score, and the board's loadout marker prints
  // them. They move with the model too, or the marker contradicts the row.
  for (const l of (e.loadouts || [])) {
    if (!Array.isArray(l.rawStats) || !l.rawStats.length) continue;
    const ls = __test.score(l.rawStats);
    l.damagePct = ls.pct;
    l.linesPct = ls.linesPct;
    if (ls.grade) l.grade = ls.grade;
  }
}

rows.sort((a, b) => a.name.localeCompare(b.name));
for (const r of rows) console.log("  " + r.name.padEnd(18) + r.why);
console.log("\n" + moved + " scores moved, " + still + " unchanged, " + entries.length + " total");

if (!write) { console.log("dry run — pass --write to save"); process.exit(0); }
const store = JSON.parse(readFileSync(charsPath, "utf8"));
store.characters = src.store;
writeFileSync(charsPath, JSON.stringify(store, null, 1) + "\n");
console.log("wrote data/characters.json");

// And the summary, from the same builder the Worker uses. Spawned rather than
// imported so there is one code path that writes the board file.
execFileSync(process.execPath, [join(here, "split-seed.mjs"), "--write"], { stdio: "inherit" });
