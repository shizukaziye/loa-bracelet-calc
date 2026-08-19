/**
 * tools/split-seed.mjs — cut the one baked board file in two, the way the Worker
 * cut the snapshot in two.
 *
 *   node tools/split-seed.mjs [--write]
 *
 * BEFORE   data/leaderboard-seed.json     59 whole characters — raw stat lines,
 *                                          every loadout's raw stat lines, and a
 *                                          §1.1 profile block each. 1.2 MB, and
 *                                          the board fetched all of it to draw a
 *                                          table of letters.
 *
 * AFTER    data/leaderboard-seed.json     the v3 SNAPSHOT PAYLOAD — byte for byte
 *                                          the shape the Worker serves at
 *                                          /?list=1, so one decoder reads both and
 *                                          a change to the wire format cannot pass
 *                                          the baked copy by.
 *          data/characters.json           the whole characters, keyed
 *                                          "<REGION>|<name lowercased>". What the
 *                                          tools re-score against, and what the
 *                                          board falls back to for a row click
 *                                          when no Worker answers.
 *
 * ONE-SHOT AND DETERMINISTIC. It reads the summary's numbers from the Worker's
 * own snapshotEntry()/encodeSnapshot(), never from the old file's stored fields,
 * so the baked board and the live board are produced by the same code. Run it
 * again on an already-split pair and it rebuilds the summary from characters.json
 * unchanged — which is also how to re-bake the board after a model change (see
 * rescore-seed.mjs, which rewrites the characters and then calls this).
 *
 * IT REFUSES TO WRITE if the summary would hold fewer characters than the input,
 * or if a character's own bracelet disagrees with the loadout it says is chosen.
 * Losing a row silently is the one failure a one-shot migration must not have.
 *
 * No network. The input file is the input and the only input.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { __test } from "../worker/bracelet.js";

const { snapshotEntry, encodeSnapshot } = __test;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const boardPath = join(root, "data", "leaderboard-seed.json");
export const charsPath = join(root, "data", "characters.json");

/** The store key both sides build the same way: the Worker's region spelling,
 *  the name folded. "EU" is this side's word for lostark.bible's "CE". */
export function charKey(region, name) {
  const r = String(region || "").trim().toUpperCase();
  return (r === "EU" ? "CE" : r) + "|" + String(name || "").toLowerCase();
}

/**
 * One whole character as a KV RECORD — the shape snapshotEntry() reads. The baked
 * characters and the stored ones then travel the identical path into a row.
 */
export function recordOf(e) {
  const los = Array.isArray(e.loadouts) ? e.loadouts : [];
  return {
    region: e.region, name: e.name, "class": e["class"] || null,
    itemLevel: e.itemLevel == null ? null : e.itemLevel,
    pulledAt: Date.parse(e.scoredAt) || 0,
    stats: e.rawStats,
    loadouts: los.map(function (l) {
      return { stats: l.rawStats, label: l.label, classification: l.classification,
        itemLevel: l.itemLevel == null ? null : l.itemLevel };
    }),
    chosenLoadout: typeof e.chosenLoadout === "number" ? e.chosenLoadout : 0,
    score: { grade: e.grade },
    published: true
  };
}

function sig(stats) {
  return JSON.stringify((stats || []).map(s => [s.type, s.index, s.value, s.fixed ? 1 : 0]));
}

/**
 * The whole characters, keyed. Reads the already-split pair when there is one,
 * and the pre-split single file otherwise, so the tools have one way in whichever
 * side of the migration they are called on.
 */
export function readCharacters() {
  const board = JSON.parse(readFileSync(boardPath, "utf8"));
  if (Array.isArray(board.entries)) {
    const store = {};
    for (const e of board.entries) store[charKey(e.region, e.name)] = e;
    return { meta: board, store: store, split: false };
  }
  if (!existsSync(charsPath)) return null;
  const chars = JSON.parse(readFileSync(charsPath, "utf8"));
  return { meta: chars, store: chars.characters, split: true };
}

/** Characters in a stable order: the store key, sorted. */
export function orderedEntries(store) {
  return Object.keys(store).sort().map(k => store[k]);
}

