/**
 * worker/bracelet.js — "bracelet-bible", the Cloudflare Worker behind the
 * bracelet calculator's lostark.bible import.
 *
 * FIRST PASS (2026-08-11). The import round trip, the consent gate, the KV
 * record store and the canonical-default scorer are real and finished. The
 * leaderboard snapshot is deliberately NOT built yet — see "WHAT IS STUBBED".
 *
 * ============================== WHY IT EXISTS ==============================
 *
 * `/api/oauth/rosters` is a roster INDEX; it carries no bracelet. The bracelet
 * lives in the SvelteKit hydration blob of a lostark.bible CHARACTER PAGE, and
 * a browser cannot read that page cross-origin (no CORS on the page routes).
 * So this Worker fetches the page server-side, pulls the bracelet out, scores
 * it, and answers JSON with a CORS allowlist for our own origins.
 *
 * ============================ THE CONSENT GATE =============================
 *
 * NON-NEGOTIABLE, and the thing to preserve through any later redesign:
 *
 *   A character is fetched, stored or ranked ONLY IF the caller is signed in to
 *   lostark.bible AND that character appears in THEIR OWN /api/oauth/rosters
 *   response.
 *
 * The caller sends their own `uwo_…` bearer token; this Worker calls
 * /api/oauth/rosters ITSELF with that token and checks the name is in it before
 * any page fetch happens. There is no name lookup, no enumeration and no
 * crawler anywhere in this file. Request volume is therefore bounded by real
 * signed-in humans clicking their own characters — the board is opt-in the way
 * lostark.bible's own is.
 *
 * The caller's token is used for the ownership check and (preferably) for the
 * page fetch, so every upstream request is attributable to a consenting human.
 * It is NEVER logged and NEVER stored: the roster cache is keyed by a SHA-256
 * of the token, and the queue stores no token at all (see enqueue()).
 *
 * ================================ ROUTES ===================================
 *
 *   OPTIONS *                                   CORS preflight
 *   GET  /                                      health + model signature
 *   GET  /character?name=&region=[&refresh=1][&publish=0]
 *                                               Bearer required. Verify → fetch
 *                                               → parse → score → store → return
 *                                               the decoded bracelet. This is the
 *                                               one route the import UI calls.
 *   GET  /bracelet?…                            alias of /character (the name used
 *                                               in docs/design/bible-import-fallback.md)
 *   POST /import   {characters:[…], publish?}   Bearer required. Same gate, in bulk:
 *                                               the first few are fetched inline,
 *                                               the rest are queued for the cron.
 *   POST /forget   {characters:[…]}|{all:true}  Bearer required. Removes the caller's
 *                                               OWN characters from the board.
 *   GET  /?list=1&fmt=2                         leaderboard snapshot — STUBBED, see below
 *   POST /admin/seed                            X-Admin-Token. Body = data/leaderboard-seed.json
 *   POST /admin/delete?region=&name=            X-Admin-Token. Takedown.
 *   GET  /admin/metrics                         X-Admin-Token. Counts + queue state.
 *   GET  /admin/page?name=&region=              X-Admin-Token. Raw parse probe: what the
 *                                               character page actually yielded. This is how
 *                                               the profile auto-fill map gets filled in
 *                                               without guessing at field names.
 *   cron * * * * *                              drain the queue (paced)
 *
 * ============================ WHAT IS STUBBED ==============================
 *
 * `?list=1` answers 501 with a note. The snapshot format (gzip bytes served with
 * encodeBody:"manual", compact tuples, dirty-gated incremental rebuild on a
 * BUILTAT throttle) is designed but NOT written here: Shizu paused it pending an
 * architecture doc read against the astrogem calculator. Everything that feeds
 * it is already in place — every stored record carries its canonical score, and
 * every write marks `lb:dirty:<key>` — so the rebuild is additive, not a rewrite.
 *
 * ================================ SCORING ==================================
 *
 * ONE source of truth, no copy: this file `import`s ../model/bracelet.js, which
 * wrangler's esbuild bundles (the model is a UMD that exports CommonJS under
 * Node/bundlers, and pulls ../data/*.js the same way). There is nothing to keep
 * in sync and nothing to verify — if the model changes, redeploying picks it up.
 *
 * Every score stored here is computed at the CANONICAL DEFAULT profile,
 * `normalizeProfile({})`. That is Shizu's rule: the board ranks everyone on the
 * same settings. The calculator tab may score the SAME bracelet on the user's
 * own imported profile; those are two different numbers and the code says which
 * is which. Nothing in this file ever reads a user-supplied profile.
 *
 * ================================ SECRETS ==================================
 *
 * Never in this file — the repo is public. Set with
 *   wrangler secret put <NAME> --config worker/wrangler.toml
 *
 *   BIBLE_TOKEN  the Bearer token lostark.bible's owners issued for this Worker.
 *                Used for the CRON DRAIN and as a fallback when a caller's own
 *                token cannot fetch a page. Live lookups prefer the caller's own.
 *   ADMIN_TOKEN  the admin credential, sent as the `X-Admin-Token` header.
 *                Fail-closed: while unset, nobody is admin.
 */

import Bracelet from "../model/bracelet.js";

// ---------------------------------------------------------------------------
// Origins, upstream, and the small shared helpers
// ---------------------------------------------------------------------------

// Exact-match CORS allowlist, never "*". Stamped ONCE in fetch() onto whatever
// the router returned, so no route can forget it. Requests with no Origin (curl,
// the cron) are server-to-server; CORS only constrains browsers, so they proceed
// with no CORS headers at all.
const ALLOW_ORIGINS = [
  "https://www.loseii.com",
  "https://loseii.com",
  "https://loastuff.pages.dev",
  "https://shizukaziye.github.io"
];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
function originAllowed(origin) {
  return ALLOW_ORIGINS.indexOf(origin) !== -1 || LOCAL_ORIGIN.test(origin);
}
function corsHeaders(origin) {
  if (!origin || !originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
    "Access-Control-Max-Age": "86400"
  };
}
function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {})
  });
}

const BIBLE = "https://lostark.bible";
const ROSTERS_URL = BIBLE + "/api/oauth/rosters";
// lostark.bible 403s default fetchers; a browser User-Agent gets 200. Same trick
// the astrogem Worker has used since 2026-07.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------------------
// KV key space (binding CHARS). One namespace, prefixed keys.
// ---------------------------------------------------------------------------

const CHAR_PREFIX  = "c:";          // c:<region>:<name lowercased> -> the character record
const ROSTER_PREFIX = "rk:";        // rk:<sha256(token) prefix>    -> the caller's verified roster, cached
const DIRTY_PREFIX = "lb:dirty:";   // lb:dirty:<char key>          -> "this record changed since the last snapshot"
const QUEUE_PREFIX = "q:";          // q:<char key>                 -> queued page fetch. VALUE holds the requester's
                                    //                                 token; METADATA never does (see enqueue).
const NOTFOUND_PREFIX = "nf:";      // nf:<char key>                -> short-lived "no such page", so a typo isn't refetched in a loop
const FB_PREFIX = "fb:";            // fb:<ts>-<rand6>              -> one feedback note (see §3.6)
const BUILTAT_KEY = "lb:builtat";   // ms the snapshot was last rebuilt — READ FIRST by the rebuild throttle
const LASTWRITE_KEY = "lb:lastwrite"; // ms of the most recent real lostark.bible pull

const CHAR_TTL_MS   = 7 * 24 * 60 * 60 * 1000;  // §2.3: a record is "fresh" for 7 days. Cached records are served at
                                                // ANY age and only LABELLED `stale` past this — never auto-refetched.
                                                // The Re-pull button (refresh=1) is the refresh path, deliberately.
const ROSTER_TTL_S  = 5 * 60;               // the ownership check costs one extra fetch per 5 min, not one per click
const NOTFOUND_TTL_S = 60 * 60;             // remember not-found for an hour; self-corrects if it was transient
const QUEUE_TTL_S   = 3 * 24 * 3600;        // a queued fetch expires after 3 days if never drained
const DIRTY_TTL_S   = 7 * 24 * 3600;        // safety net; the rebuild normally clears the marker

const IMPORT_MAX      = 24;    // characters accepted in one POST /import (a big roster, no more)

// ---------------------------------------------------------------------------
// Queue, drain and the circuit breaker
// ---------------------------------------------------------------------------

const Q_ORDER_KEY = "q:order";          // cron-maintained ordered queue snapshot: position/metrics read it
                                        // instead of paying a list(). An enqueue DELETES it.
const Q_ORDER_TTL_MS = 90 * 1000;       // trust the snapshot for 90s (rewritten every active drain minute)
const Q_ORDER_IDLE_TTL_MS = 10 * 60 * 1000; // an EMPTY snapshot short-circuits the whole cron drain for up to 10 min
                                        // -> one read per idle minute instead of a lock write + a list.
const DRAIN_LOCK_KEY = "drain:lock";    // serializes drains (cron + enqueue kicks) so two never double-fetch
const DRAIN_CONFIG_KEY = "drain:config";// { mode, drainPerMin, lastProbe, interval } — set by POST /admin/control
const DRAIN_LOG_KEY = "drain:log";      // rolling ~1h of per-run entries, for GET /admin/metrics
const DRAIN_LOG_MAX_MS = 60 * 60 * 1000;
const LASTFETCH_KEY = "drain:lastfetch";// ms of the last upstream CHARACTER PAGE fetch — the kick spaces itself off it
const USAGE_KEY = "usage:drained";      // { month:"YYYY-MM", count } — the monthly budget guard

const DRAIN_MODES = ["run", "off", "probe"];
const DRAIN_PER_MIN_DEFAULT = 10;       // §2.4: default 10/min…
const DRAIN_PER_MIN_MAX    = 20;        // …hard ceiling 20/min, because 60000/20 = 3000ms and…
const DRAIN_MIN_SPACING_MS = 3000;      // …THREE SECONDS BETWEEN PAGE FETCHES IS A CONSTRAINT, NOT A SETTING.
                                        // Shizu set it; every path that touches a character page — drain,
                                        // kick, import — honours it. Raising the rate cannot lower it: the
                                        // pace is max(DRAIN_MIN_SPACING_MS, 60000/rate).
const DRAIN_BUDGET_MS  = 50000;         // stop a run at ~50s so it never overruns the 60s cron
const PAUSE_FAIL_LIMIT = 5;             // consecutive transient failures that trip the breaker -> "probe"
const PAUSE_PROBE_FIRST_MS = 60 * 1000; // first re-probe ~1 min after tripping (catch a quick recovery)…
const PAUSE_PROBE_MAX_MS = 30 * 60 * 1000; // …then ×2 per failed probe, capped at 30 min. A long outage costs
                                        // a handful of requests instead of one a minute.
const MAX_FETCH_ATTEMPTS = 5;           // a queued item that fails this many times is DROPPED, so one
                                        // permanently-broken name can't sit at the head starving the rest
