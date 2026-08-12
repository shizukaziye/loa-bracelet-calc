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
 *   3. THE ROSTER PROOF — collectRosterChars() and ownsCharacter() against the
 *      real roster payload and four older speculative shapes, plus the cases that
 *      must be REFUSED. Since 2026-08-11 this proof guards POST /forget alone; a
 *      LOOKUP needs no sign-in and no ownership (ARCHITECTURE.md §0.3). These
 *      checks stay green either way — they test the walker, not the policy.
 *
 * What it cannot cover, and what a live deploy is for: KV, the rate-limit
 * bindings, CORS stamping, the OAuth round trip, and whether a real character
 * page still matches the parser.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { __test } from "../worker/bracelet.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { score, extractBracelets, collectRosterChars, ownsCharacter, normRegion,
        extractLoadouts, pickBestLoadout, briefScore, loadoutLabel,
        parseCharacterProfile, snapTo, modal, MASTER_NODE_ID, GEM_AP_LEVEL,
        noSuchMsg, lookupKey, regionLabel } = __test;

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
  else diverged.push({
    name: e.name, seed: e.damagePct, worker: s.pct, delta: s.pct - e.damagePct,
    unmapped: s.unmapped.map(u => u.index),
    // The OTHER known reason the two scorers differ: the seed adds a combat
    // trait that landed in a GRANTED slot at its rolled value, while the Worker
    // follows the model's rule and scores it zero. Written down in the seed's
    // own notes[] and in score()'s header — so it is an explanation, not a shrug.
    grantedTrait: (e.traits || []).some(t => !t.fixed)
  });
}
console.log("     " + matched + "/" + seed.entries.length + " reproduce the seed's damagePct exactly");
for (const d of diverged) {
  console.log("     ~ " + d.name.padEnd(12) + " seed " + d.seed.toFixed(3) + "  worker " + d.worker.toFixed(3) +
    "  (" + d.delta.toFixed(3) + ")  " +
    (d.unmapped.length ? "unmapped indices: " + d.unmapped.join(",") : d.grantedTrait ? "a combat trait sits in a granted slot" : "UNEXPLAINED"));
}
ok("every divergence has a written-down cause (an unmapped index, or a trait in a granted slot)",
  diverged.every(d => d.unmapped.length > 0 || d.grantedTrait),
  "an entry differs for a reason nobody has written down");
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
// docs/research/mechanics-bible-leaderboard.md. extractBracelets() is now only
// the fallback for a page whose loadouts array will not parse; the loadout-aware
// path it fell out of is section 2b.
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
// NOT "the first hit is the raid bracelet" — that was the bug. This fixture is
// written raid-first, so all this asserts is that document order is preserved;
// which loadout a bracelet belongs to is section 2b's job.
ok("hits come back in document order", found[0] && found[0].stats.length === 5, JSON.stringify(found[0] && found[0].stats.length));
ok("rerolls come through", found[0] && found[0].numRerolls === 4 && found[0].numTicketRerolls === 3);
ok("fixed flags survive the key-quoting", found[0] && found[0].stats[0].fixed === true && found[0].stats[2].fixed === false);
ok("a page with no bracelet yields nothing", extractBracelets('slot:"neck",data:{type:"tier4_accessory",stats:[]}').length === 0);
ok("a truncated payload does not throw", extractBracelets('slot:"bracelet",data:{type:"bracelet",stats:[{type:2').length === 0);

const decodedFromPage = score(found[0].stats);
ok("the documented payload decodes and scores", decodedFromPage.pct > 0 && decodedFromPage.granted === 3,
  JSON.stringify({ pct: decodedFromPage.pct, granted: decodedFromPage.granted }));

// ---------------------------------------------------------------------------
console.log("\n2b. loadouts — one bracelet per lostark.bible tab");
// ---------------------------------------------------------------------------
// The parser above reads the page in DOCUMENT ORDER, and this file used to
// assert that order was "raid first, then chaos". It is not: across the 30 saved
// character pages the chaos loadout comes first on 16 of them, which is how the
// old first-hit rule picked the wrong bracelet for 5 of 30 characters. The real
// structure is a `loadouts:[…]` array where each element has its own `items`,
// so the bracelet is found through the loadout, not through document order.
//
// The fixture below is built chaos-FIRST on purpose, with the better bracelet in
// the raid loadout, so a regression to "take hit #0" fails here loudly.
function LD(classification, lastUpdated, itemLevel, braceletJs) {
  return '{classification:"' + classification + '",canGenerateSkillCode:true,lastUpdated:' + lastUpdated +
    ',itemLevel:' + itemLevel + ',items:[{id:1,slot:"neck",data:{type:"tier4_accessory",stats:[]}},' +
    braceletJs + '],type:"equipment"}';
}
const BR_RAID = '{id:213400033,slot:"bracelet",data:{type:"bracelet",stats:[' +
  '{type:2,index:15,id:213400023,value:101,fixed:true},' +
  '{type:2,index:18,id:213400023,value:81,fixed:true},' +
  '{type:3,index:11051,id:213400023,value:5,fixed:false},' +
  '{type:2,index:11,id:213400023,value:13888,fixed:false},' +
  '{type:2,index:76,id:213400023,value:840,fixed:false}],numRerolls:4,numTicketRerolls:3}}';
