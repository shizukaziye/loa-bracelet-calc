/**
 * tools/test-worker.mjs — everything about the Worker that can be checked
 * WITHOUT deploying it.
 *
 *   node tools/test-worker.mjs
 *
 * It imports worker/bracelet.js exactly as wrangler's bundler does (ESM entry,
 * pulling the CommonJS model through default-import interop), so the functions
 * under test are the deployed ones, not a copy.
 *
 * What it covers:
 *   1. SCORING PARITY — every entry in data/leaderboard-seed.json, re-scored by
 *      the Worker's own score() and compared to the number the seed recorded.
 *      Entries whose payload uses a type:2 index the shipped model does not map
 *      (the seed decoded 4, 74 and 151 with a local extension map) are EXPECTED
 *      to come out lower; the test asserts they are the only ones that differ.
 *   2. THE PAGE PARSER — extractBracelets() against a hand-built fragment in the
 *      exact hydration-blob style, including the raid-then-chaos repeat.
 *   3. THE CONSENT GATE — collectRosterChars() and ownsCharacter() against four
 *      plausible roster shapes (the real one is still unknown), plus the cases
 *      that must be REFUSED.
 *
 * What it cannot cover, and what a live deploy is for: KV, the rate-limit
 * bindings, CORS stamping, the OAuth round trip, and whether a real character
 * page still matches the parser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { __test } from "../worker/bracelet.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { score, extractBracelets, collectRosterChars, ownsCharacter, normRegion } = __test;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

// ---------------------------------------------------------------------------
console.log("\n1. scoring parity against data/leaderboard-seed.json");
// ---------------------------------------------------------------------------
const seed = JSON.parse(readFileSync(join(root, "data", "leaderboard-seed.json"), "utf8"));
const TOL = 1e-6;
let matched = 0, diverged = [];
for (const e of seed.entries) {
  const s = score(e.rawStats);
  const d = Math.abs(s.pct - e.damagePct);
  if (d < TOL) matched++;
  else diverged.push({ name: e.name, seed: e.damagePct, worker: s.pct, delta: s.pct - e.damagePct, unmapped: s.unmapped.map(u => u.index) });
}
console.log("     " + matched + "/" + seed.entries.length + " reproduce the seed's damagePct exactly");
for (const d of diverged) {
  console.log("     ~ " + d.name.padEnd(12) + " seed " + d.seed.toFixed(3) + "  worker " + d.worker.toFixed(3) +
    "  (" + d.delta.toFixed(3) + ")  unmapped indices: " + (d.unmapped.join(",") || "none"));
}
ok("every divergence is explained by an unmapped stat index",
  diverged.every(d => d.unmapped.length > 0),
  "an entry differs with nothing unmapped — the scorer disagrees with the seed for a reason nobody has written down");
ok("no divergence is an INCREASE (an unmapped line can only be missing damage)",
  diverged.every(d => d.delta <= TOL));
ok("at least half the seed reproduces exactly", matched * 2 >= seed.entries.length,
  matched + " of " + seed.entries.length);

// The split the board depends on: trait lines score through traitDamage, effect
// lines through setDamage, and pct > linesPct whenever a trait is present.
const white = seed.entries.find(e => e.name === "White");
if (white) {
  const s = score(white.rawStats);
  ok("White: linesPct matches the seed", Math.abs(s.linesPct - white.linesPct) < TOL,
    s.linesPct + " vs " + white.linesPct);
  ok("White: whole bracelet scores above its effect lines alone", s.pct > s.linesPct);
  ok("White: grade decoded as ancient", s.grade === "ancient", s.grade);
  ok("White: three granted lines", s.granted === 3, String(s.granted));
  ok("White: score is stamped with the canonical profile", s.profile === "canonical-default");
}

// ---------------------------------------------------------------------------
console.log("\n2. the character-page bracelet parser");
// ---------------------------------------------------------------------------
// Built in the exact style of the hydration blob documented in
// docs/research/mechanics-bible-leaderboard.md, with the equipment block
// repeated per loadout (raid first, then a stripped chaos set) the way a real
// page carries it.
const RAID = '{id:213400033,slot:"bracelet",data:{type:"bracelet",stats:[' +
  '{type:2,index:15,id:213400023,value:101,fixed:true},' +
  '{type:2,index:18,id:213400023,value:81,fixed:true},' +
  '{type:3,index:11051,id:213400023,value:5,fixed:false},' +
  '{type:2,index:11,id:213400023,value:13888,fixed:false},' +
  '{type:2,index:76,id:213400023,value:840,fixed:false}],numRerolls:4,numTicketRerolls:3}}';
const CHAOS = '{id:213400034,slot:"bracelet",data:{type:"bracelet",stats:[' +
  '{type:2,index:15,id:213400023,value:61,fixed:true}],numRerolls:0,numTicketRerolls:0}}';
const HTML = 'junk before {slot:"neck",data:{type:"tier4_accessory",stats:[]}}' +
  ',classification:"most_recent_raid",equipment:[' + RAID + '],' +
  'classification:"most_recent_chaos_dungeon",equipment:[' + CHAOS + '] trailing junk';

const found = extractBracelets(HTML);
ok("finds both loadouts' bracelets", found.length === 2, String(found.length));
ok("the FIRST hit is the raid bracelet", found[0] && found[0].stats.length === 5, JSON.stringify(found[0] && found[0].stats.length));
ok("rerolls come through", found[0] && found[0].numRerolls === 4 && found[0].numTicketRerolls === 3);
ok("fixed flags survive the key-quoting", found[0] && found[0].stats[0].fixed === true && found[0].stats[2].fixed === false);
ok("a page with no bracelet yields nothing", extractBracelets('slot:"neck",data:{type:"tier4_accessory",stats:[]}').length === 0);
ok("a truncated payload does not throw", extractBracelets('slot:"bracelet",data:{type:"bracelet",stats:[{type:2').length === 0);

const decodedFromPage = score(found[0].stats);
ok("the documented payload decodes and scores", decodedFromPage.pct > 0 && decodedFromPage.granted === 3,
  JSON.stringify({ pct: decodedFromPage.pct, granted: decodedFromPage.granted }));

// ---------------------------------------------------------------------------
console.log("\n3. the consent gate");
// ---------------------------------------------------------------------------
// THE REAL SHAPE, captured from a live signed-in session on 2026-08-11 (two
// rosters on one account, region on the ROSTER and not on the character, class
// as a snake_case game code, and NO bracelet anywhere — see
// docs/research/oauth-rosters-shape.md). This fixture is the one that matters;
// the four speculative shapes below it stay because the walker must not become
// brittle if lostark.bible reshapes the payload.
const REAL = {
  rosters: [
    { region: "NA", world: "Nineveh", characters: [
      { name: "Paroxysmal", class: "devil_hunter_female", ilvl: 1795, lastUpdate: 1786438275 },
      { name: "Shizukaziye", class: "reaper", ilvl: 1780, lastUpdate: 1786438275 },
      { name: "Teal", class: "alchemist", ilvl: 1777, lastUpdate: 1786438275 }
    ] },
    { region: "NA", world: "Nineveh", characters: [
      { name: "White", class: "arcana", ilvl: 1773, lastUpdate: 1786438275 },
      { name: "Kyulo", class: "blade", ilvl: 1772, lastUpdate: 1786438275 }
    ] }
  ]
};
const realChars = collectRosterChars(REAL);
ok("REAL payload: all five characters found across both rosters", realChars.length === 5, String(realChars.length));
ok("REAL payload: region is inherited from the roster", realChars.every(c => c.region === "NA"),
  JSON.stringify(realChars.map(c => c.region)));
ok("REAL payload: item levels come through", realChars[0].ilvl === 1795, String(realChars[0].ilvl));
ok("REAL payload: the class code is kept as sent", realChars[0].cls === "devil_hunter_female", realChars[0].cls);
ok("REAL payload: ownership passes for a real character", ownsCharacter(realChars, "NA", "Kyulo").ok);
ok("REAL payload: ownership passes with the region verified, not guessed",
  ownsCharacter(realChars, "NA", "Kyulo").regionVerified === true);
ok("REAL payload: a stranger is refused", !ownsCharacter(realChars, "NA", "Notmine").ok);
ok("REAL payload: the same name in CE is refused", !ownsCharacter(realChars, "CE", "Kyulo").ok);
ok("REAL payload: `world` (Nineveh) is not mistaken for a region",
  realChars.every(c => c.region === "NA"));
ok("REAL payload: carries NO bracelet, so the Worker fetch is required",
  JSON.stringify(REAL).indexOf('"stats"') === -1);

// Four speculative shapes, from when the real one was unknown. All must find the
// same character; none may invent one.
const SHAPES = {
  "rosters[].characters[]": { rosters: [{ name: "Main roster", region: "NA", characters: [{ name: "Paroxysmal", class: "Arcanist", itemLevel: 1785 }] }] },
  "flat array":             [{ name: "Paroxysmal", className: "Arcanist", ilvl: 1785, region: "NA" }],
  "region on the character":{ data: { characters: [{ name: "Paroxysmal", job: "Arcanist", gearScore: 1785, server: "NA" }] } },
  "region only on the roster": { rosters: [{ name: "R1", regionCode: "na", chars: [{ name: "Paroxysmal", class: "Arcanist" }] }] }
};
for (const [label, payload] of Object.entries(SHAPES)) {
  const chars = collectRosterChars(payload);
  const hit = chars.find(c => c.name === "Paroxysmal");
  ok("walks " + label, !!hit, JSON.stringify(chars));
  if (hit) ok("  region resolves to NA in " + label, hit.region === "NA", hit.region);
}

const mine = collectRosterChars(SHAPES["rosters[].characters[]"]);
ok("owns its own character", ownsCharacter(mine, "NA", "Paroxysmal").ok);
ok("owns it case-insensitively", ownsCharacter(mine, "NA", "PAROXYSMAL").ok);
ok("REFUSES a character not on the roster", !ownsCharacter(mine, "NA", "Someoneelse").ok);
ok("REFUSES the right name in the wrong region", !ownsCharacter(mine, "CE", "Paroxysmal").ok);
ok("says WHY when the name is right but the region is not",
  ownsCharacter(mine, "CE", "Paroxysmal").sawName === true);
ok("REFUSES an empty roster", !ownsCharacter([], "NA", "Paroxysmal").ok);
ok("the roster label itself is not a character",
  !mine.some(c => c.name === "Main roster"), JSON.stringify(mine.map(c => c.name)));

// Region normalisation: guessing is worse than refusing.
ok("EU maps to CE", normRegion("EU") === "CE");
ok("eu-central maps to CE", normRegion("Europe Central") === "CE");
ok("NA stays NA", normRegion("na") === "NA");
ok("KR is refused (this Worker reads lostark.bible only)", normRegion("KR") === "");
ok("nonsense is refused", normRegion("../etc") === "");

// ---------------------------------------------------------------------------
console.log("\n" + (fail ? "FAILED" : "PASSED") + " — " + pass + " checks passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
