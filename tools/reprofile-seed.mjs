/**
 * tools/reprofile-seed.mjs — refresh the §1.1 PROFILE blocks in
 * data/characters.json from the saved character pages, and nothing else.
 *
 *   node tools/reprofile-seed.mjs [--write]
 *
 * WHY THIS AND NOT A FULL REBUILD. The stored scores are the board. They were
 * read and scored in one pass on 2026-08-11 and they must not move because the
 * PARSER learned to read five more numbers off the same pages. So this tool
 * rewrites exactly one key per character and per loadout — `profile` — and
 * refuses to write if any other byte of the file would change. Run it after
 * touching parseCharacterProfile; it needs .corpus/, which is gitignored.
 *
 * It does NOT touch data/leaderboard-seed.json, and it does not need to: the
 * summary carries no profile block. That is the whole reason a profile refresh
 * is now a one-file change.
 *
 * It makes NO network requests. The corpus is the input and the only input.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { __test } from "../worker/bracelet.js";
import { charsPath, readCharacters, orderedEntries } from "./split-seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const corpusDir = join(root, ".corpus");
const write = process.argv.includes("--write");

if (!existsSync(corpusDir)) {
  console.error(".corpus/ is not here (it is gitignored). Nothing to read from — refusing to guess.");
  process.exit(2);
}

const src = readCharacters();
if (!src || !src.split) {
  console.error("no data/characters.json — run tools/split-seed.mjs --write first.");
  process.exit(2);
}
const seed = { entries: orderedEntries(src.store) };
const before = JSON.stringify(seed);

// Corpus file -> page text, keyed the way the seed names characters. The file
// names are "<Name>-<REGION>.html" and both halves can carry accents, so the key
// is built from the same two fields the entry holds rather than from a guess.
const pages = new Map();
for (const f of readdirSync(corpusDir)) {
  if (!f.endsWith(".html")) continue;
  const at = f.lastIndexOf("-");
  const name = f.slice(0, at), region = f.slice(at + 1, -".html".length);
  pages.set(name.toLowerCase() + "|" + region.toUpperCase(), join(corpusDir, f));
}

let touched = 0, missing = 0, mismatched = 0;
for (const e of seed.entries) {
  const path = pages.get(String(e.name).toLowerCase() + "|" + String(e.region).toUpperCase());
  if (!path) { console.log("  --   no saved page for " + e.name + "-" + e.region); missing++; continue; }
  const html = readFileSync(path, "utf8");
  const los = __test.extractLoadouts(html);

  // The seed's loadouts[] and extractLoadouts() must line up one for one, or the
  // page has changed shape and a positional rewrite would attach one loadout's
  // gems to another's bracelet. Say so and skip rather than scramble.
  const seedLos = Array.isArray(e.loadouts) ? e.loadouts : [];
  if (seedLos.length !== los.length) {
    console.log("  FAIL " + e.name + ": seed has " + seedLos.length + " loadouts, the page yields " + los.length);
    mismatched++;
    continue;
  }
  for (let i = 0; i < seedLos.length; i++) seedLos[i].profile = los[i].profile || null;
  const chosen = typeof e.chosenLoadout === "number" ? e.chosenLoadout : 0;
  e.profile = (seedLos[chosen] && seedLos[chosen].profile) || e.profile || null;
  touched++;
}

// Nothing but `profile` may move. Compare the whole file with every profile
// blanked on both sides: if that differs, a score or a line changed and this
// tool has no business writing.
function blanked(obj) {
  return JSON.stringify(obj, function (k, v) { return k === "profile" ? null : v; });
}
const fresh = JSON.parse(before);
if (blanked(fresh) !== blanked(seed)) {
  console.error("REFUSING TO WRITE: something other than a profile block changed.");
  process.exit(1);
}

console.log("entries reprofiled: " + touched + (missing ? ", no page for " + missing : "") +
  (mismatched ? ", loadout mismatch on " + mismatched : ""));
if (mismatched) { console.error("REFUSING TO WRITE while a loadout count disagrees."); process.exit(1); }

if (!write) {
  console.log("dry run — pass --write to rewrite data/characters.json");
  process.exit(0);
}
const store = JSON.parse(readFileSync(charsPath, "utf8"));
store.characters = src.store;
writeFileSync(charsPath, JSON.stringify(store, null, 1) + "\n");
console.log("wrote data/characters.json");