const BR_CHAOS = '{id:213400034,slot:"bracelet",data:{type:"bracelet",stats:[' +
  '{type:2,index:15,id:213400023,value:61,fixed:true},' +
  '{type:2,index:18,id:213400023,value:61,fixed:true},' +
  '{type:3,index:11053,id:213400023,value:5,fixed:false},' +
  '{type:2,index:11,id:213400023,value:9600,fixed:false},' +
  '{type:2,index:76,id:213400023,value:500,fixed:false}],numRerolls:0,numTicketRerolls:0}}';
const BR_NONE = '{id:0,slot:"bracelet",data:void 0}';

const PAGE = 'header:{id:1},{type:"data",data:{loadouts:[' +
  LD("most_recent_chaos_dungeon", 1786422780000, 1791.6661, BR_CHAOS) + "," +
  LD("most_recent_raid", 1786337374000, 1791.6661, BR_RAID) + "," +
  LD("raid_merged", 1786337374000, 1791.6661, BR_RAID) +
  "],stale:false}} trailing junk";

const lds = extractLoadouts(PAGE);
ok("reads every loadout that carries a bracelet", lds.length === 3, String(lds.length));
ok("keeps each loadout's own classification",
  lds.map(l => l.classification).join(",") === "most_recent_chaos_dungeon,most_recent_raid,raid_merged",
  lds.map(l => l.classification).join(","));
ok("labels them the way lostark.bible's own buttons do",
  lds.map(l => l.label).join(" · ") === "Chaos · Raid · Est. Raid", lds.map(l => l.label).join(" · "));
ok("an unknown classification still gets a readable label",
  loadoutLabel("most_recent_guardian_raid") === "Guardian Raid", loadoutLabel("most_recent_guardian_raid"));
ok("itemLevel and lastUpdated come through",
  lds[1].itemLevel === 1791.6661 && lds[1].lastUpdated === 1786337374000);
ok("the rendered loadout is the NEWEST, not the raid one",
  lds[0].isRendered && !lds[1].isRendered, JSON.stringify(lds.map(l => l.isRendered)));
ok("each loadout keeps its own rerolls", lds[0].numRerolls === 0 && lds[1].numRerolls === 4);

for (const l of lds) l.score = briefScore(score(l.stats));
const best = pickBestLoadout(lds);
ok("the board takes the HIGHEST loadout, not the first and not the rendered one",
  lds[best].classification === "most_recent_raid", lds[best].classification);
ok("the highest really is higher than the one the page draws",
  lds[best].score.pct > lds[0].score.pct,
  lds[best].score.pct + " vs " + lds[0].score.pct);
ok("a tie goes to raid over est. raid",
  lds[1].score.pct === lds[2].score.pct && lds[best].classification === "most_recent_raid");
ok("the old first-hit rule would have taken the WRONG bracelet here",
  extractBracelets(PAGE)[0].stats[0].value === 61);

const EMPTY_SLOT = 'loadouts:[' + LD("most_recent_raid", 1, 1700, BR_RAID) + "," +
  LD("most_recent_chaos_dungeon", 2, 1700, BR_NONE) + "]";
const one = extractLoadouts(EMPTY_SLOT);
ok("`data: void 0` is an empty slot, not a bracelet", one.length === 1, String(one.length));
ok("a page with no loadouts array yields nothing rather than throwing",
  extractLoadouts('slot:"bracelet",data:{type:"bracelet",stats:[]}').length === 0);
ok("a truncated loadouts array does not throw", extractLoadouts("loadouts:[{classification:\"x\"").length === 0);

// ---------------------------------------------------------------------------
console.log("\n2c. the LEFT COLUMN — parseCharacterProfile");
// ---------------------------------------------------------------------------
// One hand-built loadout in the exact hydration-blob style, carrying one of
// everything the deck's gear panel holds. The real corpus lives in .corpus/
// (gitignored, 59 pages); the optional sweep at the end of this section runs
// over it when it is there, so a shape change upstream shows up as a coverage
// drop rather than as silence.
const GEAR = ["weapon:25", "head:21", "upper_body:22", "lower_body:20", "hand:23", "shoulder:19"]
  .map(s => s.split(":"))
  .map(([slot, h]) => '{id:1,slot:"' + slot + '",data:{type:"equipment",stats:[],honing:' + h + ',advancedHoning:40}}')
  .join(",");