const MONTHLY_CHAR_BUDGET = 100000;     // characters cached per calendar month, hard stop. Deliberately well
                                        // under the account's 1M KV writes/month — which this Worker SHARES
                                        // with astrogem-bible, so it may not spend the whole budget alone.
const UNAVAILABLE_MSG = "Character lookups are temporarily unavailable";

// ---------------------------------------------------------------------------
// The leaderboard snapshot (ARCHITECTURE §1.2 / §2.5)
// ---------------------------------------------------------------------------

const SNAPSHOT_GZ_KEY = "lb:snapshot:gz";   // the SERVED payload: the §1.2 compact form, gzipped
const SNAPSHOT_SRC_KEY = "lb:chars:gz";     // the MUTATION source: the same characters as plain objects,
                                            // gzipped. The served form is index-packed against string
                                            // tables, so upserting one row into it means rebuilding the
                                            // tables; keeping the objects is cheaper than unpacking.
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000;  // Shizu's number: rebuild at most every 10 minutes
const REBUILD_CURSOR_KEY = "lb:rebuild:cursor";   // { c } — present while a from-scratch build is in flight
const REBUILD_ACC_KEY = "lb:rebuild:acc:gz";      // the rows accumulated so far, gzipped
const REBUILD_KEYS_PER_RUN = 750;                 // record reads per tick. Astrogem's UNCHUNKED version blew
                                                  // the ~1000-subrequest limit at ~5.5k characters, died every
                                                  // tick, and left its board permanently empty.
const PARSEVERSION_KEY = "lb:parseversion";       // bumped by POST /admin/rescore
const RESCORE_PER_CALL = 150;                     // records rescored per admin call (reads+writes stay <1000)

// ---------------------------------------------------------------------------
// Feedback (§3.6)
// ---------------------------------------------------------------------------

const FB_MSG_MAX = 2000, FB_TYPE_MAX = 40, FB_CONTACT_MAX = 80, FB_UA_MAX = 160;
const FB_TTL_S = 90 * 24 * 3600;   // 90 days. `contact` can hold PII and must not sit forever.
const FB_LIST_MAX = 200;           // newest notes the admin read returns — caps it at ≤200 gets

// ---------------------------------------------------------------------------
// Scoring — the CANONICAL DEFAULT profile, and nothing else
// ---------------------------------------------------------------------------

/**
 * THE LEADERBOARD PROFILE. Built once, at module scope, from the model's own
 * defaults. Every score this Worker writes uses it.
 *
 * Do not add a code path that scores on anything else. The calculator's
 * per-character profile lives in the browser (app.js buildProfile) and must
 * never reach a stored record — a leaderboard where each row is scored on its
 * owner's settings ranks nothing.
 */
const DEFAULT_PROFILE = Bracelet.normalizeProfile({});
const MODEL_SIG = Bracelet.MODEL_SIG + "@" + Bracelet.VERSION;

// decodeBibleBracelet names the Swiftness trait the way the official table does;
// the calculator's three trait rows call it "swift". Crit and Spec already agree.
const TRAIT_TO_APP = { crit: "crit", spec: "spec", swiftness: "swift" };

function slotChoices(grade) { return grade === "relic" ? [1, 2] : [2, 3]; }

/**
 * The decoder guesses Relic or Ancient by matching special-effect values against
 * both tables, and the tables overlap enough that it can land on the wrong one.
 * The granted-slot count is a second, independent witness: Ancient grants 2–3,
 * Relic 1–2. When the guess cannot hold the lines it just decoded and the other
 * grade can, RE-DECODE against that table — tiers have to come from the right
 * value table, so this is a re-run, not a relabel.
 *
 * Same logic as bible-import.js's decodeWithGradeCheck; the two are independent
 * on purpose (the client decodes for the calculator, this decodes for the board)
 * but they must agree, and both call the same model function to do it.
 */
function decodeWithGradeCheck(stats) {
  const dec = Bracelet.decodeBibleBracelet(stats);

  // THE TRAIT CAP OUTRANKS EVERYTHING. Relic combat traits stop at 100 and
  // Ancient at 120, so a bracelet showing Crit +116 cannot be Relic whatever the
  // slot count says. Four of the thirty seeded characters were coming out Relic
  // on exactly this — they lock four of five lines, which leaves one granted
  // line, which the slot rule below reads as Relic.
  if (traitsBreakCap(dec, dec.grade)) {
    const forced = dec.grade === "relic" ? "ancient" : "relic";
    const fdec = Bracelet.decodeBibleBracelet(stats, { grade: forced });
    if (!traitsBreakCap(fdec, forced)) return fdec;
  }

  let granted = 0;
  for (const l of dec.lines) if (!l.fixed) granted++;
  if (slotChoices(dec.grade).indexOf(granted) >= 0) return dec;
  const other = dec.grade === "relic" ? "ancient" : "relic";
  if (slotChoices(other).indexOf(granted) < 0) return dec;   // fits neither; leave the guess alone
  // The slot count is only ONE witness, and the weakest of the three. Refuse the
  // switch if the other grade cannot hold what this one held — either because a
  // trait sits above its cap, or because its value table cannot place a line
  // this one placed (Crit Damage +10% exists on Ancient and not on Relic). Seen
  // live on a chaos-dungeon loadout with four locked lines: the player locked
  // granted lines, so "1 granted" was a player's choice, not a Relic drop.
  const alt = Bracelet.decodeBibleBracelet(stats, { grade: other });
  if (traitsBreakCap(alt, other)) return dec;
  if (unplaced(alt) > unplaced(dec)) return dec;
  return alt;
}

/** Combat-trait caps: Relic 100, Ancient 120. A value above the cap rules the grade out. */
const TRAIT_CAP = { relic: 100, ancient: 120 };
function traitsBreakCap(dec, grade) {
  for (const l of dec.lines) if (l.cat === "trait" && l.value > TRAIT_CAP[grade]) return true;
  return false;
}

/** Lines the grade's value table could not place: no tier, or a value off the table. */
function unplaced(dec) {
  let n = 0;
  for (const l of dec.lines) if (l.cat === "special" && (!l.tier || l.unmatchedValue)) n++;
  return n;
}

/**
 * score(stats) — a raw lostark.bible `stats` array to the number the board ranks on.
 *
 * The split matters: a FIXED combat-trait line (Crit / Spec / Swiftness) is one
 * of the two trait lines the bracelet came with and scores through
 * traitDamage(); everything else — granted lines AND fixed effect lines — scores
 * through setDamage(). A trait rolled into a GRANTED slot scores zero, which is
 * the model's rule, not this file's.
 *
 * `pct` is the whole bracelet. `linesPct` is the effect lines alone, which is
 * the figure comparable to lostark.bible's own "Bracelet Effects +X%" and to the
 * 7–9% good / 10%+ near-final community benchmark.
 */
function score(stats) {
  const dec = decodeWithGradeCheck(stats);
  const traits = { crit: 0, spec: 0, swift: 0 };
  const lines = [];
  const traitLines = [];
  for (const l of dec.lines) {
    const key = TRAIT_TO_APP[l.family];
    if (l.fixed && l.cat === "trait" && key) {
      traits[key] = l.value;
      traitLines.push({ trait: l.family, value: l.value });
      continue;
    }
    lines.push(l);
  }
  const traitD = Bracelet.traitDamage(traits, DEFAULT_PROFILE);
  const linesD = Bracelet.setDamage(lines, dec.grade, DEFAULT_PROFILE);
  const D = traitD + linesD;
  return {
    grade: dec.grade,
    traits: traitLines,
    lines: lines.map(function (l) {
      const info = Bracelet.lineInfo(l, dec.grade, DEFAULT_PROFILE);
      return {
        cat: l.cat, family: info.family, label: info.label, tier: l.tier || null,
        value: info.value, fixed: !!l.fixed, damage: info.damage
      };
    }),
    D: D, pct: Bracelet.damagePercent(D),
    linesD: linesD, linesPct: Bracelet.damagePercent(linesD),
    granted: lines.filter(function (l) { return !l.fixed; }).length,
    // Lines the model's TYPE2_INDEX does not map yet (the seed found indices 4,
    // 74 and 151 in the wild). They score 0 and are reported, never silently
    // dropped — an unexplained gap on the board is worse than a visible one.
    unmapped: dec.unknown || [],
    profile: "canonical-default",
    modelSig: MODEL_SIG
  };
}

// ---------------------------------------------------------------------------
// Region, names, keys
// ---------------------------------------------------------------------------

// lostark.bible calls EU Central "CE". Accept the handful of spellings a roster
// payload might use and reject anything we cannot place, rather than guessing.
function normRegion(r) {
  const s = String(r || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "NA" || s === "NAE" || s === "NAW" || s === "US" || s === "NORTH AMERICA") return "NA";
  if (s === "CE" || s === "EU" || s === "EUC" || s === "EUROPE" ||
      s === "CENTRAL EUROPE" || s === "EU CENTRAL" || s === "EUROPE CENTRAL") return "CE";
  return "";
}
function charKey(region, name) { return CHAR_PREFIX + region.toUpperCase() + ":" + String(name).toLowerCase(); }