function main() {
  const write = process.argv.includes("--write");
  const src = readCharacters();
  if (!src) {
    console.error("data/leaderboard-seed.json is already a summary and data/characters.json is not here.");
    console.error("Nothing to split, and nothing to rebuild from — refusing to guess.");
    process.exit(2);
  }
  const meta = src.meta;
  const entries = orderedEntries(src.store);
  console.log("input: " + (src.split ? "data/characters.json" : "the pre-split data/leaderboard-seed.json") +
    ", " + entries.length + " whole characters" + (src.split ? " (re-baking the summary)" : ""));

  // A chosen loadout that is not the character's own bracelet would rank one item
  // and open another. Refuse rather than pick a side.
  const bad = [];
  for (const e of entries) {
    const los = Array.isArray(e.loadouts) ? e.loadouts : [];
    if (!Array.isArray(e.rawStats) || !e.rawStats.length) { bad.push(e.name + ": no rawStats"); continue; }
    if (!los.length) continue;
    if (!los.every(l => Array.isArray(l.rawStats) && l.rawStats.length)) { bad.push(e.name + ": a loadout carries no rawStats"); continue; }
    if (!los.some(l => sig(l.rawStats) === sig(e.rawStats))) bad.push(e.name + ": rawStats matches no loadout");
  }
  if (bad.length) {
    console.error("REFUSING: " + bad.length + " character(s) the split cannot place —");
    for (const b of bad) console.error("  " + b);
    process.exit(1);
  }

  const rows = [], dropped = [];
  for (const e of entries) {
    const row = snapshotEntry(recordOf(e));
    if (row) rows.push(row); else dropped.push(e.name + "-" + e.region);
  }
  if (dropped.length) {
    console.error("REFUSING: " + dropped.length + " character(s) produced no board row — " + dropped.join(", "));
    process.exit(1);
  }
  if (rows.length !== entries.length) {
    console.error("REFUSING: " + entries.length + " in, " + rows.length + " out.");
    process.exit(1);
  }

  const scoredAt = meta._scoredAt || new Date().toISOString();
  const payload = encodeSnapshot(Date.parse(scoredAt) || Date.now(), rows);

  const summary = Object.assign({
    _note: "The BOARD SUMMARY: one small row per character, exactly the payload the " +
      "Worker serves at /?list=1 (v" + payload.v + "). It carries no bracelet — the whole " +
      "characters live in data/characters.json and behind GET /character. Rebuild both " +
      "with tools/split-seed.mjs.",
    _scoredAt: scoredAt,
    _model: meta._model || null,
    _sortedBy: "the 0-100 bracelet grade, highest first (row slot 7[2])"
  }, payload);

  const characters = {
    _note: "Every character the baked board knows, whole: raw stat lines, every " +
      "loadout, and the §1.1 profile block. Keyed <REGION>|<name lowercased>, the " +
      "Worker's region spelling (EU is CE here). Read by the tools, and by the board " +
      "for a row click when no Worker answers. data/leaderboard-seed.json is the " +
      "summary built FROM this file.",
    _scoredAt: scoredAt,
    _model: meta._model || null,
    _goldPer1Pct: meta._goldPer1Pct || null,
    _loadoutRule: meta._loadoutRule || null,
    _loadoutClassifications: meta._loadoutClassifications || null,
    characters: src.store
  };

  const summaryJson = JSON.stringify(summary, null, 1) + "\n";
  const charsJson = JSON.stringify(characters, null, 1) + "\n";

  console.log("  summary   " + rows.length + " rows, " + summaryJson.length + " bytes" +
    " (" + JSON.stringify(payload).length + " on the wire, before gzip)");
  console.log("  whole     " + entries.length + " characters, " + charsJson.length + " bytes");
  console.log("  loadout marker on " + rows.filter(r => r.loadouts).length + " rows; " +
    rows.filter(r => r.role === "support").length + " read on the support axis");

  if (!write) { console.log("\ndry run — pass --write to save both files"); return; }
  writeFileSync(charsPath, charsJson);
  writeFileSync(boardPath, summaryJson);
  console.log("\nwrote data/characters.json and data/leaderboard-seed.json");
}

// Importable for its helpers (tools/test-worker.mjs re-scores through recordOf),
// runnable as the migration. Only the second runs the migration.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