const ACC =
  '{id:2,slot:"neck",data:{type:"tier4_accessory",stats:[' +
    "{type:2,index:6,base:true,id:6003,value:3835}," +          // base block, not a roll
    "{type:2,index:27,base:false,id:6009,value:1300}," +        // a roll the deck has no control for
    "{type:2,index:50,base:false,id:6009,value:260}]}}," +      // Additional Damage 2.60%
  '{id:3,slot:"ear1",data:{type:"tier4_accessory",stats:[' +
    "{type:2,index:152,base:false,id:6109,value:180}]}}," +     // Weapon Power 1.80%
  '{id:4,slot:"ear2",data:{type:"tier4_accessory",stats:[' +
    "{type:2,index:49,base:false,id:6109,value:155}]}}";        // crit rate only: no WP line at all
const STONE = '{id:5,slot:"ability_stone",data:{engravings:[{id:141,nodes:7},{id:247,nodes:9},{id:800,nodes:1}],type:"ability_stone"}}';
const GEMS = "gems:[" +
  Array.from({ length: 10 }, (_, i) => "{slot:" + i + ",id:65032100,effects:[{type:27,id:47250,value:2400},{type:2,id:150,value:120}]}").join(",") +
  ",{slot:10,id:65032090,effects:[{type:27,id:47250,value:2200},{type:2,id:150,value:100}]}]";
const APASS = "arkPassive:{evolution:[{id:1010100,level:10},{id:1032200,level:1},{id:1032300,level:1}],enlightenment:[],leap:[]}";
const PROFILE_HTML = "loadouts:[{classification:\"most_recent_raid\",lastUpdated:1,itemLevel:1789.1661," +
  "combatPower:{id:1,score:7200.5},classId:\"blade\",apPoints:{enlightenment:101,evolution:140,leap:70}," +
  GEMS + ",items:[" + GEAR + "," + ACC + "," + STONE + "," +
  '{id:9,slot:"bracelet",data:{type:"bracelet",stats:[{type:2,index:15,id:1,value:101,fixed:true}],numRerolls:1,numTicketRerolls:0}}],' +
  "battlePoint:{parts:[{type:1,value:1,mainStat:827342,weaponPower:265706}]}," + APASS + "}]";

const pf = parseCharacterProfile(PROFILE_HTML);
ok("reads all six honing levels", pf && pf.honing &&
  pf.honing.weapon === 25 && pf.honing.head === 21 && pf.honing.chest === 22 &&
  pf.honing.pants === 20 && pf.honing.gloves === 23 && pf.honing.shoulder === 19,
  JSON.stringify(pf && pf.honing));
ok("upper_body/lower_body/hand become chest/pants/gloves",
  pf.honing.chest === 22 && pf.honing.pants === 20 && pf.honing.gloves === 23);
ok("advanced honing is reported, never applied", pf.advancedHoning && pf.advancedHoning.weapon === 40);
ok("the neck's additional damage is 2.6%", pf.neckAddDmg === 2.6, String(pf.neckAddDmg));
ok("a base:true line is not mistaken for a roll", pf.raw.neckAddDmg === 2.6);
ok("earring 1's weapon power is 1.8%", pf.earring1Wp === 1.8, String(pf.earring1Wp));
ok("an earring with no weapon-power line reads 0, not nothing",
  pf.earring2Wp === 0, String(pf.earring2Wp));
ok("nine gems at 10 and one at 9 collapse to the modal 10", pf.gemLevel === 10, String(pf.gemLevel));
ok("the whole gem spread rides along", pf.gemLevels.length === 11 && pf.raw.gemMixed === true,
  JSON.stringify(pf.gemLevels));
ok("a 9/7 stone turns the toggle on", pf.stone97 === true, JSON.stringify(pf.raw.stoneNodes));
ok("the top TWO nodes decide it, not the third", pf.raw.stoneNodes.join("/") === "9/7/1");
ok("the Master evolution node is found", pf.master === true);
ok("item level, class and combat power come through",
  pf.itemLevel === 1789.1661 && pf.classId === "blade" && pf.combatPower === 7200.5);
ok("the page's post-bucket totals are NOT offered as the deck's raw pair",
  pf.mainStat === undefined && pf.weaponPower === undefined &&
  pf.raw.mainStatTotal === 827342 && pf.raw.weaponPowerTotal === 265706);
ok("a stone one node short of 9/7 turns the toggle off",
  parseCharacterProfile(PROFILE_HTML.replace("nodes:7}", "nodes:6}")).stone97 === false);
ok("no Master node means the toggle is off, not unknown",
  parseCharacterProfile(PROFILE_HTML.replace("{id:1032200,level:1},", "")).master === false);