// Display name: Roman-script names get Title case; Hangul is left alone. The KV
// key is lowercased independently, so this only affects what the board shows.
function normalizeName(name) {
  if (!name) return name;
  if (/[가-힣㄰-㆏]/.test(name)) return name;
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const b = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function bearer(request) {
  const a = request.headers.get("Authorization") || "";
  return a.indexOf("Bearer ") === 0 ? a.slice(7).trim() : "";
}

async function kvGetJson(env, key) {
  if (!env || !env.CHARS) return null;
  try { const raw = await env.CHARS.get(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function markDirty(env, ck) {
  if (!env || !env.CHARS) return Promise.resolve();
  return env.CHARS.put(DIRTY_PREFIX + ck, "1", { expirationTtl: DIRTY_TTL_S }).catch(function () {});
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---------------------------------------------------------------------------
// Admin auth — fail closed, constant time, header only
// ---------------------------------------------------------------------------

/**
 * The admin credential is the ADMIN_TOKEN secret, sent as `X-Admin-Token`.
 * Rules, all learned the hard way on the astrogem Worker:
 *   - FAIL CLOSED. Secret unset -> nobody is admin.
 *   - Constant-time compare, so the token cannot be guessed a byte at a time.
 *   - Header only, never a query parameter: a URL leaks via logs and Referer.
 *   - Never gate anything with a value the client already ships (a hash in a JS
 *     file gates nothing — everyone reading the page source has it).
 */
function adminOk(request, env) {
  const secret = (env && env.ADMIN_TOKEN) || "";
  if (!secret) return false;
  const given = request.headers.get("X-Admin-Token") || "";
  const enc = new TextEncoder();
  const a = enc.encode(given), b = enc.encode(secret);
  if (a.byteLength !== b.byteLength) return false;   // timingSafeEqual needs equal lengths
  try {
    if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
      return crypto.subtle.timingSafeEqual(a, b);
    }
  } catch (e) { /* fall through */ }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// THE CONSENT GATE: does this token's own roster hold this character?
// ---------------------------------------------------------------------------

/**
 * /api/oauth/rosters names classes with the game's internal snake_case codes
 * ("devil_hunter_female"), not the English display names the character PAGE
 * badge carries ("Gunslinger"). Eight of these were verified by joining the live
 * roster against data/leaderboard-seed.json, which was read off the pages
 * themselves — see docs/research/oauth-rosters-shape.md.
 *
 * Used only as a FALLBACK: the page badge wins when the page parsed. It exists
 * so a character whose badge markup changed still shows a class on the board
 * instead of a blank cell.
 */
const ROSTER_CLASS = {
  // verified against real character pages
  arcana: "Arcanist",
  berserker: "Berserker",
  blade: "Deathblade",
  devil_hunter_female: "Gunslinger",
  dragon_knight: "Guardianknight",
  alchemist: "Wildsoul",
  reaper: "Reaper",
  soul_eater: "Souleater",
  // observed in the same payload, not yet cross-checked against a page badge
  bard: "Bard"
};
function classFromRoster(code) {
  if (!code) return null;
  const k = String(code).toLowerCase();
  if (ROSTER_CLASS[k]) return ROSTER_CLASS[k];
  // Unknown code: title-case it rather than dropping it. A visibly odd label
  // ("Devil Hunter Male") is a bug report; a blank cell is a shrug.
  return k.split("_").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
}

const CLASS_KEYS = ["class", "className", "characterClassName", "job", "jobName"];
const ILVL_KEYS = ["itemLevel", "ilvl", "itemMaxLevel", "gearScore", "level", "itemAvgLevel"];
const REGION_KEYS = ["region", "world", "server", "serverName", "worldName", "regionCode"];
const CONTAINER_KEYS = /^(characters|chars|members|roster|rosters)$/i;

function isObj(v) { return v && typeof v === "object"; }
function firstString(n, keys) {
  for (const k of keys) {
    const v = n[k];
    if (typeof v === "string" && v) return v;
    if (isObj(v) && typeof v.name === "string" && v.name) return v.name;
  }
  return "";
}
function firstNumber(n, keys) {
  for (const k of keys) {
    const v = n[k];
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && /^[\d.,]+$/.test(v)) return parseFloat(v.replace(/,/g, ""));
  }
  return null;
}
// A roster has a `name` too, so "has a name" alone would promote the roster
// itself to a character. Anything holding a list of characters is a container.
function isContainer(n) {
  for (const k in n) {
    if (CONTAINER_KEYS.test(k) && Array.isArray(n[k]) && n[k].length && isObj(n[k][0])) return true;
  }
  return false;
}

/**
 * Every character-looking node in a /api/oauth/rosters payload.
 *
 * SHAPE-BLIND ON PURPOSE. lostark.bible does not document this payload and, as
 * of 2026-08-11, nobody has run it with a live token (the probe needs a Discord
 * sign-in only Shizu can complete — docs/research/oauth-rosters-shape.md). So
 * nothing here keys off a field name it has not seen: a character is any object
 * with a string `name` plus a class or an item level, and the region is
 * inherited from the nearest ancestor that names one, because a roster payload
 * is far more likely to put the region on the ROSTER than on each character.
 *
 * This mirrors bible-import.js's findCharacters. When the real shape is written
 * down, both can be tightened; until then, being generous here is safe —
 * generous means "more names in YOUR OWN roster", never anyone else's.
 */
function collectRosterChars(payload) {
  const out = [], seen = {};
  (function rec(node, region, depth) {
    if (!isObj(node) || depth > 8) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 500; i++) rec(node[i], region, depth + 1);
      return;
    }
    const here = normRegion(firstString(node, REGION_KEYS)) || region;
    if (typeof node.name === "string" && node.name && !isContainer(node)) {
      const cls = firstString(node, CLASS_KEYS);
      const ilvl = firstNumber(node, ILVL_KEYS);
      if (cls || ilvl !== null) {                          // a bare {name} is a label, not a character
        const k = node.name.toLowerCase() + "|" + here;
        if (!seen[k]) {
          seen[k] = 1;
          out.push({ name: node.name, region: here, cls: cls || "", ilvl: ilvl });
        }
      }
    }
    for (const k in node) rec(node[k], here, depth + 1);
  })(payload, "", 0);
  return out;
}

/**
 * The caller's own roster, cached ~5 minutes so the gate costs one extra fetch
 * per session rather than two fetches per click.
 *
 * The cache KEY is a SHA-256 of the token, never the token. The cached VALUE is
 * the character list only — names, classes, item levels the user already agreed
 * to share with this page. The token itself is never written to KV by any path
 * in this file.
 *
 * Returns { ok, chars } or { ok:false, status, error }.
 */
async function callerRoster(env, token) {
  const kh = (await sha256hex(token)).slice(0, 32);
  const key = ROSTER_PREFIX + kh;
  const cached = await kvGetJson(env, key);
  if (cached && Array.isArray(cached.chars)) return { ok: true, chars: cached.chars, cached: true };

  let r;
  try {
    r = await fetch(ROSTERS_URL, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
    });
  } catch (e) {
    return { ok: false, status: 502, error: "roster_unreachable" };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 401, error: "bad_token" };
  if (!r.ok) return { ok: false, status: 502, error: "roster_http_" + r.status };
  let payload;
  try { payload = await r.json(); } catch (e) { return { ok: false, status: 502, error: "roster_not_json" }; }

  const chars = collectRosterChars(payload);
  if (env && env.CHARS) {
    try { await env.CHARS.put(key, JSON.stringify({ chars: chars, at: Date.now() }), { expirationTtl: ROSTER_TTL_S }); }
    catch (e) { /* cache failure is not fatal — the gate still ran */ }
  }
  return { ok: true, chars: chars, cached: false };
}

/**
 * Is (region, name) on this roster?
 *
 * Region handling is the one soft edge and it is deliberate: if the roster names
 * a region for that character we REQUIRE it to match, but if the payload carries
 * no region at all (a live possibility while the shape is unknown) we accept the
 * caller's region and flag `regionVerified:false` on the record. The gate that
 * matters — "this name is on YOUR roster" — is never relaxed. Tighten this the
 * day the real payload is written down.
 */
function ownsCharacter(chars, region, name) {
  const n = String(name).toLowerCase(), r = normRegion(region);
  let sawName = false, meta = null;
  for (const c of chars) {
    if (c.name.toLowerCase() !== n) continue;
    sawName = true;
    if (!c.region) { meta = meta || c; continue; }         // roster gave no region: keep as a soft match
    if (c.region === r) return { ok: true, regionVerified: true, meta: c };
  }
  if (meta) return { ok: true, regionVerified: false, meta: meta };
  return { ok: false, sawName: sawName };
}

/** Bearer + roster in one step. Returns { ok, chars } or a ready-made error Response. */
async function requireOwner(env, request) {
  const token = bearer(request);
  if (!token) {
    return { resp: json({ error: "not_signed_in", message: "Sign in with lostark.bible first — this endpoint only reads characters on your own roster." }, 401) };
  }
  const roster = await callerRoster(env, token);
  if (!roster.ok) {
    if (roster.error === "bad_token") {
      return { resp: json({ error: "bad_token", message: "lostark.bible rejected that sign-in. Sign in again." }, 401) };
    }
    return { resp: json({ error: roster.error, message: "Could not read your roster from lostark.bible just now. Try again in a minute." }, 502) };
  }
  return { token: token, chars: roster.chars, cachedRoster: roster.cached };
}

// ---------------------------------------------------------------------------
// The character page: fetch, then find the bracelet in the hydration blob
// ---------------------------------------------------------------------------

/**
 * Every `slot:"bracelet"` payload on the page, in document order.
 *
 * WAS WRONG UNTIL 2026-08-11: this used to say the blob repeats the equipment
 * block "raid first, then chaos", and the caller took hit #0 as the raid
 * bracelet. Document order is not fixed — across the 30 saved pages the chaos
 * loadout comes first on 16 of them — so hit #0 was the chaos bracelet about
 * half the time. That is the "wrong bracelet" bug. Use extractLoadouts() below,
 * which reads the loadouts array and knows which bracelet belongs to which tab.
 * This function survives as the last-ditch fallback for a page whose loadouts
 * array cannot be parsed.
 *
 * Parsed by brace-scanning the `data:{…}` object and quoting its bare keys
 * before JSON.parse, the same technique astrogem-bible.js uses for
 * arkGridCores; a flat regex cannot be trusted with an object whose field order
 * is not guaranteed.
 *
 * Known limit: the brace scan would be fooled by a `{` or `}` inside a string
 * value. Nothing in a bracelet payload carries one today (the only strings are
 * `"bracelet"` and the slot name), and a failed parse is skipped rather than
 * crashing the request.
 */
function extractBracelets(html) {
  const out = [];
  const marker = 'slot:"bracelet"';
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    const dat = html.indexOf("data:{", at);
    if (dat === -1 || dat - at > 200) continue;            // the data object belongs to some other slot
    const start = dat + "data:".length;
    let depth = 0, end = -1;
    for (let k = start; k < html.length; k++) {
      const c = html[k];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    if (end === -1) break;
    const jsonish = html.slice(start, end)
      .replace(/([{,[])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
    let parsed = null;
    try { parsed = JSON.parse(jsonish); } catch (e) { parsed = null; }
    if (parsed && Array.isArray(parsed.stats)) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loadouts
// ---------------------------------------------------------------------------

/**
 * A character page carries ONE LOADOUT PER TAB on lostark.bible, and each has
 * its own `items` array — so each can hold a DIFFERENT bracelet. The tabs seen
 * on the 30 saved pages, with the button label bible prints for each:
 *
 *   most_recent_raid           "Raid Loadout"
 *   most_recent_chaos_dungeon  "Current Loadout (Chaos Dungeon)"
 *   raid_merged                "Estimated Raid Loadout"
 *
 * The list is treated as OPEN: an unknown classification is kept and shown under
 * its own name rather than dropped.
 *
 * Nine of those 30 characters wear a different bracelet in different loadouts,
 * and the gap reaches 3.4 percentage points of damage, so which one you read is
 * not a detail. The page's own bracelet tooltip draws the loadout with the
 * newest `lastUpdated` — on all 30 pages, without exception — which is the chaos
 * one whenever the player ran chaos after their last raid.
 */
const LOADOUT_LABELS = {
  most_recent_raid: "Raid",
  most_recent_chaos_dungeon: "Chaos",
  raid_merged: "Est. Raid"
};

function loadoutLabel(classification) {
  if (LOADOUT_LABELS[classification]) return LOADOUT_LABELS[classification];
  return String(classification || "Loadout")
    .replace(/^most_recent_/, "").replace(/_/g, " ")
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

/** Index of the matching close bracket for the open bracket at `start`. String-aware. */
function matchSpan(s, start) {
  let depth = 0, quote = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split "[{…},{…}]" into its depth-1 element sources. */
function splitTop(arraySrc) {
  const out = [];
  let depth = 0, quote = null, start = -1;
  for (let i = 0; i < arraySrc.length; i++) {
    const c = arraySrc[i];
    if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{" || c === "[") { if (depth === 1 && c === "{") start = i; depth++; }
    else if (c === "}" || c === "]") { depth--; if (depth === 1 && c === "}" && start >= 0) { out.push(arraySrc.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

/** The source text of one depth-1 field of an object source. Tolerant of key order. */
function field(objSrc, key) {
  const m = objSrc.match(new RegExp("[{,]" + key + ":"));
  if (!m) return null;
  const at = m.index + m[0].length, c = objSrc[at];
  if (c === "{" || c === "[") { const e = matchSpan(objSrc, at); return e === -1 ? null : objSrc.slice(at, e + 1); }
  let end = at, depth = 0, quote = null;
  for (; end < objSrc.length; end++) {
    const ch = objSrc[end];
    if (quote) { if (ch === "\\") { end++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"') { quote = ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { if (depth === 0) break; depth--; }
    else if (ch === "," && depth === 0) break;
  }
  return objSrc.slice(at, end);
}

function unquote(s) { return s == null ? null : String(s).replace(/^"|"$/g, ""); }
function numOrNull(s) { const n = s == null ? NaN : Number(unquote(s)); return isFinite(n) ? n : null; }

/** The bracelet payload inside one loadout source, or null when the slot is empty. */
function braceletInLoadout(loadoutSrc) {
  const items = field(loadoutSrc, "items");
  if (!items) return null;
  const els = splitTop(items);
  for (let i = 0; i < els.length; i++) {
    if (els[i].indexOf('slot:"bracelet"') === -1) continue;
    const data = field(els[i], "data");
    if (!data || data[0] !== "{") return null;            // `data: void 0` — nothing equipped
    const jsonish = data.replace(/([{,[])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
    let parsed = null;
    try { parsed = JSON.parse(jsonish); } catch (e) { return null; }
    return parsed && Array.isArray(parsed.stats) ? parsed : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The LEFT COLUMN — everything the control deck's gear panel holds
// ---------------------------------------------------------------------------

/**
 * The calculator's left column is not just item level. It is six honing levels,
 * a necklace additional-damage line, two earring weapon-power lines, one gem
 * level, a 9/7 ability stone and the Master ark-passive node — and every one of
 * them is on the character page, inside the SAME loadout object the bracelet
 * came from. parseCharacterProfile() below reads all of it.
 *
 * Where each field lives, all of it confirmed against 59 saved pages
 * (117 loadouts) rather than assumed:
 *
 *   HONING      items[].data {type:"equipment", honing, advancedHoning}. Six
 *               slots, page names on the left, deck names on the right:
 *               weapon·head·shoulder pass through; upper_body=chest,
 *               lower_body=pants, hand=gloves. `honing` is the exact +N (12…25
 *               across the corpus). `advancedHoning` is the Aegir track and the
 *               deck has no control for it, so it is reported, never applied.
 *
 *   ACCESSORY   items[neck|ear1|ear2].data.stats[]. Accessory stats carry a
 *   LINES       `base` flag; the ROLLED grinding lines are `base:false` (the
 *               bracelet's own stats use `fixed` instead — that is the
 *               structural discriminator between the two). Index 50 on the neck
 *               is Additional Damage and index 152 on an earring is Weapon
 *               Power, both in centi-percent. The corpus holds exactly
 *               {70,160,260} and {80,180,300}, i.e. the deck's own segmented
 *               options 0.7/1.6/2.6 and 0.8/1.8/3 — so the snap below is a
 *               guard, not a routine approximation. Index 49 (crit rate) and
 *               151/124/27/28/34/106 are the other rolled lines; the deck has
 *               no control for them.
 *
 *   GEMS        loadout.gems[] {slot, id, effects[]}. The level is NOT reliably
 *               decodable from the id — the 6503x/6504x families encode it in
 *               digits 6-7 but the 6509x family does not — so read the gem's
 *               attack-power effect instead: {type:2, id:150, value}, in
 *               centi-percent, one per gem. 45→lv6, 60→lv7, 80→lv8, 100→lv9,
 *               120→lv10, checked against the "Lv. N" the page prints. The deck
 *               has ONE gem slider, so the MODAL level is what it gets and the
 *               whole spread rides along in gemLevels[] for the note.
 *
 *   9/7 STONE   items[slot="ability_stone"].data.engravings[] {id, nodes}.
 *               Three engravings, always. "9/7" is the two damage engravings at
 *               9 and 7 nodes, so the toggle goes on when the top two node
 *               counts clear 9 and 7 — a 9/8 or 10/7 stone is a 9/7 or better
 *               and counts.
 *
 *   MASTER      loadout.arkPassive.evolution[] {id, level}. The node ids are
 *               opaque, but the page also RENDERS the same list by name, in the
 *               same order, under its "Evolution" heading — so aligning the two
 *               across all 59 pages names every id. Master is 1032200
 *               (unanimous, 15 of 59 characters have it; its tier-4 neighbours
 *               are 1032100 Critical and 1032300 Pulverize).
 *
 * NOT ON THE PAGE, and therefore never emitted:
 *
 *   mainStat / weaponPower as the deck means them — its two override fields are
 *   RAW, before the main-stat and weapon-power percentage buckets. The page
 *   carries battlePoint.parts[0].{mainStat,weaponPower}, which are the TOTALS
 *   after those buckets; handing them over would double-count ~9% and would
 *   flip the override switch that hides the six honing sliders we just filled
 *   exactly. They ride in `raw` under their honest names instead.
 *
 *   critRate / critDamage. lostark.bible prints neither for the character; the
 *   only "Crit Rate" strings on the page belong to accessory and elixir lines.
 */

// page slot -> deck path under `gear`
const GEAR_SLOTS = {
  weapon: "weapon", head: "head", shoulder: "shoulder",
  upper_body: "chest", lower_body: "pants", hand: "gloves"
};
const GEAR_PIECES = ["head", "shoulder", "chest", "pants", "gloves", "weapon"];

const ACC_ADD_DAMAGE = 50;        // neck, centi-%
const ACC_WEAPON_POWER = 152;     // earring, centi-%
const NECK_OPTIONS = [0, 0.7, 1.6, 2.6];
const EAR_OPTIONS = [0, 0.8, 1.8, 3];

// A gem's attack-power effect -> its level. The effect is {type:2, id:150}.
const GEM_AP_LEVEL = { 45: 6, 60: 7, 80: 8, 100: 9, 120: 10 };

const MASTER_NODE_ID = 1032200;   // Ark Passive · Evolution · T4 · "Master"

/** The nearest legal option, for a value the page could in principle drift off. */
function snapTo(options, v) {
  let best = options[0], d = Infinity;
  for (let i = 0; i < options.length; i++) {
    const dd = Math.abs(options[i] - v);
    if (dd < d) { d = dd; best = options[i]; }
  }
  return best;
}

/** The rolled (`base:false`) stat lines of one accessory `data` source. */
function rolledAccessoryLines(dataSrc) {
  const stats = field(dataSrc, "stats");
  if (!stats || stats[0] !== "[") return [];
  const out = [];
  const els = splitTop(stats);
  for (let i = 0; i < els.length; i++) {
    if (field(els[i], "base") !== "false") continue;      // base:true is the accessory's own stat block
    out.push({
      type: numOrNull(field(els[i], "type")),
      index: numOrNull(field(els[i], "index")),
      value: numOrNull(field(els[i], "value"))
    });
  }
  return out;
}

/** The centi-% value of one rolled index on an accessory, or null. */
function rolledLine(dataSrc, index) {
  const lines = rolledAccessoryLines(dataSrc);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === 2 && lines[i].index === index) return lines[i].value;
  }
  return null;
}

/** The most common value in a list; ties fall to the highest. */
function modal(list) {
  const count = {};
  let best = null, bestN = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    count[v] = (count[v] || 0) + 1;
    if (count[v] > bestN || (count[v] === bestN && v > best)) { best = v; bestN = count[v]; }
  }
  return best;
}

/** "9,9,9,10,9" — a spread, printed the way the provenance note wants it. */
function spreadText(list) {
  const sorted = list.slice().sort(function (a, b) { return b - a; });
  return sorted.join(",");
}

/**
 * Everything the deck's left column can honestly hold, read off ONE loadout.
 *
 *   parseCharacterProfile(html)              the first loadout on the page
 *   parseCharacterProfile(html, loadoutSrc)  that loadout's source text
 *
 * EVERY FIELD IS OPTIONAL. A field that could not be read is absent, never a
 * guess and never a default — a missing honing level leaves the deck's own
 * item-level derivation in place, which is the honest fallback.
 *
 * `raw` carries the unsnapped, uncollapsed readings, so the UI can say what it
 * actually saw ("read 2.60% from the neck", "gems are 10,10,9,… — set to 10")
 * rather than only what it set.
 */
function parseCharacterProfile(html, loadoutSrc) {
  let src = loadoutSrc;
  if (!src) {
    const at = html.indexOf("loadouts:[");
    if (at !== -1) {
      const arrAt = html.indexOf("[", at);
      const end = matchSpan(html, arrAt);
      if (end !== -1) src = splitTop(html.slice(arrAt, end + 1))[0] || null;
    }
  }
  if (!src) return null;

  const out = { raw: {}, missing: [] };

  // ---- item level, class, combat power -------------------------------------
  const ilvl = numOrNull(field(src, "itemLevel"));
  if (ilvl != null) out.itemLevel = ilvl;
  const classId = unquote(field(src, "classId"));
  if (classId) out.classId = classId;
  const cp = field(src, "combatPower");
  if (cp && cp[0] === "{") {
    const sc = numOrNull(field(cp, "score"));
    if (sc != null) out.combatPower = sc;
  }
  const ap = field(src, "apPoints");
  if (ap && ap[0] === "{") {
    out.apPoints = {
      enlightenment: numOrNull(field(ap, "enlightenment")),
      evolution: numOrNull(field(ap, "evolution")),
      leap: numOrNull(field(ap, "leap"))
    };
  }

  // ---- one pass over items: honing, accessories, the stone ------------------
  const itemsSrc = field(src, "items");
  const honing = {}, advanced = {};
  let neckData = null, ear1Data = null, ear2Data = null, stoneSrc = null;
  if (itemsSrc && itemsSrc[0] === "[") {
    const els = splitTop(itemsSrc);
    for (let i = 0; i < els.length; i++) {
      const slot = unquote(field(els[i], "slot"));
      if (!slot) continue;
      const data = field(els[i], "data");
      if (!data || data[0] !== "{") continue;             // `data: void 0` — empty slot
      if (GEAR_SLOTS[slot]) {
        const h = numOrNull(field(data, "honing"));
        if (h != null) honing[GEAR_SLOTS[slot]] = h;
        const a = numOrNull(field(data, "advancedHoning"));
        if (a != null) advanced[GEAR_SLOTS[slot]] = a;
      } else if (slot === "neck") neckData = data;
      else if (slot === "ear1") ear1Data = data;
      else if (slot === "ear2") ear2Data = data;
      else if (slot === "ability_stone") stoneSrc = data;
    }
  }

  let honingCount = 0;
  for (let i = 0; i < GEAR_PIECES.length; i++) if (honing[GEAR_PIECES[i]] != null) honingCount++;
  if (honingCount) {
    out.honing = honing;
    out.raw.honingPieces = honingCount;
    if (honingCount < GEAR_PIECES.length) out.missing.push("honing:" + (GEAR_PIECES.length - honingCount));
  } else out.missing.push("honing");
  for (const k in advanced) { out.advancedHoning = advanced; break; }

  // ---- the necklace's additional damage, the earrings' weapon power ---------
  const neckRaw = neckData ? rolledLine(neckData, ACC_ADD_DAMAGE) : null;
  if (neckRaw != null) {
    out.raw.neckAddDmg = neckRaw / 100;
    out.neckAddDmg = snapTo(NECK_OPTIONS, neckRaw / 100);
  } else if (neckData) {
    // The necklace is there and simply has no additional-damage line: that is a
    // reading of 0%, not a failure to read.
    out.raw.neckAddDmg = 0;
    out.neckAddDmg = 0;
  } else out.missing.push("neck");

  const earPairs = [["earring1Wp", ear1Data], ["earring2Wp", ear2Data]];
  for (let i = 0; i < earPairs.length; i++) {
    const key = earPairs[i][0], data = earPairs[i][1];
    if (!data) { out.missing.push(key); continue; }
    const v = rolledLine(data, ACC_WEAPON_POWER);
    const pct = v == null ? 0 : v / 100;
    out.raw[key] = pct;
    out[key] = snapTo(EAR_OPTIONS, pct);
  }

  // ---- the 9/7 stone -------------------------------------------------------
  if (stoneSrc) {
    const eng = field(stoneSrc, "engravings");
    if (eng && eng[0] === "[") {
      const els = splitTop(eng), nodes = [];
      for (let i = 0; i < els.length; i++) {
        const n = numOrNull(field(els[i], "nodes"));
        if (n != null) nodes.push(n);
      }
      nodes.sort(function (a, b) { return b - a; });
      if (nodes.length >= 2) {
        out.raw.stoneNodes = nodes;
        out.stone97 = nodes[0] >= 9 && nodes[1] >= 7;
      } else out.missing.push("stone");
    } else out.missing.push("stone");
  } else out.missing.push("stone");

  // ---- the gems ------------------------------------------------------------
  const gemsSrc = field(src, "gems");
  if (gemsSrc && gemsSrc[0] === "[") {
    const els = splitTop(gemsSrc), levels = [];
    let unreadable = 0;
    for (let i = 0; i < els.length; i++) {
      const effects = field(els[i], "effects");
      let lv = null;
      if (effects && effects[0] === "[") {
        const fx = splitTop(effects);
        for (let j = 0; j < fx.length; j++) {
          if (numOrNull(field(fx[j], "type")) !== 2) continue;
          if (numOrNull(field(fx[j], "id")) !== 150) continue;
          const v = numOrNull(field(fx[j], "value"));
          if (v != null && GEM_AP_LEVEL[v]) lv = GEM_AP_LEVEL[v];
          break;
        }
      }
      if (lv == null) unreadable++; else levels.push(lv);
    }
    if (levels.length) {
      out.gemLevels = levels;
      out.gemLevel = modal(levels);
      out.raw.gemCount = levels.length + unreadable;
      out.raw.gemSpread = spreadText(levels);
      out.raw.gemMixed = levels.length > 1 && Math.min.apply(null, levels) !== Math.max.apply(null, levels);
      if (unreadable) out.raw.gemsUnreadable = unreadable;
    } else if (els.length) {
      // A whole set of gems with no attack-power effect — the pre-T4 family.
      // Reading nothing is right; guessing a level would move the whole attack
      // power bucket.
      out.missing.push("gems");
      out.raw.gemsUnreadable = els.length;
    } else out.missing.push("gems");
  } else out.missing.push("gems");

  // ---- Master ---------------------------------------------------------------
  const arkSrc = field(src, "arkPassive");
  if (arkSrc && arkSrc[0] === "{") {
    const evo = field(arkSrc, "evolution");
    if (evo && evo[0] === "[") {
      const els = splitTop(evo), ids = [];
      for (let i = 0; i < els.length; i++) {
        const id = numOrNull(field(els[i], "id"));
        if (id != null) ids.push(id);
      }
      out.master = ids.indexOf(MASTER_NODE_ID) !== -1;
      out.raw.evolutionNodes = ids.length;
    } else out.missing.push("master");
  } else out.missing.push("master");

  // ---- the two numbers the page has but the deck cannot take ----------------
  const bp = field(src, "battlePoint");
  if (bp && bp[0] === "{") {
    const parts = field(bp, "parts");
    if (parts && parts[0] === "[") {
      const els = splitTop(parts);
      for (let i = 0; i < els.length; i++) {
        if (numOrNull(field(els[i], "type")) !== 1) continue;
        const ms = numOrNull(field(els[i], "mainStat"));
        const wp = numOrNull(field(els[i], "weaponPower"));
        // TOTALS, after the % buckets — see the header. Named so no reader can
        // mistake them for the deck's raw override pair.
        if (ms != null) out.raw.mainStatTotal = ms;
        if (wp != null) out.raw.weaponPowerTotal = wp;
        break;
      }
    }
  }

  if (!out.missing.length) delete out.missing;
  return out;
}

/**
 * Every loadout on the page that has a bracelet, newest-rendered flagged.
 * Returns [] when the loadouts array is absent or unparseable, which is the
 * caller's cue to fall back to extractBracelets().
 */
function extractLoadouts(html) {
  const at = html.indexOf("loadouts:[");
  if (at === -1) return [];
  const arrAt = html.indexOf("[", at);
  const end = matchSpan(html, arrAt);
  if (end === -1) return [];
  const out = [];
  const srcs = splitTop(html.slice(arrAt, end + 1));
  for (let i = 0; i < srcs.length; i++) {
    const br = braceletInLoadout(srcs[i]);
    if (!br) continue;
    const classification = unquote(field(srcs[i], "classification")) || "loadout";
    out.push({
      classification: classification,
      label: loadoutLabel(classification),
      itemLevel: numOrNull(field(srcs[i], "itemLevel")),
      lastUpdated: numOrNull(field(srcs[i], "lastUpdated")),
      // The left column BELONGS TO THE LOADOUT, not to the character: a chaos
      // loadout can wear different accessories and different gems from the raid
      // one, so each pill carries its own.
      profile: parseCharacterProfile(html, srcs[i]),
      stats: br.stats,
      numRerolls: typeof br.numRerolls === "number" ? br.numRerolls : null,
      numTicketRerolls: typeof br.numTicketRerolls === "number" ? br.numTicketRerolls : null
    });
  }
  // The tooltip the page draws belongs to the newest loadout — say which, so a
  // reader comparing our numbers against the page knows where to look.
  let newest = -1;
  for (let i = 0; i < out.length; i++) if (newest < 0 || (out[i].lastUpdated || 0) > (out[newest].lastUpdated || 0)) newest = i;
  for (let i = 0; i < out.length; i++) out[i].isRendered = (i === newest);
  return out;
}

/**
 * The per-loadout score, cut down to what a pill needs. The full line-by-line
 * breakdown only ever ships for the CHOSEN bracelet (as `defaultScore`); every
 * other loadout carries its stats, which the client decodes itself when picked.
 * Keeps the KV record — one per character — from growing by a whole score
 * object per tab.
 */
function briefScore(s) {
  return { grade: s.grade, pct: s.pct, linesPct: s.linesPct, granted: s.granted, unmapped: s.unmapped.length };
}

/**
 * Which loadout does the board rank? Shizu's rule: the HIGHEST one. Ties (two
 * loadouts holding the same bracelet, which is the common case) fall to the one
 * bible draws, then to raid > est. raid > chaos, then to the newest.
 */
const LOADOUT_ORDER = { most_recent_raid: 0, raid_merged: 1, most_recent_chaos_dungeon: 2 };
function pickBestLoadout(loadouts) {
  const rank = function (c) { return LOADOUT_ORDER[c] == null ? 9 : LOADOUT_ORDER[c]; };
  let best = 0;
  for (let i = 1; i < loadouts.length; i++) {
    const a = loadouts[best], b = loadouts[i];
    const cmp = (b.score.linesPct - a.score.linesPct) || (b.score.pct - a.score.pct) ||
      ((b.isRendered ? 1 : 0) - (a.isRendered ? 1 : 0)) ||
      (rank(a.classification) - rank(b.classification)) ||
      ((b.lastUpdated || 0) - (a.lastUpdated || 0));
    if (cmp > 0) best = i;
  }
  return best;
}

// Advanced classes, as lostark.bible renders them in the profile badge. Copied
// from astrogem-bible.js, which anchored the list against live pages.
const CLASS_NAMES = ["Berserker","Destroyer","Gunlancer","Paladin","Slayer","Valkyrie","Arcanist","Summoner","Bard","Sorceress","Wardancer","Scrapper","Soulfist","Glaivier","Striker","Breaker","Deathblade","Shadowhunter","Reaper","Souleater","Sharpshooter","Deadeye","Artillerist","Machinist","Gunslinger","Aeromancer","Wildsoul","Artist","Guardianknight"];

/** Item level and class from the page — the two board columns beyond the score. */
function parseMeta(html) {
  let itemLevel = null, klass = null;
  const im = html.match(/ilvl:(\d+)/);
  if (im) itemLevel = parseInt(im[1], 10);
  const re = /bg-neutral-900 px-2 py-1 text-sm">([^<]+)<\/p>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (CLASS_NAMES.indexOf(m[1]) !== -1) { klass = m[1]; break; }
  }
  return { itemLevel: itemLevel, klass: klass };
}

/**
 * Fetch one character page and parse it. Returns { ok:true, data } or
 * { ok:false, status, error, message }.
 *
 * `userToken` is the caller's own OAuth token when a human is driving; the cron
 * drain has no human, so it falls back to the BIBLE_TOKEN secret. Either way the
 * page request carries a Bearer token, which is the condition lostark.bible's
 * owners set (2026-07-22) — a tokenless request 401s.
 */
async function fetchCharacterPage(env, region, name, userToken) {
  const url = BIBLE + "/character/" + encodeURIComponent(region) + "/" + encodeURIComponent(name);
  const headers = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BIBLE + "/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1"
  };
  const tok = userToken || (env && env.BIBLE_TOKEN) || "";
  if (tok) headers["Authorization"] = "Bearer " + tok;

  let resp;
  try {
    // TIMEOUT EVERY UPSTREAM FETCH. Astrogem has no timeout anywhere, and one hung
    // connection there eats the entire 50s drain budget — a single slow character
    // costs every character behind it. Ten seconds is generous for an HTML page.
    resp = await fetch(url, { headers: headers, redirect: "follow", signal: AbortSignal.timeout(10000) });
  }
  catch (e) { return { ok: false, status: 502, error: "upstream_unreachable", message: "lostark.bible did not answer.", upstreamStatus: 0 }; }

  if (resp.status === 404) {
    return { ok: false, status: 404, error: "no_such_character", message: "lostark.bible has no page for that character.", upstreamStatus: 404 };
  }
  if (!resp.ok) {
    const authIssue = resp.status === 401 || resp.status === 403;
    // `upstreamStatus` is the REAL lostark.bible status behind our 502, and the drain
    // classifies on it: 401/403 is one dead token (drop the item), any other 4xx is a
    // site-wide block (trip the breaker). Collapsing both to "502" loses that distinction.
    return { ok: false, status: 502, error: "upstream_" + resp.status,
      message: "lostark.bible returned HTTP " + resp.status + "." +
        (authIssue ? " That usually means the BIBLE_TOKEN secret is missing or stale." : ""),
      authIssue: authIssue || undefined, upstreamStatus: resp.status };
  }

  const html = await resp.text();
  const meta = parseMeta(html);

  // Loadout-aware first. Every loadout is scored, because the board must rank a
  // character's BEST bracelet and the panel must be able to offer the others.
  let loadouts = extractLoadouts(html);
  for (const l of loadouts) l.score = briefScore(score(l.stats));

  if (!loadouts.length) {
    // No parseable loadouts array — fall back to raw document order and say so,
    // so a shape change upstream shows up as a flag rather than as silence.
    const brs = extractBracelets(html);
    if (!brs.length) {
      return { ok: false, status: 404, error: "no_bracelet",
        message: "That character's page loaded, but no bracelet is equipped on it.",
        meta: meta };
    }
    loadouts = brs.map(function (b, i) {
      return {
        classification: "unknown_" + i, label: "Loadout " + (i + 1),
        itemLevel: null, lastUpdated: null, isRendered: i === 0,
        stats: b.stats,
        numRerolls: typeof b.numRerolls === "number" ? b.numRerolls : null,
        numTicketRerolls: typeof b.numTicketRerolls === "number" ? b.numTicketRerolls : null,
        score: briefScore(score(b.stats))
      };
    });
    loadouts.loadoutsUnparsed = true;
  }

  const bestIdx = pickBestLoadout(loadouts);
  const b = loadouts[bestIdx];
  return { ok: true, data: {
    region: region,
    name: normalizeName(name),
    class: meta.klass,
    itemLevel: meta.itemLevel,
    stats: b.stats,
    numRerolls: b.numRerolls,
    numTicketRerolls: b.numTicketRerolls,
    /* Every loadout that carries a bracelet, and which one the board took.
       `loadouts` used to be a COUNT; it is now the list. Any reader that just
       checked its length keeps working. */
    loadouts: loadouts,
    chosenLoadout: bestIdx,
    chosenClassification: b.classification,
    // ARCHITECTURE §1.1 — the grader auto-fill block, for the CHOSEN loadout.
    // Each loadout carries its own copy too; this one is the default the client
    // uses before the user clicks a different pill.
    profile: b.profile || null,
    source: "lostark.bible",
    url: url
  } };
}

// ---------------------------------------------------------------------------
// Store one character
// ---------------------------------------------------------------------------

/**
 * Fetch (or reuse) one character and write the record.
 *
 * - Cache hit inside CHAR_TTL_MS and no ?refresh -> the stored record, cached:true.
 * - Otherwise fetch fresh, score at the canonical default, store, mark dirty.
 * - STALE ON ERROR: lostark.bible rate-limits Cloudflare egress IPs, so a fetch
 *   can fail while the same page loads fine from a home connection. An old record
 *   beats an error every time; the response says `stale:true` so the UI can
 *   caveat it.
 *
 * `publish` decides whether the record is board-visible. Reading your own
 * bracelet into the calculator and putting yourself on a public board are two
 * different consents, so they are two different flags.
 */
async function loadCharacter(env, region, name, opts) {
  opts = opts || {};
  const key = charKey(region, name);

  if (env && env.CHARS && !opts.refresh) {
    const nf = await env.CHARS.get(NOTFOUND_PREFIX + key);
    if (nf) return { ok: false, status: 404, body: { error: "no_such_character", message: "lostark.bible has no page for that character." } };
  }

  let stale = null;
  if (env && env.CHARS) {
    const rec = await kvGetJson(env, key);
    if (rec && typeof rec.pulledAt === "number") {
      const fresh = (Date.now() - rec.pulledAt) < CHAR_TTL_MS;
      // A record stored before a model change carries a stale score; re-score it
      // in place rather than serving a number the current model would not produce.
      if (fresh && rec.modelSig !== MODEL_SIG && Array.isArray(rec.stats)) {
        rec.score = score(rec.stats);
        // Every loadout carries its own score, and a pill showing a number the
        // current model would not produce is worse than no pill.
        if (Array.isArray(rec.loadouts)) {
          for (const l of rec.loadouts) if (Array.isArray(l.stats)) l.score = briefScore(score(l.stats));
        }
        rec.modelSig = MODEL_SIG;
        rec.scoredAt = Date.now();
        try { await env.CHARS.put(key, JSON.stringify(rec)); await markDirty(env, key); } catch (e) {}
      }
      if (fresh && !opts.refresh) {
        if (opts.publish && !rec.published) {
          rec.published = true;
          try { await env.CHARS.put(key, JSON.stringify(rec)); await markDirty(env, key); } catch (e) {}
        }
        return { ok: true, record: rec, cached: true };
      }
      stale = rec;
    }
  }

  const res = await fetchCharacterPage(env, region, name, opts.token);
  if (!res.ok) {
    if (res.error === "no_such_character" && env && env.CHARS) {
      try { await env.CHARS.put(NOTFOUND_PREFIX + key, "1", { expirationTtl: NOTFOUND_TTL_S }); } catch (e) {}
    }
    if (stale) {
      // SERVE STALE ON ERROR — mandatory, not optional: lostark.bible rate-limits
      // Cloudflare egress IPs specifically, so this Worker can see a 429 for a page a
      // home connection loads fine. An old record beats an error every time.
      //
      // `fetchError` rides along because the DRAIN must not read this as a success:
      // ok:true with a stale record means "the caller got something", not "the page
      // was fetched". Without it the drain would delete the queue item and never retry.
      return { ok: true, cached: true, stale: true,
        staleHours: Math.round((Date.now() - stale.pulledAt) / 3600000),
        staleReason: res.message || res.error, record: stale,
        fetchError: { status: res.status, error: res.error, upstreamStatus: res.upstreamStatus || null } };
    }
    return { ok: false, status: res.status, upstreamStatus: res.upstreamStatus || null,
      body: { error: res.error, message: res.message, meta: res.meta } };
  }

  const now = Date.now();
  const record = Object.assign({}, res.data, {
    class: res.data.class || opts.fallbackClass || null,
    itemLevel: res.data.itemLevel != null ? res.data.itemLevel : (opts.fallbackItemLevel != null ? opts.fallbackItemLevel : null),
    score: score(res.data.stats),
    modelSig: MODEL_SIG,
    scoredAt: now,
    pulledAt: now,
    published: opts.publish !== false,
    regionVerified: opts.regionVerified !== false
  });
  if (env && env.CHARS) {
    try {
      await env.CHARS.put(key, JSON.stringify(record));
      await markDirty(env, key);
      await env.CHARS.put(LASTWRITE_KEY, String(now));
      await env.CHARS.delete(NOTFOUND_PREFIX + key);
    } catch (e) { /* storage failure is non-fatal: the caller still gets the bracelet */ }
  }
  return { ok: true, record: record, cached: false };
}

/**
 * The JSON the browser gets back. Deliberately close to the character page's own
 * shape: `bracelet.stats` goes straight into Bracelet.decodeBibleBracelet on the
 * client, so the import path is identical whether the data came from here or
 * (one day) from the roster endpoint.
 *
 * `score` rides along so the panel can show "on default settings, this is
 * +X%" next to its own per-character number — the two differ, and saying both
 * is how a user learns that the board ranks on defaults.
 *
 * `loadouts` ships every bracelet the character has, one per lostark.bible tab,
 * each with its own stats and its own default-profile score. `bracelet` is the
 * chosen one (the highest), so a caller that ignores loadouts entirely still
 * gets the right bracelet — which is more than it got before.
 */
function characterResponse(r) {
  const rec = r.record;
  const loadouts = Array.isArray(rec.loadouts) ? rec.loadouts : [];
  return {
    name: rec.name, region: rec.region, class: rec.class || null, itemLevel: rec.itemLevel || null,
    bracelet: {
      type: "bracelet",
      stats: rec.stats,
      numRerolls: rec.numRerolls,
      numTicketRerolls: rec.numTicketRerolls
    },
    loadouts: loadouts.map(function (l) {
      return {
        classification: l.classification, label: l.label,
        itemLevel: l.itemLevel, lastUpdated: l.lastUpdated, isRendered: !!l.isRendered,
        bracelet: { type: "bracelet", stats: l.stats, numRerolls: l.numRerolls, numTicketRerolls: l.numTicketRerolls },
        defaultScore: l.score || null,
        // Each tab has its OWN gear, accessories and gems — a pill click must
        // refill the deck, not just the bracelet.
        profile: l.profile || null
      };
    }),
    chosenLoadout: typeof rec.chosenLoadout === "number" ? rec.chosenLoadout : null,
    // ARCHITECTURE §1.1 — the chosen loadout's grader auto-fill block.
    profile: rec.profile || null,
    grade: rec.score && rec.score.grade,
    defaultScore: rec.score,          // CANONICAL DEFAULT profile — the leaderboard number
    published: !!rec.published,
    pulledAt: rec.pulledAt,
    cached: !!r.cached,
    stale: r.stale || false,
    staleHours: r.staleHours,
    staleReason: r.staleReason
  };
}

// ---------------------------------------------------------------------------
// Queue (POST /import overflow) + the cron drain
// ---------------------------------------------------------------------------

/**
 * Queue a page fetch for the cron.
 *
 * NO TOKEN IS STORED. The astrogem Worker keeps the requester's token in the
 * queue value so the drain can fetch as them; that is a user credential sitting
 * in KV, and it is not needed here — ownership was already verified at enqueue
 * time, and the drain fetches with BIBLE_TOKEN. The consent gate is a gate on
 * WHAT gets fetched, and it has already closed behind this item.
 */
function enqueue(env, region, name) {
  if (!env || !env.CHARS) return Promise.resolve();
  const ck = charKey(region, name);
  return env.CHARS.put(QUEUE_PREFIX + ck, "1", {
    metadata: { region: region, name: name, ts: Date.now() },
    expirationTtl: QUEUE_TTL_S
  }).catch(function () {});
}

/**
 * Cron drain: up to DRAIN_PER_RUN queued characters per minute, DRAIN_DELAY_MS
 * apart. region+name ride in the key metadata, so listing costs no per-key read.
 * A transient upstream failure leaves the item queued; a 404 drops it.
 */
async function drainQueue(env) {
  if (!env || !env.CHARS) return { drained: 0 };
  let res;
  try { res = await env.CHARS.list({ prefix: QUEUE_PREFIX, limit: 200 }); }
  catch (e) { return { drained: 0 }; }
  if (!res.keys.length) return { drained: 0 };

  const items = res.keys
    .map(function (k) { return { key: k.name, md: k.metadata || {} }; })
    .filter(function (x) { return x.md.region && x.md.name; })
    .sort(function (a, b) { return (a.md.ts || 0) - (b.md.ts || 0); })   // oldest first
    .slice(0, DRAIN_PER_RUN);

  const t0 = Date.now();
  let drained = 0, failed = 0;
  for (let i = 0; i < items.length; i++) {
    if (Date.now() - t0 > DRAIN_BUDGET_MS) break;
    if (i > 0) await sleep(DRAIN_DELAY_MS);
    const it = items[i];
    let r = null;
    try { r = await loadCharacter(env, it.md.region, it.md.name, { refresh: true, publish: true }); }
    catch (e) { r = null; }
    if (r && r.ok && !r.stale) { drained++; try { await env.CHARS.delete(it.key); } catch (e) {} }
    else if (r && !r.ok && r.status === 404) { try { await env.CHARS.delete(it.key); } catch (e) {} }
    else { failed++; break; }        // upstream is unhappy: stop the run, leave the rest queued
  }
  return { drained: drained, failed: failed };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /character (and its /bracelet alias) — the import round trip. */
async function handleCharacter(env, request, u, ip) {
  const name = (u.searchParams.get("name") || "").trim();
  const region = normRegion(u.searchParams.get("region") || "NA");
  if (!name) return json({ error: "bad_request", message: "name is required." }, 400);
  if (!region) return json({ error: "bad_region", message: "region must be NA or CE (lostark.bible calls EU Central 'CE')." }, 400);

  const owner = await requireOwner(env, request);
  if (owner.resp) return owner.resp;

  const owns = ownsCharacter(owner.chars, region, name);
  if (!owns.ok) {
    // Say WHY without leaking anything: "not on your roster" is the whole story,
    // and it is the same answer whether or not the character exists elsewhere.
    return json({ error: "not_yours",
      message: owns.sawName
        ? "That name is on your roster but under a different region."
        : "That character is not on the roster lostark.bible shows for your account. Only your own characters can be read here." }, 403);
  }

  // Per-user lookup throttle, keyed by the token hash so one person on two
  // networks is still one person. Generous for a human clicking a character,
  // useless for a script.
  if (env.LOOKUP_THROTTLE) {
    const k = (await sha256hex(owner.token)).slice(0, 24);
    const t = await env.LOOKUP_THROTTLE.limit({ key: "look:" + k });
    if (!t.success) return json({ error: "slow_down", message: "One character every few seconds, please.", rateLimited: true, retryAfterMs: 5000 }, 429);
  }

  const r = await loadCharacter(env, region, name, {
    token: owner.token,
    refresh: u.searchParams.get("refresh") === "1",
    publish: u.searchParams.get("publish") !== "0",
    regionVerified: owns.regionVerified,
    // The roster already told us the class and item level. Passed as a fallback
    // for the page parsers, which read markup that can change under us.
    fallbackClass: owns.meta && classFromRoster(owns.meta.cls),
    fallbackItemLevel: owns.meta && owns.meta.ilvl
  });
  if (!r.ok) return json(r.body, r.status);
  return json(characterResponse(r), 200);
}

/** POST /import — the same gate, in bulk. */
async function handleImport(env, request, ip) {
  const owner = await requireOwner(env, request);
  if (owner.resp) return owner.resp;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request", message: "Body must be JSON." }, 400); }
  const wanted = Array.isArray(body && body.characters) ? body.characters : null;
  if (!wanted) return json({ error: "bad_request", message: "Body must be { characters: [ … ] }." }, 400);
  if (wanted.length > IMPORT_MAX) return json({ error: "too_many", message: "At most " + IMPORT_MAX + " characters per request." }, 400);
  const publish = body.publish !== false;

  // Site-wide cap on NEW page fetches, so the queue can never grow faster than
  // the drain empties it however many users arrive at once.
  if (env.IMPORT_GATE) {
    const g = await env.IMPORT_GATE.limit({ key: "import" });
    if (!g.success) return json({ error: "busy", message: "Imports are backed up right now — try again in a minute.", rateLimited: true }, 429);
  }

  const results = [];
  let inline = 0;
  for (const raw of wanted) {
    const name = String(isObj(raw) ? raw.name : raw || "").trim();
    const region = normRegion((isObj(raw) && raw.region) || body.region || "NA");
    if (!name) { results.push({ name: String(raw), status: "bad_name" }); continue; }
    if (!region) { results.push({ name: name, status: "bad_region" }); continue; }
    const owns = ownsCharacter(owner.chars, region, name);
    if (!owns.ok) { results.push({ name: name, region: region, status: "not_yours" }); continue; }

    // A fresh record needs no fetch at all, whatever the budget.
    const existing = await kvGetJson(env, charKey(region, name));
    if (existing && (Date.now() - (existing.pulledAt || 0)) < CHAR_TTL_MS) {
      if (publish && !existing.published) {
        existing.published = true;
        try { await env.CHARS.put(charKey(region, name), JSON.stringify(existing)); await markDirty(env, charKey(region, name)); } catch (e) {}
      }
      results.push({ name: existing.name, region: region, status: "cached", pct: existing.score && existing.score.pct });
      continue;
    }

    if (inline < IMPORT_INLINE) {
      if (inline > 0) await sleep(IMPORT_DELAY_MS);          // polite: sequential, spaced
      inline++;
      const r = await loadCharacter(env, region, name, {
        token: owner.token, publish: publish, regionVerified: owns.regionVerified
      });
      if (r.ok) results.push({ name: r.record.name, region: region, status: r.stale ? "stale" : "loaded", pct: r.record.score && r.record.score.pct });
      else results.push({ name: name, region: region, status: r.body.error });
    } else {
      await enqueue(env, region, name);
      results.push({ name: name, region: region, status: "queued" });
    }
  }
  return json({ ok: true, results: results, queuedDrainEveryMinutes: 1 }, 200);
}

/** POST /forget — a signed-in user takes their own characters off the board. */
async function handleForget(env, request) {
  const owner = await requireOwner(env, request);
  if (owner.resp) return owner.resp;
  let body = {};
  try { body = await request.json(); } catch (e) { /* {all:true} may arrive with no body */ }

  // "all" means every character on the caller's OWN roster — the gate is the same
  // one that let them in, so nobody can unpublish anyone else.
  const targets = (body && body.all)
    ? owner.chars.map(function (c) { return { name: c.name, region: c.region || "NA" }; })
    : (Array.isArray(body && body.characters) ? body.characters : []);
  if (!targets.length) return json({ error: "bad_request", message: "Body must be { characters:[…] } or { all:true }." }, 400);

  const done = [];
  for (const raw of targets) {
    const name = String(isObj(raw) ? raw.name : raw || "").trim();
    const region = normRegion((isObj(raw) && raw.region) || "NA");
    if (!name || !region) continue;
    if (!ownsCharacter(owner.chars, region, name).ok) { done.push({ name: name, status: "not_yours" }); continue; }
    const key = charKey(region, name);
    // DELETE, not unpublish. "Forget me" should mean the record is gone, not
    // hidden behind a flag — the next sign-in can always re-fetch it.
    try { await env.CHARS.delete(key); await markDirty(env, key); done.push({ name: name, region: region, status: "forgotten" }); }
    catch (e) { done.push({ name: name, region: region, status: "error" }); }
  }
  return json({ ok: true, results: done }, 200);
}

/**
 * POST /admin/seed — load data/leaderboard-seed.json into KV.
 *
 * The body IS the seed file (the Worker cannot read the repo). Every entry is
 * RE-SCORED here from its `rawStats` rather than trusting the file's stored
 * numbers: one scorer, one profile, one set of numbers on the board. The
 * response reports each entry's delta against the file, so a divergence is
 * visible instead of silent — the seed decoded three type:2 indices (4, 74, 151)
 * with a local extension map the shipped model does not have, and those entries
 * WILL come out lower here. That is the honest number until the model learns
 * those indices.
 *
 * The seed's `rawStats` is the CHOSEN loadout's bracelet; its `loadouts` array
 * carries the rest, and those ride along so a seeded character offers the same
 * loadout pills a freshly-imported one does.
 */
async function handleAdminSeed(env, request) {
  if (!env || !env.CHARS) return json({ error: "no_kv", message: "The CHARS namespace is not bound." }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request", message: "POST the contents of data/leaderboard-seed.json as the body." }, 400); }
  const entries = Array.isArray(body && body.entries) ? body.entries : null;
  if (!entries) return json({ error: "bad_request", message: "Expected { entries: [ … ] }." }, 400);

  const out = [];
  const now = Date.now();
  for (const e of entries) {
    if (!e || !e.name || !Array.isArray(e.rawStats)) { out.push({ name: (e && e.name) || "?", status: "no_rawStats" }); continue; }
    const region = normRegion(e.region || "NA") || "NA";
    let sc;
    try { sc = score(e.rawStats); } catch (err) { out.push({ name: e.name, status: "score_failed" }); continue; }
    const key = charKey(region, e.name);
    let seedLoadouts = [];
    try {
      seedLoadouts = (Array.isArray(e.loadouts) ? e.loadouts : [])
      .filter(function (l) { return l && Array.isArray(l.rawStats); })
      .map(function (l) {
        return {
          classification: l.classification || "loadout",
          label: l.label || loadoutLabel(l.classification),
          itemLevel: l.itemLevel != null ? l.itemLevel : null,
          lastUpdated: l.lastUpdated != null ? l.lastUpdated : null,
          isRendered: !!l.isRendered,
          stats: l.rawStats,
          numRerolls: (l.rerollsUsed && l.rerollsUsed.base) != null ? l.rerollsUsed.base : null,
          numTicketRerolls: (l.rerollsUsed && l.rerollsUsed.ticket) != null ? l.rerollsUsed.ticket : null,
          score: briefScore(score(l.rawStats))
        };
      });
    } catch (err) { seedLoadouts = []; }   // a loadout that will not score costs the pills, not the entry
    const record = {
      region: region, name: normalizeName(e.name), class: e.class || null, itemLevel: e.itemLevel || null,
      stats: e.rawStats,
      loadouts: seedLoadouts,
      chosenLoadout: typeof e.chosenLoadout === "number" ? e.chosenLoadout : null,
      numRerolls: (e.rerollsLeft && e.rerollsLeft.base) != null ? e.rerollsLeft.base : null,
      numTicketRerolls: (e.rerollsLeft && e.rerollsLeft.ticket) != null ? e.rerollsLeft.ticket : null,
      score: sc, modelSig: MODEL_SIG, scoredAt: now,
      // The seed was read on 2026-08-11; keep that as the pull time so the board
      // ages it honestly rather than claiming it is fresh.
      pulledAt: Date.parse(e.scoredAt || body._scoredAt || "") || now,
      published: true, regionVerified: true,
      source: "seed", seeded: true
    };
    try { await env.CHARS.put(key, JSON.stringify(record)); await markDirty(env, key); }
    catch (err) { out.push({ name: e.name, status: "kv_failed" }); continue; }
    out.push({
      name: record.name, region: region, status: "stored",
      pct: sc.pct, seedPct: e.damagePct != null ? e.damagePct : null,
      delta: e.damagePct != null ? (sc.pct - e.damagePct) : null,
      unmapped: sc.unmapped.length
    });
  }
  return json({ ok: true, stored: out.filter(function (x) { return x.status === "stored"; }).length, results: out }, 200);
}

/** GET /admin/metrics — what is in the store and what is waiting. */
async function handleAdminMetrics(env) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  let chars = 0, queued = 0, dirty = 0, cursor;
  do {
    const res = await env.CHARS.list({ cursor: cursor, limit: 1000 });
    for (const k of res.keys) {
      if (k.name.indexOf(CHAR_PREFIX) === 0) chars++;
      else if (k.name.indexOf(QUEUE_PREFIX) === 0) queued++;
      else if (k.name.indexOf(DIRTY_PREFIX) === 0) dirty++;
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  const lw = parseInt((await env.CHARS.get(LASTWRITE_KEY)) || "0", 10);
  const ba = parseInt((await env.CHARS.get(BUILTAT_KEY)) || "0", 10);
  return json({
    ok: true, characters: chars, queued: queued, dirty: dirty,
    lastWrite: lw, snapshotBuiltAt: ba, modelSig: MODEL_SIG,
    hasBibleToken: !!(env && env.BIBLE_TOKEN),
    snapshot: "not built yet — ?list=1 is stubbed pending the architecture doc"
  }, 200);
}

/** POST /admin/delete?region=&name= — takedown, for anyone who asks. */
async function handleAdminDelete(env, u) {
  const name = (u.searchParams.get("name") || "").trim();
  const region = normRegion(u.searchParams.get("region") || "NA");
  if (!name || !region) return json({ error: "bad_request", message: "name and region are required." }, 400);
  const key = charKey(region, name);
  try { await env.CHARS.delete(key); await markDirty(env, key); } catch (e) {}
  return json({ ok: true, deleted: key }, 200);
}

/**
 * GET /admin/page?name=&region= — the parse probe.
 *
 * Returns what the character page actually yielded: the bracelet payloads found,
 * the meta the parsers read, and a short list of which candidate profile fields
 * are present in the blob. This is how the "auto-fill the calculator profile
 * from the character page" work gets its field map WITHOUT anyone guessing at
 * key names — the same job __probeRosters() does for the roster payload. Admin
 * only, because it is one more page fetch per call.
 */
async function handleAdminPage(env, request, u) {
  const name = (u.searchParams.get("name") || "").trim();
  const region = normRegion(u.searchParams.get("region") || "NA");
  if (!name || !region) return json({ error: "bad_request", message: "name and region are required." }, 400);

  const url = BIBLE + "/character/" + encodeURIComponent(region) + "/" + encodeURIComponent(name);
  let resp;
  try {
    resp = await fetch(url, { headers: {
      "User-Agent": BROWSER_UA, "Accept": "text/html,*/*;q=0.8", "Referer": BIBLE + "/",
      "Authorization": "Bearer " + ((env && env.BIBLE_TOKEN) || bearer(request) || "")
    }, redirect: "follow" });
  } catch (e) { return json({ error: "upstream_unreachable" }, 502); }
  if (!resp.ok) return json({ error: "upstream_" + resp.status, url: url }, 502);
  const html = await resp.text();

  // Candidate markers for the profile auto-fill. Report presence + the first
  // match, never the whole page: the answer wanted is "is this field there and
  // what does it look like", not a page dump.
  const PROBES = [
    ["ilvl", /ilvl:(\d+)/],
    ["combatPower", /estimatedMaxCombatPower:\{id:\d+,score:([\d.]+)\}/],
    ["combatPowerPlain", /[^A-Za-z]combatPower:\{id:\d+,score:([\d.]+)\}/],
    ["braceletEffectPct", /[Bb]racelet[^<]{0,40}?\+([\d.]+)%/],
    ["accessoryStats", /slot:"(?:neck|ear1|ear2|finger1|finger2)",data:\{type:"tier4_accessory",stats:\[(.{0,120})/],
    ["gems", /gems:\[\{(.{0,120})/],
    ["arkGridCores", /arkGridCores:\[(.{0,120})/],
    ["engravings", /engravings?:\[(.{0,120})/],
    ["stats", /[^A-Za-z]stats:\[\{(.{0,160})/],
    ["cardSet", /cardSet[s]?:(.{0,80})/],
    ["elixir", /elixir[s]?:(.{0,80})/],
    ["transcendence", /transcend\w*:(.{0,80})/]
  ];
  const probes = {};
  for (const [k, re] of PROBES) {
    const m = html.match(re);
    probes[k] = m ? String(m[1]).slice(0, 160) : null;
  }
  return json({
    ok: true, url: url, bytes: html.length,
    meta: parseMeta(html),
    bracelets: extractBracelets(html),
    probes: probes
  }, 200);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // The router builds plain responses; CORS is stamped on HERE, once, from the
    // caller's Origin. One place to reason about, no way for a route to forget.
    const resp = await handleFetch(request, env, ctx);
    const cors = corsHeaders(request.headers.get("Origin") || "");
    for (const h in cors) resp.headers.set(h, cors[h]);
    return resp;
  },

  async scheduled(controller, env, ctx) {
    // Every minute: drain a few queued characters, paced. The leaderboard
    // snapshot rebuild belongs here too — dirty-gated and throttled on
    // BUILTAT_KEY, ~30 min cadence — and lands with the snapshot work.
    await drainQueue(env);
  }
};

async function handleFetch(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const u = new URL(request.url);
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  // Hard backstop on EVERY request, before any work. An edge rate-limit binding:
  // a blocked hit touches no KV and makes no upstream request.
  if (env.HARD_CAP) {
    const h = await env.HARD_CAP.limit({ key: ip });
    if (!h.success) return json({ error: "slow_down", message: "Too many requests — please slow down.", rateLimited: true, retryAfterMs: 60000 }, 429);
  }

  // GLOBAL overload gate: ONE shared counter across all requests, not per-IP.
  // When it trips, NEW upstream work pauses for everyone equally — no bypass,
  // no premium lane. Cached reads keep working.
  let degraded = false;
  if (env.GLOBAL_GATE) {
    const g = await env.GLOBAL_GATE.limit({ key: "global" });
    degraded = !g.success;
  }
  const busyMsg = "The site is very busy right now — please try again shortly.";

  // ---- admin (X-Admin-Token, fail closed) ----
  if (p.indexOf("/admin/") === 0) {
    if (!adminOk(request, env)) return json({ error: "forbidden", message: "Admin token required (X-Admin-Token header)." }, 403);
    if (p === "/admin/seed")    return request.method === "POST" ? handleAdminSeed(env, request) : json({ error: "post_only" }, 405);
    if (p === "/admin/delete")  return request.method === "POST" ? handleAdminDelete(env, u) : json({ error: "post_only" }, 405);
    if (p === "/admin/metrics") return handleAdminMetrics(env);
    if (p === "/admin/page")    return handleAdminPage(env, request, u);
    if (p === "/admin/drain")   return json(Object.assign({ ok: true }, await drainQueue(env)), 200);
    return json({ error: "not_found" }, 404);
  }

  // ---- writes ----
  if (request.method === "POST") {
    if (degraded) return json({ error: "busy", message: busyMsg, rateLimited: true, degraded: true }, 429);
    if (p === "/import") return handleImport(env, request, ip);
    if (p === "/forget") return handleForget(env, request);
    return json({ error: "not_found", message: "POST /import or POST /forget." }, 404);
  }

  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  // ---- leaderboard snapshot: NOT BUILT YET ----
  // Answering 501 with the reason beats answering an empty list: an empty list
  // reads as "nobody is on the board", which is a different and wrong story.
  if (u.searchParams.get("list") === "1") {
    if (env.LB_THROTTLE) {
      const l = await env.LB_THROTTLE.limit({ key: ip });
      if (!l.success) return json({ error: "slow_down", message: "The board refreshes every few minutes — please wait a moment.", rateLimited: true }, 429);
    }
    return json({
      error: "not_built",
      message: "The leaderboard snapshot is not built yet. Records are being stored and marked dirty; the snapshot format is pending the architecture doc.",
      characters: []
    }, 501);
  }

  // ---- the import round trip ----
  if (p === "/character" || p === "/bracelet") {
    if (degraded) return json({ error: "busy", message: busyMsg, rateLimited: true, degraded: true }, 429);
    return handleCharacter(env, request, u, ip);
  }

  // ---- health ----
  if (p === "/") {
    return json({
      ok: true, service: "bracelet-bible",
      model: { version: Bracelet.VERSION, signature: Bracelet.MODEL_SIG },
      profile: "canonical-default (normalizeProfile({}))",
      kv: !!(env && env.CHARS),
      bibleToken: !!(env && env.BIBLE_TOKEN),
      routes: ["/character?name=&region=", "POST /import", "POST /forget", "?list=1 (stubbed)"]
    }, 200);
  }

  return json({ error: "not_found" }, 404);
}

// Exported for the local test harness (tools/test-worker.js). Not part of the
// HTTP surface — the router above is.
export const __test = {
  score: score, extractBracelets: extractBracelets, collectRosterChars: collectRosterChars,
  ownsCharacter: ownsCharacter, normRegion: normRegion, decodeWithGradeCheck: decodeWithGradeCheck,
  DEFAULT_PROFILE: DEFAULT_PROFILE,
  extractLoadouts: extractLoadouts, pickBestLoadout: pickBestLoadout,
  briefScore: briefScore, loadoutLabel: loadoutLabel,
  parseCharacterProfile: parseCharacterProfile, snapTo: snapTo, modal: modal,
  MASTER_NODE_ID: MASTER_NODE_ID, GEM_AP_LEVEL: GEM_AP_LEVEL
};