ok("gems with no attack-power effect are read as UNKNOWN, not as a level",
  parseCharacterProfile(PROFILE_HTML.replace(/,\{type:2,id:150,value:\d+\}/g, "")).gemLevel === undefined);
ok("a page with no loadouts array yields null rather than throwing",
  parseCharacterProfile("nothing here at all") === null);
ok("a truncated loadout does not throw",
  parseCharacterProfile('loadouts:[{classification:"x",items:[{id:1,slot:"head"') !== undefined);
ok("snapTo picks the nearest legal option", snapTo([0, 0.7, 1.6, 2.6], 1.59) === 1.6 &&
  snapTo([0, 0.8, 1.8, 3], 2.9) === 3 && snapTo([0, 0.7, 1.6, 2.6], 0.1) === 0);
ok("modal breaks a tie upwards", modal([9, 9, 10, 10]) === 10 && modal([8, 9, 9]) === 9);
ok("the Master node id is the one the corpus named", MASTER_NODE_ID === 1032200);
ok("the gem attack-power ladder covers 6…10",
  [45, 60, 80, 100, 120].every((v, i) => GEM_AP_LEVEL[v] === i + 6));

// Optional: the real corpus, when it is on this machine.
const corpusDir = join(root, ".corpus");
let corpusFiles = [];
try { corpusFiles = readdirSync(corpusDir).filter(f => f.endsWith(".html")); } catch (e) { corpusFiles = []; }
if (!corpusFiles.length) {
  console.log("  --   .corpus/ is not here (it is gitignored); skipping the real-page sweep");
} else {
  const need = ["honing", "neckAddDmg", "earring1Wp", "earring2Wp", "stone97", "master", "itemLevel"];
  const missed = {};
  let los = 0, gems = 0;
  for (const f of corpusFiles) {
    for (const l of extractLoadouts(readFileSync(join(corpusDir, f), "utf8"))) {
      los++;
      if (!l.profile) { missed.PROFILE = (missed.PROFILE || 0) + 1; continue; }
      for (const k of need) if (l.profile[k] === undefined) missed[k] = (missed[k] || 0) + 1;
      if (l.profile.gemLevel !== undefined) gems++;
    }
  }
  ok("every loadout in .corpus yields every non-gem field (" + corpusFiles.length + " pages, " + los + " loadouts)",
    Object.keys(missed).length === 0, JSON.stringify(missed));
  ok("gems read on all but the loadouts that have none", gems >= los - 15, gems + "/" + los);
}

// ---------------------------------------------------------------------------
console.log("\n3. the roster proof (POST /forget only, since 2026-08-11)");
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
console.log("\n4. the failure copy");
// ---------------------------------------------------------------------------
// The sentence a visitor reads when a name comes back empty. It is checked HERE
// because the only way to see it from the live Worker is to fetch a name that
// does not exist, and spending a real lostark.bible request to read our own
// sentence is the kind of request this whole design exists to avoid.
//
// The rule these assert: say what actually happened, and never hang a rule of
// OURS on lostark.bible. The old copy read "That character is not on the roster
// lostark.bible shows for your account" -- which blamed lostark.bible for a
// restriction WE had chosen, and sent people off to fix the wrong thing.
const nfNA = noSuchMsg("NA", "Nobodyhere");
const nfCE = noSuchMsg("CE", "Nobodyhere");
ok("not-found copy names the character and the region", /No character called Nobodyhere on NA/.test(nfNA), nfNA);
ok("not-found copy offers the spelling and the other region", /spelling/.test(nfNA) && /try EU/.test(nfNA), nfNA);
ok("not-found copy says a hidden character cannot be read", /hidden on lostark\.bible/.test(nfNA), nfNA);
ok("CE is shown to the player as EU, and points at NA", /on EU/.test(nfCE) && /try NA/.test(nfCE), nfCE);
ok("CE displays as EU, NA as NA", regionLabel("CE") === "EU" && regionLabel("NA") === "NA");
ok("the copy never says the character is not yours",
  !/not on the roster|your roster|only your own/i.test(nfNA + nfCE), nfNA);
ok("the copy never blames lostark.bible for refusing us",
  !/would not confirm|refused|not allowed|not permitted/i.test(nfNA), nfNA);

// The lookup throttle keys on the IP, not on a token: a signed-out visitor has no
// token, and keying the signed-in separately would be a second bucket for the
// price of signing out.
ok("the lookup throttle keys on the IP", lookupKey("1.2.3.4") === "look:1.2.3.4");
ok("a missing IP still lands in one bucket, never an empty key", lookupKey("") === "look:0.0.0.0");

// ---------------------------------------------------------------------------
console.log("\n" + (fail ? "FAILED" : "PASSED") + " — " + pass + " checks passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
