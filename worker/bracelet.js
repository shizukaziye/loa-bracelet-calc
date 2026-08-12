/**
 * worker/bracelet.js — "bracelet-bible", the Cloudflare Worker behind the
 * bracelet calculator's lostark.bible import.
 *
 * Complete as of 2026-08-11: the import round trip, the KV record store, the
 * canonical-default scorer, the queue and its paced drain with a circuit breaker,
 * the long poll, the gzipped leaderboard snapshot, feedback, and the admin
 * surface.
 *
 * ============================== WHY IT EXISTS ==============================
 *
 * `/api/oauth/rosters` is a roster INDEX; it carries no bracelet. The bracelet
 * lives in the SvelteKit hydration blob of a lostark.bible CHARACTER PAGE, and
 * a browser cannot read that page cross-origin (no CORS on the page routes).
 * So this Worker fetches the page server-side, pulls the bracelet out, scores
 * it, and answers JSON with a CORS allowlist for our own origins.
 *
 * ========================= WHO MAY BE LOOKED UP ============================
 *
 * ANYONE, since 2026-08-11. Any visitor, signed in or not, may type any name and
 * region and get that character's bracelet.
 *
 * THAT IS A DELIBERATE POLICY, NOT A HOLE TO PLUG. Shizu holds the lostark.bible
 * relationship, and molenzwiebel's terms are: scraping character pages is
 * permitted at Shizu's discretion, PROVIDED every request carries the
 * authorization token. An earlier build fetched a character only if it appeared
 * on the caller's own /api/oauth/rosters roster — stricter than the permission we
 * actually hold, and chosen only because molenzwiebel means to make roster-only
 * the ONLY path LATER. It is open until he changes the API. Do NOT restore that
 * gate as a bug fix; it is a policy change and it needs Shizu, not a patch. The
 * same decision, dated, is docs/design/ARCHITECTURE.md §0.3.
 *
 * ========================= WHAT DID NOT CHANGE =============================
 *
 * 1. EVERY request to lostark.bible carries an Authorization Bearer. The
 *    CALLER'S OWN token when they are signed in — better attribution, and the
 *    load spreads across users instead of landing entirely on one secret — and
 *    the BIBLE_TOKEN secret otherwise. A tokenless request is the violation, and
 *    is the thing that earns a 429.
 * 2. The token goes to lostark.bible and NOWHERE else, and is never logged and
 *    never stored: the roster cache (which only /forget uses now) is keyed by a
 *    SHA-256 of the token, and the queue holds it in a VALUE that is deleted the
 *    moment the fetch lands.
 * 3. Raid-statistics endpoints are never touched, by any path.
 * 4. The abuse controls are now the ONLY thing between a stranger and Shizu's
 *    token, so every one of them is load-bearing: the per-IP lookup throttle, the
 *    site-wide enqueue gate, the hard cap, the global gate, the ≥3s spacing floor
 *    between character-page fetches, the monthly budget, the fail-streak breaker,
 *    the `nf:` markers and the 7-day cache. There is still no crawler and no
 *    enumeration anywhere in this file: one name, one click, one page.
 *
 * OWNERSHIP IS STILL PROVEN FOR ONE THING. POST /forget DELETES records, so it
 * still checks the caller's own roster holds the character. Reading a public page
 * and deleting someone's row are not the same act.
 *
 * ================================ ROUTES ===================================
 *
 *   OPTIONS *                                   CORS preflight, before the hard cap
 *   GET  /                                      health + model signature
 *   GET  /character?name=&region=[&queue=1][&pos=1][&refresh=1][&publish=0]
 *                                               The one route the import UI calls.
 *                                               No sign-in needed. Cached → answer now.
 *                                               Miss → ENQUEUE and answer
 *                                               {queued, position, total, drainPerMin}.
 *   GET  /bracelet?…                            alias of /character (the name used
 *                                               in docs/design/bible-import-fallback.md)
 *   GET  /wait?region=&name=&since=             Long poll, ≤25s, no sign-in; answers the
 *                                               moment the drain stores a record newer
 *                                               than `since`. Holds only for a lookup
 *                                               that is genuinely pending.
 *   GET  /?list=1   ·   GET /list               the board: the stored gzip bytes, as-is
 *   GET  /status                                is the drain running? (public, cached 30s)
 *   POST /feedback {type,message,contact,hp}    public, honeypotted, throttled, 90-day TTL
 *   POST /import   {characters:[…], publish?}   Bulk queue. Bearer OPTIONAL; a signed-out
 *                                               batch is capped harder (IMPORT_MAX_ANON).
 *   POST /forget   {characters:[…]}|{all:true}  Bearer REQUIRED, roster checked. Removes
 *                                               the caller's OWN characters from the board.
 *   GET  /admin/metrics                         X-Admin-Token. Queue, drain, log, health.
 *   GET  /admin/feedback                        X-Admin-Token. The newest ≤200 notes.
 *   POST /admin/feedback {read|del}             X-Admin-Token.
 *   POST /admin/control  {mode, rate}           X-Admin-Token. run/off/probe, 1–20 a minute.
 *   POST /admin/dequeue  {match|all}            X-Admin-Token. Evict by key substring.
 *   POST /admin/rescore  {}                     X-Admin-Token. Re-score from the raw stats.
 *   POST /admin/seed                            X-Admin-Token. Body = data/leaderboard-seed.json
 *   POST /admin/delete   {region, name}         X-Admin-Token. Takedown.
 *   POST /admin/drain · POST /admin/snapshot    X-Admin-Token. Run one now.
 *   GET  /admin/page?name=&region=              X-Admin-Token. Raw parse probe: what the
 *                                               character page actually yielded. This is how
 *                                               the profile auto-fill map gets filled in
 *                                               without guessing at field names.
 *   cron * * * * *                              drain the queue (paced), then rebuild the
 *                                               snapshot if anything changed
 *
 * EVERY ADMIN MUTATION IS POST. A GET with side effects is one <img src> away from
 * a stranger's page freezing the queue — /admin/drain used to be exactly that.
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
 *                It carries the CRON DRAIN, every signed-out lookup, and any
 *                lookup whose caller token turns out to be stale. Live lookups
 *                still PREFER the caller's own token when they have one. Without
 *                this secret a signed-out lookup has no Bearer to send, so it must
 *                not be made at all — fetchCharacterPage refuses.
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
const ROSTER_TTL_S  = 5 * 60;               // /forget's roster proof costs one extra fetch per 5 min, not one per call
const NOTFOUND_TTL_S = 60 * 60;             // remember not-found for an hour; self-corrects if it was transient
const QUEUE_TTL_S   = 3 * 24 * 3600;        // a queued fetch expires after 3 days if never drained
const DIRTY_TTL_S   = 7 * 24 * 3600;        // safety net; the rebuild normally clears the marker

const IMPORT_MAX      = 24;    // characters accepted in one POST /import (a big roster, no more)
const IMPORT_MAX_ANON = 8;     // …but 8 from a caller with no token. A signed-in import is a
                               // roster the user just loaded; a signed-out one is a list a
                               // stranger typed, and it spends Shizu's own token to fetch.

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

// The region a PLAYER says out loud. Internally EU Central is "CE", because that
// is what lostark.bible's URLs use; a sentence shown to a human says EU.
function regionLabel(r) { return normRegion(r) === "CE" ? "EU" : "NA"; }
function otherRegionLabel(r) { return regionLabel(r) === "NA" ? "EU" : "NA"; }

/**
 * Why a name came back with nothing — in the visitor's terms, and about the
 * ACTUAL cause.
 *
 * We cannot tell a typo from a character hidden on lostark.bible: both are a 404
 * on the character page, and the OAuth scope itself only covers non-hidden
 * characters. So the sentence names both and neither invents a rule of ours nor
 * hangs one on lostark.bible. Before 2026-08-11 this said the character was "not
 * on the roster lostark.bible shows for your account", which blamed lostark.bible
 * for a restriction WE had chosen — and sent people to fix the wrong thing.
 */
function noSuchMsg(region, name) {
  return "No character called " + name + " on " + regionLabel(region) +
    " — check the spelling, or try " + otherRegionLabel(region) +
    ". A character hidden on lostark.bible cannot be read either.";
}

/**
 * The per-IP key for the fresh-lookup throttle.
 *
 * It used to hash the caller's OAuth token, which only worked while a lookup
 * REQUIRED a sign-in. A signed-out visitor has no token to key on, and keying the
 * signed-in separately would hand anybody a second bucket for the price of
 * signing out. The IP is the one handle that covers both, so both use it.
 */
function lookupKey(ip) { return "look:" + (ip || "0.0.0.0"); }

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
// THE ROSTER PROOF: does this token's own roster hold this character?
//
// This whole block used to gate every lookup. Since 2026-08-11 it gates exactly
// one route — POST /forget, which DELETES records — and nothing else calls it.
// Reading a page that lostark.bible serves to anyone needs no proof of ownership;
// deleting somebody's row does. Keep it here, keep it wired to /forget, and do
// not re-point it at /character (see the header: that would be a policy change).
// ---------------------------------------------------------------------------

/**
 * /api/oauth/rosters names classes with the game's internal snake_case codes
 * ("devil_hunter_female"), not the English display names the character PAGE
 * badge carries ("Gunslinger"). Eight of these were verified by joining the live
 * roster against data/leaderboard-seed.json, which was read off the pages
 * themselves — see docs/research/oauth-rosters-shape.md.
 *
 * DORMANT since 2026-08-11, deliberately kept. It was the class fallback for a
 * lookup that had already read the caller's roster; a lookup reads no roster any
 * more, so nothing calls it and the page badge is the only source. It stays
 * because the table is research, not code — nine codes joined by hand against
 * real pages — and it is what the roster-only path will need on the day
 * molenzwiebel makes that the only path. Do not delete it to quiet a linter.
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
 * The caller's own roster, cached ~5 minutes so the proof costs one extra fetch
 * per session rather than two fetches per call.
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

/**
 * Bearer + roster in one step, for POST /forget only — the one route that still
 * has to prove the caller owns what they are about to delete.
 * Returns { token, chars } or a ready-made error Response.
 */
async function requireOwner(env, request) {
  const token = bearer(request);
  if (!token) {
    return { resp: json({ error: "not_signed_in", message: "Sign in with lostark.bible first — taking a character off the board has to prove it is yours." }, 401) };
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
 * `userToken` is the caller's own OAuth token when a signed-in human is driving.
 * A signed-out visitor and the cron drain have none, so both fall back to the
 * BIBLE_TOKEN secret.
 *
 * EVERY REQUEST CARRIES A BEARER. That is the standing condition of Shizu's
 * access (molenzwiebel, 2026-07-22, re-confirmed 2026-08-11) and the one rule
 * that did not loosen when the ownership gate came off. With no token of either
 * kind this function makes NO REQUEST AT ALL — sending a naked one is the actual
 * violation, and it is what earns a 429.
 *
 * A caller token that turns out to be stale falls back to BIBLE_TOKEN and retries
 * ONCE, spaced like any other page fetch. Now that signing in is optional, a
 * months-old token in someone's localStorage must not be the reason a lookup
 * fails.
 */
async function fetchCharacterPage(env, region, name, userToken) {
  const secret = (env && env.BIBLE_TOKEN) || "";
  const first = userToken || secret;
  if (!first) {
    return { ok: false, status: 503, error: "no_token",
      message: "Character lookups are not configured right now — nothing was requested from lostark.bible.",
      upstreamStatus: 0 };
  }
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
  headers["Authorization"] = "Bearer " + first;

  let resp;
  try {
    // TIMEOUT EVERY UPSTREAM FETCH. Astrogem has no timeout anywhere, and one hung
    // connection there eats the entire 50s drain budget — a single slow character
    // costs every character behind it. Ten seconds is generous for an HTML page.
    resp = await fetch(url, { headers: headers, redirect: "follow", signal: AbortSignal.timeout(10000) });
  }
  catch (e) { return { ok: false, status: 502, error: "upstream_unreachable", message: "lostark.bible did not answer.", upstreamStatus: 0 }; }

  // The caller's sign-in is dead but ours is not: space the retry like any other
  // page fetch (the 3s floor counts both) and go again on the secret, once.
  if ((resp.status === 401 || resp.status === 403) && first !== secret && secret) {
    try { await spaceUpstream(env); } catch (e) {}
    headers["Authorization"] = "Bearer " + secret;
    try {
      resp = await fetch(url, { headers: headers, redirect: "follow", signal: AbortSignal.timeout(10000) });
    } catch (e) { return { ok: false, status: 502, error: "upstream_unreachable", message: "lostark.bible did not answer.", upstreamStatus: 0 }; }
  }

  if (resp.status === 404) {
    return { ok: false, status: 404, error: "no_such_character", message: noSuchMsg(region, name), upstreamStatus: 404 };
  }
  if (!resp.ok) {
    const authIssue = resp.status === 401 || resp.status === 403;
    // `upstreamStatus` is the REAL lostark.bible status behind our 502, and the drain
    // classifies on it: 401/403 is one dead token (drop the item), any other 4xx is a
    // site-wide block (trip the breaker). Collapsing both to "502" loses that distinction.
    return { ok: false, status: 502, error: "upstream_" + resp.status,
      message: resp.status === 429
        ? "lostark.bible is rate-limiting us at the moment — this is temporary, try again shortly."
        : ("lostark.bible returned HTTP " + resp.status + "." +
           (authIssue ? " Both our sign-in and the BIBLE_TOKEN secret were refused, so the secret is missing or stale." : "")),
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
    if (nf) return { ok: false, status: 404, body: { error: "no_such_character", message: noSuchMsg(region, name) } };
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
// Queue + the cron drain
// ---------------------------------------------------------------------------

/**
 * Queue a page fetch for the cron.
 *
 * WHERE THE TOKEN GOES. The requester's own lostark.bible token is stored in the
 * queue item's VALUE, never in its METADATA — metadata is returned by `list()`,
 * which the drain, the metrics route and the position lookup all call, so a token
 * there would be read into three places that have no business holding one. The
 * value is read only by the one drain that fetches this item, and the item is
 * deleted the moment it is cached, so the credential is held exactly as long as
 * the request it belongs to.
 *
 * Fetching as the requester keeps every upstream request attributable to a
 * consenting human. Preserve it across a requeue or the retry 401s.
 */
function enqueue(env, region, name, token) {
  if (!env || !env.CHARS) return Promise.resolve();
  const ck = charKey(region, name);
  return env.CHARS.put(QUEUE_PREFIX + ck, JSON.stringify({ t: token || "" }), {
    metadata: { region: region, name: name, ts: Date.now() },
    expirationTtl: QUEUE_TTL_S
  }).then(function () {
    // Invalidate the order snapshot. It does two jobs at once: it defeats the cron's
    // empty-queue short-circuit (so a brand-new item is drained this minute, not in
    // ten), and it stops a position read trusting an order that predates this enqueue.
    return env.CHARS.delete(Q_ORDER_KEY).catch(function () {});
  }).catch(function () {});
}

/** The queue in drain order (oldest ts first) as [{k, r, n, t, a}]. One list(). */
async function listQueueOrder(env) {
  let keys = [];
  try {
    let cursor;
    do {
      const res = await env.CHARS.list({ prefix: QUEUE_PREFIX, cursor: cursor, limit: 1000 });
      for (const k of res.keys) if (k.name !== Q_ORDER_KEY) keys.push(k);
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch (e) { return []; }
  return keys.slice()
    .sort(function (a, b) { return ((a.metadata && a.metadata.ts) || 0) - ((b.metadata && b.metadata.ts) || 0); })
    .map(function (k) {
      const m = k.metadata || {};
      return { k: k.name, r: m.region || "", n: m.name || "", t: m.ts || 0, a: m.attempts || 0 };
    });
}
/** The same, but preferring the cron-maintained snapshot — one get() instead of a list(). */
async function readQueueOrder(env) {
  try {
    const s = await kvGetJson(env, Q_ORDER_KEY);
    if (s && Array.isArray(s.items) && Date.now() - (s.ts || 0) < Q_ORDER_TTL_MS) return s.items;
  } catch (e) {}
  return listQueueOrder(env);
}

/**
 * Where a queued character sits, how many are waiting, and how fast the queue
 * moves — the three numbers the client's banner counts down from.
 *
 * A just-enqueued key may not be visible to `list()` yet (KV list is eventually
 * consistent), so an unfound key is reported at the TAIL rather than as an error;
 * the next poll corrects it.
 */
async function queueStatus(env, region, name) {
  const fullKey = QUEUE_PREFIX + charKey(region, name);
  const items = await readQueueOrder(env);
  let idx = -1;
  for (let i = 0; i < items.length; i++) if (items[i].k === fullKey) { idx = i; break; }
  const position = (idx >= 0 ? idx : items.length) + 1;
  const total = Math.max(items.length, position);
  const cfg = await getDrainConfig(env);
  return {
    position: position, total: total,
    drainPerMin: cfg.drainPerMin,
    etaMinutes: Math.ceil(position / cfg.drainPerMin)
  };
}

/**
 * The "queued" answer: `{queued, position, total, drainPerMin, name, region}`,
 * plus whatever a cached copy of the character already says.
 *
 * `pos=1` is what costs the list() — the client asks for it on the first lookup
 * and on its 30s re-syncs, and runs a free local countdown in between. An answer
 * with no position is cheap on purpose.
 */
async function queuedResponse(env, region, name, extra, wantPos, record) {
  const st = wantPos ? await queueStatus(env, region, name) : null;
  const base = record ? characterResponse({ record: record, cached: true, stale: (Date.now() - (record.pulledAt || 0)) >= CHAR_TTL_MS }) : {};
  return json(Object.assign(base, { queued: true, region: region, name: normalizeName(name) },
    st || {}, extra || {}), 200);
}

// ---- drain configuration: mode, rate, and the breaker's backoff state -------

async function getDrainConfig(env) {
  let c = null;
  try { c = await kvGetJson(env, DRAIN_CONFIG_KEY); } catch (e) {}
  c = c || {};
  const mode = DRAIN_MODES.indexOf(c.mode) !== -1 ? c.mode : "run";   // unset KV simply drains
  let rate = parseInt(c.drainPerMin, 10);
  if (!Number.isFinite(rate) || rate < 1) rate = DRAIN_PER_MIN_DEFAULT;
  if (rate > DRAIN_PER_MIN_MAX) rate = DRAIN_PER_MIN_MAX;
  return { mode: mode, drainPerMin: rate, lastProbe: c.lastProbe || 0, interval: c.interval || PAUSE_PROBE_FIRST_MS };
}
function setDrainConfig(env, cfg) {
  return env.CHARS.put(DRAIN_CONFIG_KEY, JSON.stringify(cfg)).catch(function () {});
}
/** ≥3s between page fetches, whatever the rate says. The floor wins. */
function drainSpacingMs(perMin) {
  return Math.max(DRAIN_MIN_SPACING_MS, Math.round(60000 / Math.max(1, perMin)));
}

/** Rolling ~1h of drain runs, for the admin log panel. */
async function appendDrainLog(env, run) {
  try {
    const log = (await kvGetJson(env, DRAIN_LOG_KEY)) || [];
    log.push(run);
    const cut = Date.now() - DRAIN_LOG_MAX_MS;
    const kept = log.filter(function (e) { return e && e.t >= cut; }).slice(-240);
    await env.CHARS.put(DRAIN_LOG_KEY, JSON.stringify(kept));
  } catch (e) {}
}

/**
 * Put failures back at the FRONT (ts = 1, attempts reset) so a queue that was
 * paused resumes by retrying exactly what failed, first. The upstream being down
 * is not the character's fault, so its attempt count is forgiven.
 *
 * ts=1 is a SENTINEL, not a timestamp — the admin page prints its wait as "—"
 * rather than claiming a 57-year queue. And the stored token is read back and
 * rewritten: dropping it here would make the retry fetch unauthenticated, 401,
 * and be discarded as "token expired" when the requester's token was fine.
 */
async function requeueFront(env, items) {
  const seen = {};
  for (const it of (items || [])) {
    if (!it || !it.region || !it.name) continue;
    const k = QUEUE_PREFIX + charKey(it.region, it.name);
    if (seen[k]) continue;
    seen[k] = 1;
    let tok = "";
    try { const v = await env.CHARS.get(k, "json"); tok = (v && v.t) || ""; } catch (e) {}
    try {
      await env.CHARS.put(k, JSON.stringify({ t: tok }), {
        metadata: { region: it.region, name: it.name, ts: 1 }, expirationTtl: QUEUE_TTL_S
      });
    } catch (e) {}
  }
}

/** Monthly usage counter, for the budget guard. */
function monthKey() { return new Date().toISOString().slice(0, 7); }
async function bumpUsage(env, n) {
  try {
    const m = monthKey();
    const u = await kvGetJson(env, USAGE_KEY);
    const c = (u && u.month === m ? (u.count | 0) : 0) + n;
    await env.CHARS.put(USAGE_KEY, JSON.stringify({ month: m, count: c }), { expirationTtl: 40 * 24 * 3600 });
  } catch (e) {}
}
async function usageCount(env) {
  const u = await kvGetJson(env, USAGE_KEY);
  return (u && u.month === monthKey()) ? (u.count | 0) : 0;
}

/**
 * Space this fetch ≥3s from the last one, wherever that one came from.
 *
 * The drain paces itself with a sleep inside its own loop, but a kick runs in a
 * DIFFERENT invocation and knows nothing about it. A shared "when did anything
 * last fetch a character page" timestamp is what makes the 3s floor hold across
 * both. KV is eventually consistent, so this is a guard rather than a proof —
 * which is why the kick also refuses to run while the drain lock is held.
 */
async function spaceUpstream(env) {
  try {
    const last = parseInt((await env.CHARS.get(LASTFETCH_KEY)) || "0", 10);
    const wait = last + DRAIN_MIN_SPACING_MS - Date.now();
    if (wait > 0 && wait <= DRAIN_MIN_SPACING_MS) await sleep(wait);
  } catch (e) {}
  try { await env.CHARS.put(LASTFETCH_KEY, String(Date.now())); } catch (e) {}
}

/**
 * The recovery probe. Re-fetch the OLDEST queued character (there is no canary
 * account here) and read the answer as a verdict on lostark.bible, not on the
 * character: a 200 or a 404 both mean the site is answering us again.
 */
async function probeOldest(env) {
  const items = await readQueueOrder(env);
  const it = items[0];
  if (!it || !it.r || !it.n) return { up: false, empty: true, entry: { region: "", name: "", msg: "queue empty — nothing to probe" } };
  let tok = "";
  try { const v = await env.CHARS.get(it.k, "json"); tok = (v && v.t) || ""; } catch (e) {}
  await spaceUpstream(env);
  let r = null;
  try { r = await loadCharacter(env, it.r, it.n, { refresh: true, publish: true, token: tok }); } catch (e) { r = null; }
  if (r && r.ok && !r.stale) {
    try { await env.CHARS.delete(it.k); } catch (e) {}
    return { up: true, cached: true, name: it.r + ":" + it.n };
  }
  if (r && !r.ok && r.status === 404) {
    try { await env.CHARS.delete(it.k); } catch (e) {}
    try { await env.CHARS.put(NOTFOUND_PREFIX + charKey(it.r, it.n), String(r.body && r.body.message || "not found").slice(0, 300), { expirationTtl: NOTFOUND_TTL_S }); } catch (e) {}
    return { up: true, cached: false, name: it.r + ":" + it.n };
  }
  const fe = (r && r.fetchError) || {};
  return { up: false, entry: { region: it.r, name: it.n,
    status: (r && r.status) || fe.status || 0,
    upstream: fe.upstreamStatus != null ? fe.upstreamStatus : ((r && r.upstreamStatus) || null),
    msg: fe.error || (r && r.body && r.body.error) || "network/timeout" } };
}

/**
 * The cron drain.
 *
 * Reads at most `drainPerMin` queued characters a minute, one at a time, at least
 * DRAIN_MIN_SPACING_MS apart, and classifies every failure into one of three
 * kinds because they want three different things:
 *
 *   OUR 4xx (no page, no bracelet)  drop the item + an `nf:` marker for an hour,
 *                                   so a dead name cannot re-enqueue forever.
 *   upstream 401/403                one dead user token. Drop THIS ITEM ONLY and
 *                                   keep draining — do NOT trip the breaker; the
 *                                   site is fine, this requester's sign-in is not.
 *   other upstream 4xx (429/418…)   a block that hits everyone. Requeue at the
 *                                   front and trip to `probe` immediately: it will
 *                                   not fix itself on retry, so retrying is rude.
 *
 * Transient 5xx/network failures leave the item queued with its attempt count
 * bumped, and five in a row trip the same breaker.
 */
async function drainQueue(env) {
  if (!env || !env.CHARS) return { drained: 0 };
  const t0 = Date.now();
  const run = { t: t0, cached: [], dropped: [], failed: [], stop: null };

  const cfg = await getDrainConfig(env);
  if (cfg.mode === "off") return { drained: 0, mode: "off" };          // frozen: zero upstream requests
  if (cfg.mode === "probe") {
    if (Date.now() - (cfg.lastProbe || 0) < (cfg.interval || PAUSE_PROBE_FIRST_MS)) return { drained: 0, mode: "probe", waiting: true };
    const probe = await probeOldest(env);
    run.ms = Date.now() - t0;
    if (probe.up) {
      await setDrainConfig(env, { mode: "run", drainPerMin: cfg.drainPerMin });   // recovered
      run.stop = "resumed";
      if (probe.cached && probe.name) {
        run.cached.push(probe.name);
        try { await env.CHARS.put(LASTWRITE_KEY, String(Date.now())); } catch (e) {}
        await bumpUsage(env, 1);
      }
    } else {
      // Still down: back off ×2, capped. A day-long outage costs ~10 requests, not 1440.
      await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(),
        interval: Math.min((cfg.interval || PAUSE_PROBE_FIRST_MS) * 2, PAUSE_PROBE_MAX_MS) });
      run.stop = "probe";
      if (probe.entry) run.failed.push(probe.entry);
    }
    await appendDrainLog(env, run);
    return { drained: run.cached.length, mode: "probe", probed: true, up: !!probe.up };
  }

  const used = await usageCount(env);
  if (used >= MONTHLY_CHAR_BUDGET) {
    run.stop = "budget"; run.ms = 0;
    await appendDrainLog(env, run);
    return { drained: 0, stop: "budget" };
  }

  // IDLE SHORT-CIRCUIT. A recently-confirmed-empty order snapshot means there is
  // nothing to drain: return after ONE read instead of paying a lock write plus a
  // list every idle minute. An enqueue deletes the snapshot, so a new character
  // defeats this immediately and is never delayed by it.
  try {
    const s0 = await kvGetJson(env, Q_ORDER_KEY);
    if (s0 && Array.isArray(s0.items) && !s0.items.length && Date.now() - (s0.ts || 0) < Q_ORDER_IDLE_TTL_MS) {
      return { drained: 0, idle: true };
    }
  } catch (e) {}

  // Serialize drains so the cron and an enqueue kick can never double-fetch.
  try { if (await env.CHARS.get(DRAIN_LOCK_KEY)) return { drained: 0, locked: true }; } catch (e) {}
  // TTL 60, NOT 55 OR ANYTHING SMALLER. KV's minimum expirationTtl is 60; below it
  // the put THROWS, straight into the silent catch below, so the lock never engages
  // and drains overlap invisibly. That was a real astrogem incident. And a failed
  // put must be SEEN — log it, then keep draining: availability over exclusion.
  try { await env.CHARS.put(DRAIN_LOCK_KEY, "1", { expirationTtl: 60 }); }
  catch (e) { console.log("[drain] lock write failed (drains may overlap): " + ((e && e.message) || e)); }

  const perRun = cfg.drainPerMin;
  const delayMs = drainSpacingMs(perRun);
  const items = await listQueueOrder(env);
  const removed = {};
  let processed = 0, cached = 0, failed = 0, consecFail = 0;

  for (const it of items) {
    if (processed >= perRun || Date.now() - t0 > DRAIN_BUDGET_MS) {
      run.stop = processed >= perRun ? "full" : "time";
      break;
    }
    if (!it.r || !it.n) { try { await env.CHARS.delete(it.k); } catch (e) {} removed[it.k] = 1; continue; }

    let tok = "";
    try { const v = await env.CHARS.get(it.k, "json"); tok = (v && v.t) || ""; } catch (e) {}

    if (processed > 0) await sleep(delayMs);      // the 3s floor, between fetches
    try { await env.CHARS.put(LASTFETCH_KEY, String(Date.now())); } catch (e) {}

    let r = null;
    try { r = await loadCharacter(env, it.r, it.n, { refresh: true, publish: true, token: tok }); }
    catch (e) { r = null; }
    processed++;

    const fe = (r && r.fetchError) || null;
    const upstream = fe ? fe.upstreamStatus : (r && r.upstreamStatus) || null;
    const ourStatus = fe ? fe.status : (r && !r.ok ? r.status : 0);

    if (r && r.ok && !r.stale) {
      consecFail = 0; cached++;
      run.cached.push(it.r + ":" + it.n);
      try { await env.CHARS.delete(it.k); } catch (e) {}
      removed[it.k] = 1;
    } else if (ourStatus >= 400 && ourStatus < 500) {
      // OUR 4xx: no such page, or a page with no bracelet on it. Drop it and
      // remember WHY for an hour, so the client can be told instead of spinning.
      consecFail = 0;
      try { await env.CHARS.delete(it.k); } catch (e) {}
      removed[it.k] = 1;
      try {
        await env.CHARS.put(NOTFOUND_PREFIX + charKey(it.r, it.n),
          String((r && r.body && r.body.message) || (fe && fe.error) || ("HTTP " + ourStatus)).slice(0, 300),
          { expirationTtl: NOTFOUND_TTL_S });
      } catch (e) {}
      run.dropped.push({ region: it.r, name: it.n, status: ourStatus, msg: (r && r.body && r.body.error) || "dropped" });
    } else if (upstream === 401 || upstream === 403) {
      // Both Bearers were refused — fetchCharacterPage already retried a stale
      // requester token on BIBLE_TOKEN before it got here. So this is either one
      // dead sign-in on a Worker with no secret set, or the secret itself is dead.
      //
      // Drop the item either way (one bad token must not freeze the queue for
      // everybody) but COUNT IT toward the fail streak, so a dead secret trips the
      // breaker in five instead of quietly eating the whole queue one item at a
      // time. That silent-drain-to-nothing is exactly what this branch used to do.
      try { await env.CHARS.delete(it.k); } catch (e) {}
      removed[it.k] = 1;
      run.dropped.push({ region: it.r, name: it.n, status: ourStatus, upstream: upstream,
        msg: "auth — both the requester's token and BIBLE_TOKEN were refused" });
      if (++consecFail >= PAUSE_FAIL_LIMIT) {
        await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(), interval: PAUSE_PROBE_FIRST_MS });
        run.stop = "auth";
        break;
      }
    } else if (upstream >= 400 && upstream < 500) {
      // A site-wide refusal (429 rate limit, 418/451 anti-bot). Stop now.
      run.failed.push({ region: it.r, name: it.n, status: ourStatus, upstream: upstream, msg: "blocked", att: 1 });
      await requeueFront(env, run.failed);
      await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(), interval: PAUSE_PROBE_FIRST_MS });
      run.stop = "blocked";
      break;
    } else {
      // Transient. Leave it queued so one slow character cannot head-of-line block
      // the rest, but count the attempts — a permanently broken name gets dropped
      // rather than retried at the head forever.
      failed++;
      const att = (it.a | 0) + 1;
      run.failed.push({ region: it.r, name: it.n, status: ourStatus, upstream: upstream,
        msg: (fe && fe.error) || (r && r.body && r.body.error) || "network/timeout", att: att });
      try {
        if (att >= MAX_FETCH_ATTEMPTS) { await env.CHARS.delete(it.k); removed[it.k] = 1; }
        else {
          // Keep the FIFO place (ts) and the stored token. Rewriting the value to ""
          // here is how astrogem lost tokens and then dropped the retry as a 401.
          await env.CHARS.put(it.k, JSON.stringify({ t: tok }), {
            metadata: { region: it.r, name: it.n, ts: it.t, attempts: att }, expirationTtl: QUEUE_TTL_S
          });
        }
      } catch (e) {}
      if (++consecFail >= PAUSE_FAIL_LIMIT) {
        await requeueFront(env, run.failed);
        await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(), interval: PAUSE_PROBE_FIRST_MS });
        run.stop = "paused";
        break;
      }
    }
  }

  // Refresh the order snapshot: what is still queued, in drain order. Position and
  // metrics reads use it instead of listing.
  try {
    await env.CHARS.put(Q_ORDER_KEY, JSON.stringify({
      ts: Date.now(), items: items.filter(function (it) { return !removed[it.k]; })
    }));
  } catch (e) {}

  run.ms = Date.now() - t0;
  // A run that did nothing is NOT logged. Liveness shows in the queue depth; an
  // empty log next to an empty queue is the healthy case, and logging every idle
  // minute would cost a KV write a minute to say nothing.
  if (run.cached.length || run.failed.length || run.dropped.length) await appendDrainLog(env, run);
  if (cached > 0) {
    try { await env.CHARS.put(LASTWRITE_KEY, String(Date.now())); } catch (e) {}
    await bumpUsage(env, cached);
  }
  try { await env.CHARS.delete(DRAIN_LOCK_KEY); } catch (e) {}
  return { drained: cached, failed: failed, processed: processed, stop: run.stop };
}

/**
 * The KICK: fetch ONE just-queued character directly, with no `list()` at all.
 *
 * KV list is eventually consistent, so the key an enqueue just wrote is invisible
 * to a list() issued a moment later — without this, a brand-new character is
 * skipped by the very drain that should pick it up and waits a full minute for
 * the next cron. Named keys are read-your-writes, so going straight at the key
 * dodges the problem entirely.
 *
 * It observes the same 3s floor, and refuses to run while a drain holds the lock,
 * so "one page every three seconds" survives the extra lane.
 */
async function kickFetch(env, region, name, token) {
  if (!env || !env.CHARS) return;
  try { const cfg = await getDrainConfig(env); if (cfg.mode !== "run") return; } catch (e) { return; }
  try { if (await env.CHARS.get(DRAIN_LOCK_KEY)) return; } catch (e) {}   // a drain owns the pacing right now
  const key = charKey(region, name);
  const t0 = Date.now();
  await spaceUpstream(env);
  let r = null;
  try { r = await loadCharacter(env, region, name, { refresh: true, publish: true, token: token }); } catch (e) { r = null; }
  if (r && r.ok && !r.stale) {
    try {
      await env.CHARS.delete(QUEUE_PREFIX + key);
      await bumpUsage(env, 1);
      // Log it, or a sub-second kick is invisible to the admin: it drains before the
      // queue list ever shows the item, and the log would claim nothing happened.
      await appendDrainLog(env, { t: Date.now(), cached: [region + ":" + name], dropped: [], failed: [], stop: null, kick: true, ms: Date.now() - t0 });
    } catch (e) {}
  } else if (r && !r.ok && r.status >= 400 && r.status < 500) {
    try {
      await env.CHARS.delete(QUEUE_PREFIX + key);
      await env.CHARS.put(NOTFOUND_PREFIX + key, String((r.body && r.body.message) || ("HTTP " + r.status)).slice(0, 300), { expirationTtl: NOTFOUND_TTL_S });
      await appendDrainLog(env, { t: Date.now(), cached: [],
        dropped: [{ region: region, name: name, status: r.status, msg: (r.body && r.body.error) || "dropped" }],
        failed: [], stop: null, kick: true, ms: Date.now() - t0 });
    } catch (e) {}
  }
  // A block or a transient failure is left queued for the cron, which owns the breaker.
}

// ---------------------------------------------------------------------------
// The leaderboard snapshot — ARCHITECTURE §1.2 and §2.5
// ---------------------------------------------------------------------------

// Workers-native gzip. No library, no dependency, and the same CompressionStream
// the runtime would use if it were compressing the response itself.
async function gzipString(s) {
  const cs = new CompressionStream("gzip");
  return new Response(new Response(s).body.pipeThrough(cs)).arrayBuffer();
}
async function gunzipToJson(buf) {
  const ds = new DecompressionStream("gzip");
  return new Response(new Response(buf).body.pipeThrough(ds)).json();
}

/**
 * Is this KV key a character record? Everything else in the namespace — the
 * queue (whose VALUE holds a user's token), the markers, the drain state, the
 * feedback notes, the roster cache — must never be read into a public payload.
 * A prefix-less list() is exactly the operation that would do it by accident.
 */
function isCharKey(n) {
  return n.indexOf(CHAR_PREFIX) === 0;
}

/** The board row we keep per character, before it is packed for the wire. */
function snapshotEntry(rec) {
  if (!rec || !Array.isArray(rec.stats) || !rec.stats.length) return null;
  if (rec.published === false) return null;             // reading your own bracelet ≠ joining a public board
  return {
    region: rec.region, name: rec.name,
    itemLevel: rec.itemLevel == null ? null : rec.itemLevel,
    "class": rec["class"] || null,
    pulledAt: rec.pulledAt || 0,
    grade: (rec.score && rec.score.grade) || null,
    stats: rec.stats
  };
}
function entryId(e) { return (e.region + ":" + e.name).toLowerCase(); }

/**
 * ARCHITECTURE §1.2, on the wire:
 *
 *   { v:1, builtAt, classes:[…],
 *     characters:[ [region, name, itemLevel, classIdx, pulledAt, grade, statsPacked] ] }
 *
 * `statsPacked` is the raw stat tuples flattened to numbers (type, index, value,
 * fixed) × N — a bracelet is at most five lines, so a row is ~25 numbers.
 *
 * The class table rides INSIDE the payload. A table shipped separately is a table
 * that drifts: the client would decode last week's indices against this week's
 * list and mislabel every row, silently.
 */
function encodeSnapshot(builtAt, entries) {
  const classes = [], classIdx = {};
  function ci(n) {
    if (!n) return -1;
    if (classIdx[n] == null) { classIdx[n] = classes.length; classes.push(n); }
    return classIdx[n];
  }
  const characters = entries.map(function (e) {
    const packed = [];
    for (const s of (e.stats || [])) {
      packed.push(s.type == null ? 0 : s.type, s.index == null ? 0 : s.index,
        s.value == null ? 0 : s.value, s.fixed ? 1 : 0);
    }
    return [e.region, e.name, e.itemLevel, ci(e["class"]), e.pulledAt || 0, e.grade || null, packed];
  });
  return { v: 1, builtAt: builtAt, classes: classes, characters: characters };
}

/** The mutation source (plain entries, gzipped). The served payload is packed. */
async function readSnapshotSource(env) {
  try {
    const gz = await env.CHARS.get(SNAPSHOT_SRC_KEY, "arrayBuffer");
    if (gz && gz.byteLength) {
      const v = await gunzipToJson(gz);
      if (Array.isArray(v)) return v;
    }
  } catch (e) {}
  return null;
}

/**
 * One chunk of a from-scratch build. Returns null while unfinished, with the
 * progress parked in KV, and the finished list on the tick that completes it.
 *
 * CHUNKED because a Worker invocation gets ~1,000 subrequests and each record is
 * a KV get. Astrogem's unchunked version died mid-flight on every tick once its
 * store passed ~5.5k characters and left its board permanently empty — not
 * stale, EMPTY, because the build never once reached the write at the end.
 * Only the first build pays this; every later one is incremental.
 */
async function buildEntriesChunk(env) {
  let acc = [], cursor;
  const st = await kvGetJson(env, REBUILD_CURSOR_KEY);
  if (st) {
    cursor = st.c || undefined;
    try {
      const gz = await env.CHARS.get(REBUILD_ACC_KEY, "arrayBuffer");
      acc = (gz && gz.byteLength) ? await gunzipToJson(gz) : [];
      if (!Array.isArray(acc)) { acc = []; cursor = undefined; }
    } catch (e) { acc = []; cursor = undefined; }        // corrupt accumulator -> restart clean
  }
  const res = await env.CHARS.list({ prefix: CHAR_PREFIX, cursor: cursor, limit: REBUILD_KEYS_PER_RUN });
  const names = [];
  for (const k of res.keys) if (isCharKey(k.name)) names.push(k.name);
  const records = await Promise.all(names.map(function (k) { return kvGetJson(env, k); }));
  for (const rec of records) {
    const e = snapshotEntry(rec);
    if (e) acc.push(e);
  }
  if (!res.list_complete) {
    await env.CHARS.put(REBUILD_ACC_KEY, await gzipString(JSON.stringify(acc)));
    await env.CHARS.put(REBUILD_CURSOR_KEY, JSON.stringify({ c: res.cursor }));
    return null;
  }
  const byId = {};
  for (const e of acc) {
    const id = entryId(e);
    if (!byId[id] || (e.pulledAt || 0) >= (byId[id].pulledAt || 0)) byId[id] = e;
  }
  try { await env.CHARS.delete(REBUILD_CURSOR_KEY); } catch (e) {}
  try { await env.CHARS.delete(REBUILD_ACC_KEY); } catch (e) {}
  return Object.keys(byId).map(function (id) { return byId[id]; });
}

/**
 * Rebuild the snapshot if anything changed. Runs on the cron.
 *
 * READ THE THROTTLE KEY FIRST. Inside the window the answer is "return" whether
 * or not anything is dirty, so listing the dirty markers before checking the
 * clock buys nothing and costs a list() every single minute — about 43,000 a
 * month to learn something one cheap get() already knew.
 */
async function rebuildSnapshotIfChanged(env, minIntervalMs) {
  if (!env || !env.CHARS) return { skipped: "no_kv" };
  const interval = (typeof minIntervalMs === "number") ? minIntervalMs : SNAPSHOT_MIN_INTERVAL_MS;
  const builtAt = parseInt((await env.CHARS.get(BUILTAT_KEY)) || "0", 10);
  if (builtAt > 0 && (Date.now() - builtAt) < interval) return { skipped: "throttled" };

  let dirty;
  try { dirty = await env.CHARS.list({ prefix: DIRTY_PREFIX, limit: 1000 }); } catch (e) { return { skipped: "list_failed" }; }
  if (builtAt > 0 && !dirty.keys.length) return { skipped: "clean" };

  const startedAt = Date.now();
  let entries = await readSnapshotSource(env);
  let fromScratch = false;

  if (entries && entries.length) {
    // INCREMENTAL: read only the records the markers point at.
    const idx = {};
    for (let i = 0; i < entries.length; i++) idx[entryId(entries[i])] = i;
    const charKeys = dirty.keys.map(function (k) { return k.name.slice(DIRTY_PREFIX.length); });
    const recs = await Promise.all(charKeys.map(function (ck) { return kvGetJson(env, ck); }));
    const drop = {};
    for (let i = 0; i < recs.length; i++) {
      const e = snapshotEntry(recs[i]);
      if (e) {
        const id = entryId(e);
        if (idx[id] != null) entries[idx[id]] = e;
        else { idx[id] = entries.length; entries.push(e); }
      } else {
        // The marker points at a record that is gone or unpublished — a takedown, a
        // "forget me", a bracelet that came off. A rebuild that only ever upserts
        // would leave the row on the board forever, which is the one outcome a
        // takedown route must not have. Remove it by key.
        const ck = charKeys[i] || "";
        const id = ck.slice(CHAR_PREFIX.length).toLowerCase();
        if (id) drop[id] = 1;
      }
    }
    if (Object.keys(drop).length) {
      entries = entries.filter(function (e) { return !drop[entryId(e)]; });
    }
  } else {
    fromScratch = true;
    entries = await buildEntriesChunk(env);
    if (!entries) return { chunked: true };            // progress parked; resume next tick
  }

  const payload = encodeSnapshot(startedAt, entries);
  const gz = await gzipString(JSON.stringify(payload));
  await env.CHARS.put(SNAPSHOT_GZ_KEY, gz);
  await env.CHARS.put(SNAPSHOT_SRC_KEY, await gzipString(JSON.stringify(entries)));
  await env.CHARS.put(BUILTAT_KEY, String(startedAt));

  // Clear ONLY the markers we listed. Anything written mid-build keeps its marker
  // and is picked up next time. A finished from-scratch build keeps them ALL: it
  // spanned several ticks, so a record re-pulled during it may be newer than the
  // page this build read.
  if (!fromScratch) {
    await Promise.all(dirty.keys.map(function (k) { return env.CHARS.delete(k.name).catch(function () {}); }));
  }
  return { built: entries.length, bytes: gz.byteLength, builtAt: startedAt, fromScratch: fromScratch };
}

/**
 * GET /?list=1 (and GET /list) — the board.
 *
 * ONE KV read and no JSON work: the stored bytes are already gzip and already the
 * exact payload, so they go out as-is. `encodeBody: "manual"` is what makes that
 * safe — WITHOUT IT the runtime sees `Content-Encoding: gzip` on a body it thinks
 * is plain and gzips it a second time, and the browser unpacks one layer and
 * chokes on the other.
 *
 * A caller that did not ask for gzip (plain curl, an odd script) gets it
 * decompressed here, because the edge does not do that for us.
 */
async function handleList(env, acceptEncoding) {
  if (!env || !env.CHARS) return json({ v: 1, builtAt: 0, classes: [], characters: [] }, 200);
  try {
    const gz = await env.CHARS.get(SNAPSHOT_GZ_KEY, "arrayBuffer");
    if (gz && gz.byteLength) {
      if (!/gzip/i.test(acceptEncoding || "")) {
        return new Response(new Response(gz).body.pipeThrough(new DecompressionStream("gzip")), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(gz, {
        status: 200,
        encodeBody: "manual",
        headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }
      });
    }
  } catch (e) {}
  // No snapshot yet. An empty list, not an error: the client reads "no rows" as
  // "the board is not built" and falls back to its baked copy, which is true.
  return json({ v: 1, builtAt: 0, classes: [], characters: [],
    note: "No snapshot has been built yet. The cron rebuilds every 10 minutes when a record has changed." }, 200);
}

// ---------------------------------------------------------------------------
// Feedback — ARCHITECTURE §3.6
// ---------------------------------------------------------------------------

/**
 * POST /feedback — public, no sign-in.
 *
 * The honeypot answers 200 and stores nothing. It must be indistinguishable from
 * a real accept: a form-filler that learns it was caught just tries again with
 * the field left empty.
 *
 * Caps TRUNCATE rather than reject. The client truncates to the same numbers, so
 * agreement is the normal case; when the two disagree, the cost should be a few
 * characters, not the whole note.
 */
async function handleFeedback(env, request, ip) {
  // Feedback used to be the one write path with no limit under the hard cap. Its
  // own key in the shared per-IP namespace fixes that without touching lookups.
  if (env.LOOKUP_THROTTLE) {
    const t = await env.LOOKUP_THROTTLE.limit({ key: "fb:" + ip });
    if (!t.success) return json({ error: "slow_down", message: "A few notes a minute is the limit — please wait a moment and send it again.", rateLimited: true, retryAfterMs: 20000 }, 429);
  }
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request", message: "Body must be JSON." }, 400); }
  if (body && String(body.hp || "").trim()) return json({ ok: true }, 200);      // caught: accept and drop
  const message = String((body && body.message) || "").trim().slice(0, FB_MSG_MAX);
  if (!message) return json({ error: "bad_request", message: "A message is required." }, 400);
  if (!env || !env.CHARS) return json({ error: "no_kv", message: "Feedback storage is not configured." }, 503);

  const ts = Date.now();
  const rec = {
    ts: ts,
    type: String((body && body.type) || "other").trim().slice(0, FB_TYPE_MAX),
    message: message,
    contact: String((body && body.contact) || "").trim().slice(0, FB_CONTACT_MAX),
    ua: (request.headers.get("User-Agent") || "").slice(0, FB_UA_MAX),
    read: false
  };
  // The millisecond timestamp leads the key, so LEXICOGRAPHIC ORDER IS CHRONOLOGICAL
  // and the tail of a list() is the newest — which is what bounds the admin read at
  // ≤200 gets instead of reading every note ever written.
  const key = FB_PREFIX + ts + "-" + Math.random().toString(36).slice(2, 8);
  try { await env.CHARS.put(key, JSON.stringify(rec), { expirationTtl: FB_TTL_S }); }
  catch (e) { return json({ error: "store_failed", message: "Could not save that note." }, 500); }
  return json({ ok: true }, 200);
}

/** GET /admin/feedback — the newest ≤200, plus how many exist and how many are unread. */
async function handleAdminFeedback(env) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  const keys = [];
  let cursor;
  do {
    const res = await env.CHARS.list({ prefix: FB_PREFIX, cursor: cursor, limit: 1000 });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  const newest = keys.slice(-FB_LIST_MAX);              // the list is oldest-first; the tail is newest
  const recs = await Promise.all(newest.map(function (k) {
    return kvGetJson(env, k).then(function (r) { return r ? Object.assign({ id: k.slice(FB_PREFIX.length) }, r) : null; });
  }));
  const items = recs.filter(Boolean).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  return json({ ok: true, items: items, count: items.length, total: keys.length,
    unread: items.filter(function (x) { return !x.read; }).length }, 200);
}

/** POST /admin/feedback {read|del} — mark read or delete. POST, so no <img> can do it. */
async function handleAdminFeedbackMutate(env, request, u) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const del = (body && body.del) || u.searchParams.get("del");
  const read = (body && body.read) || u.searchParams.get("read");
  if (del) {
    const k = FB_PREFIX + String(del).replace(/^fb:/, "");
    try { await env.CHARS.delete(k); } catch (e) {}
    return json({ ok: true, deleted: k }, 200);
  }
  if (read) {
    const k = FB_PREFIX + String(read).replace(/^fb:/, "");
    try {
      const r = await kvGetJson(env, k);
      // Re-putting refreshes the 90-day TTL. Acceptable: a note the admin has just
      // touched may reasonably live another 90 days.
      if (r) { r.read = true; await env.CHARS.put(k, JSON.stringify(r), { expirationTtl: FB_TTL_S }); }
    } catch (e) {}
    return json({ ok: true, read: k }, 200);
  }
  return json({ error: "bad_request", message: "Send { read: \"<id>\" } or { del: \"<id>\" }." }, 400);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Length-check the two things that become a KV key, at the top of the router.
 *
 * Astrogem does not, and several of its CHARS.get() calls are not try-wrapped, so
 * an oversized key throws past the CORS wrapper into a 500 with no CORS headers —
 * a browser then reports it as a network error and the real cause is invisible.
 */
function validateNameRegion(rawRegion, rawName) {
  const name = String(rawName || "").trim();
  if (!name) return { err: json({ error: "bad_request", message: "name is required." }, 400) };
  if (name.length > 40) return { err: json({ error: "bad_request", message: "That name is too long to be a character name." }, 400) };
  const raw = String(rawRegion || "NA").trim();
  if (raw.length > 8) return { err: json({ error: "bad_region", message: "region must be NA or CE." }, 400) };
  const region = normRegion(raw);
  if (!region) return { err: json({ error: "bad_region", message: "region must be NA or CE (lostark.bible calls EU Central 'CE')." }, 400) };
  return { name: name, region: region };
}

/**
 * GET /character (and its /bracelet alias) — the one route the import UI calls.
 *
 *   ?queue=1        answer with a queue position instead of holding the request
 *                   open for an upstream fetch
 *   ?pos=1          include position/total (costs a list(); the client asks for it
 *                   on the first lookup and its 30s re-syncs, not on every tick)
 *   ?refresh=1      the Re-pull button: bypass the cache
 *
 * NO SIGN-IN, AND NO OWNERSHIP CHECK — any name, any region, any visitor (see the
 * header for whose decision that is and what would reverse it). A Bearer is still
 * read when the caller has one, because a request attributable to the human who
 * asked for it beats one attributable to Shizu's secret; with none, the secret
 * carries it. What actually holds the volume down is below, in order: the drain
 * mode, the `nf:` marker, the global gate, the per-IP throttle, the monthly
 * budget and the site-wide enqueue gate.
 *
 * The flags the client branches on, in the order it reads them:
 *   unavailable  the drain is off or probing — no character page will be fetched
 *   queued       it is in the queue; position/total/drainPerMin say where
 *   degraded     the global gate tripped; new work is paused for everyone
 */
async function handleCharacter(env, request, u, ip, ctx, degraded) {
  const v = validateNameRegion(u.searchParams.get("region"), u.searchParams.get("name"));
  if (v.err) return v.err;
  const name = v.name, region = v.region, key = charKey(region, name);

  const wantQueue = u.searchParams.get("queue") === "1";
  const wantPos = u.searchParams.get("pos") === "1";
  const refresh = u.searchParams.get("refresh") === "1";
  const publish = u.searchParams.get("publish") !== "0";

  // ---- 1) CACHED, at any age -------------------------------------------------
  // Served instantly and labelled: `cached` always, `stale` past 7 days. A stale
  // record is never auto-refetched — bracelets change rarely, and background churn
  // is exactly the upstream load we promised not to generate. Re-pull is the path.
  let cached = null;
  if (env.CHARS) {
    cached = await kvGetJson(env, key);
    if (cached && !Array.isArray(cached.stats)) cached = null;
  }
  if (cached && !refresh && typeof cached.pulledAt === "number") {
    // `published:false` means "keep me off the public board" — snapshotEntry drops
    // such a record and always will. It never meant "nobody may look this
    // character up": the same page is on lostark.bible for anyone to read, and
    // since 2026-08-11 there is no sign-in here to check it against. So a cached
    // record answers whoever asks, and the board flag is left exactly as it was.
    const out = characterResponse({ record: cached, cached: true,
      stale: (Date.now() - cached.pulledAt) >= CHAR_TTL_MS });
    if (wantQueue && env.CHARS) {
      // Cached AND queued happens on a Re-pull: the client keeps the old bracelet
      // on screen with a refresh banner over it. Both facts in one answer.
      const q = await env.CHARS.get(QUEUE_PREFIX + key);
      if (q !== null) {
        out.queued = true;
        if (wantPos) Object.assign(out, await queueStatus(env, region, name));
      }
    }
    return json(out, 200);
  }

  // ---- 2) A page fetch is needed --------------------------------------------
  // Everything from here consumes lostark.bible, so everything from here is gated.

  // Drain mode first, for BOTH paths. "off" and "probe" mean this Worker is making
  // no character-page requests at all, and the inline path is a character-page
  // request like any other — it used to slip past this check because a sign-in
  // stood in front of it, and nothing stands in front of it now.
  const cfg = await getDrainConfig(env);
  if (cfg.mode !== "run") {
    return json({ unavailable: true, error: "unavailable",
      message: UNAVAILABLE_MSG + " — nothing is being fetched from lostark.bible right now, and that is temporary. Cached characters and the board still work." }, 503);
  }

  if (!wantQueue) {
    // Legacy inline path, kept for curl and the test harness: fetch and answer in
    // one request. The UI never takes it — it sets queue=1 so a slow upstream
    // cannot hold a browser request open.
    //
    // It reaches lostark.bible exactly as the drain does, so it pays exactly the
    // same tolls: the busy gate, the per-IP throttle, the monthly budget, the
    // site-wide enqueue gate and the 3s spacing floor. It used to skip the budget
    // and the enqueue gate, which was survivable only while a sign-in was needed
    // to get here at all.
    if (degraded) return json({ error: "busy", message: "The site is very busy right now — this is temporary, please try again shortly.", rateLimited: true, degraded: true }, 429);
    if (env.LOOKUP_THROTTLE) {
      const t = await env.LOOKUP_THROTTLE.limit({ key: lookupKey(ip) });
      if (!t.success) return json({ error: "slow_down", message: "That is a lot of new characters at once — you have hit the lookup limit, which resets in under a minute.", rateLimited: true, retryAfterMs: 20000 }, 429);
    }
    if (await usageCount(env) >= MONTHLY_CHAR_BUDGET) {
      return json({ error: "monthly_budget", monthlyBudget: true,
        message: "This month's character-fetch budget is spent — new lookups resume next month. Cached characters and the board still work." }, 503);
    }
    if (env.IMPORT_GATE) {
      const g = await env.IMPORT_GATE.limit({ key: "enqueue" });
      if (!g.success) return json({ error: "busy", message: "Lookups are backed up right now — this is temporary, try again in a moment.", rateLimited: true, retryAfterMs: 30000 }, 429);
    }
    await spaceUpstream(env);
    const r = await loadCharacter(env, region, name, {
      token: bearer(request), refresh: refresh, publish: publish
    });
    if (!r.ok) return json(r.body, r.status);
    if (!r.cached) await bumpUsage(env, 1);
    return json(characterResponse(r), 200);
  }

  // A name we already know has no page. Don't re-queue it, and say why.
  if (!refresh && env.CHARS) {
    const miss = await env.CHARS.get(NOTFOUND_PREFIX + key);
    if (miss) {
      return json({ notFound: true, error: "no_such_character",
        message: (typeof miss === "string" && miss.length > 3) ? miss : noSuchMsg(region, name) }, 404);
    }
  }
  if (degraded) {
    return json({ error: "busy", message: "The site is very busy right now — this is temporary, please try again shortly.", rateLimited: true, degraded: true }, 429);
  }

  // No sign-in, no ownership check: any name may be looked up. The caller's own
  // token rides along when they have one — better attribution, and it spreads the
  // upstream load over many sign-ins instead of one secret — and is stored with
  // the queue item so the drain fetches as the person who asked.
  const token = bearer(request);

  // Already queued — by this caller a moment ago, or by someone else. Report where
  // it is; never add it twice.
  if (env.CHARS) {
    const q = await env.CHARS.get(QUEUE_PREFIX + key);
    if (q !== null) return queuedResponse(env, region, name, { alreadyQueued: true }, wantPos, cached);
  }

  if (env.LOOKUP_THROTTLE) {
    const t = await env.LOOKUP_THROTTLE.limit({ key: lookupKey(ip) });
    if (!t.success) return json({ error: "slow_down", message: "That is a lot of new characters at once — you have hit the lookup limit, which resets in under a minute. Characters already cached still load instantly.", rateLimited: true, retryAfterMs: 20000 }, 429);
  }
  if (await usageCount(env) >= MONTHLY_CHAR_BUDGET) {
    return json({ error: "monthly_budget", monthlyBudget: true,
      message: "This month's character-fetch budget is spent — new lookups resume next month. Cached characters and the board still work." }, 503);
  }
  // Site-wide enqueue cap: the queue must never grow faster than the drain empties
  // it, however many people arrive at once.
  if (env.IMPORT_GATE) {
    const g = await env.IMPORT_GATE.limit({ key: "enqueue" });
    if (!g.success) return json({ error: "busy", message: "The lookup queue is busy right now — this is temporary, try again in a moment.", rateLimited: true, retryAfterMs: 30000 }, 429);
  }

  await enqueue(env, region, name, token);
  if (ctx && ctx.waitUntil) ctx.waitUntil(kickFetch(env, region, name, token));
  return queuedResponse(env, region, name, { justQueued: true }, wantPos, cached);
}

/**
 * GET /wait?region=&name=&since= — the long poll.
 *
 * Holds for up to 25s and answers the moment the drain stores a record newer than
 * `since`, so the client's banner clears in seconds instead of on its 30s tick.
 * `{done:false}` on timeout means "reconnect", not "failed".
 *
 * NO SIGN-IN — a signed-out visitor queues lookups now, so a signed-out visitor
 * must be able to watch them.
 *
 * PRE-CHECK BEFORE HOLDING, WHICH IS NOW THE WHOLE DEFENCE. Astrogem's version
 * held the connection and polled KV for ANY name a stranger typed — about 34 KV
 * reads per request: a read amplifier anyone could point at the namespace. The
 * ownership check used to stand in front of that; the cheap pre-check below now
 * stands there alone, and it is enough, because it costs three reads and holds
 * the connection ONLY for a lookup that is genuinely pending — and what may be
 * pending is capped site-wide by the enqueue gate.
 *
 * Every early answer pauses ~2s before returning, because the client reconnects
 * the instant it sees {done:false} — without the pause a not-pending name becomes
 * a tight loop against this Worker. That pause is load-bearing; keep it.
 */
async function handleWait(env, request, u) {
  const v = validateNameRegion(u.searchParams.get("region"), u.searchParams.get("name"));
  if (v.err) return v.err;
  const name = v.name, region = v.region, key = charKey(region, name);
  const since = parseInt(u.searchParams.get("since"), 10) || 0;
  if (!env || !env.CHARS) return json({ done: false }, 200);

  const isDone = function (rec) {
    return rec && Array.isArray(rec.stats) && rec.stats.length && (rec.pulledAt || 0) > since;
  };
  const doneJson = function (rec) {
    return json(Object.assign({ done: true }, characterResponse({ record: rec, cached: true })), 200);
  };
  const missJson = function (miss) {
    return json({ done: false, notFound: true, error: "no_such_character",
      message: (typeof miss === "string" && miss.length > 3) ? miss : noSuchMsg(region, name) }, 200);
  };

  const [rec0, miss0, q0] = await Promise.all([
    kvGetJson(env, key),
    env.CHARS.get(NOTFOUND_PREFIX + key),
    env.CHARS.get(QUEUE_PREFIX + key)
  ]);
  if (isDone(rec0)) return doneJson(rec0);
  if (miss0) return missJson(miss0);
  if (q0 === null) {
    // Not queued and nothing newer stored. One short grace re-check: a kick deletes
    // its queue key a beat before the fresh record is readable here, so answering
    // "nothing pending" immediately would end the watch one moment too early.
    await sleep(2000);
    const [rec1, q1] = await Promise.all([kvGetJson(env, key), env.CHARS.get(QUEUE_PREFIX + key)]);
    if (isDone(rec1)) return doneJson(rec1);
    if (q1 === null) return json({ done: false }, 200);
  }

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(1500);                     // the pre-check above already covered t=0
    const rec = await kvGetJson(env, key);
    if (isDone(rec)) return doneJson(rec);
    const miss = await env.CHARS.get(NOTFOUND_PREFIX + key);
    if (miss) return missJson(miss);       // dropped while we waited — say why, don't spin
  }
  return json({ done: false }, 200);
}

/**
 * POST /import — a whole list of characters, queued in one call.
 *
 * NO OWNERSHIP CHECK since 2026-08-11, and the Bearer is optional (see the
 * header). It is still the caller's token that fetches when they have one.
 *
 * A SIGNED-OUT BATCH IS CAPPED HARDER: IMPORT_MAX_ANON instead of IMPORT_MAX. A
 * signed-in import is the roster the user just loaded; a signed-out one is a list
 * somebody typed, and it spends Shizu's own token to fetch. The per-IP throttle
 * applies here too — one import costs one lookup, whatever its length — which it
 * never did while a sign-in was the price of entry.
 *
 * Nothing is fetched inline any more: every accepted character is QUEUED and the
 * drain fetches them one at a time, three seconds apart. Fetching the first few
 * inline made an import three page loads long and, worse, put a second fetch lane
 * next to the drain's — two lanes cannot honour one spacing floor between them.
 */
async function handleImport(env, request, ip, ctx) {
  const token = bearer(request);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request", message: "Body must be JSON." }, 400); }
  const wanted = Array.isArray(body && body.characters) ? body.characters : null;
  if (!wanted) return json({ error: "bad_request", message: "Body must be { characters: [ … ] }." }, 400);
  const cap = token ? IMPORT_MAX : IMPORT_MAX_ANON;
  if (wanted.length > cap) {
    return json({ error: "too_many", message: "At most " + cap + " characters per request" +
      (token ? "." : " when signed out — sign in with lostark.bible to send up to " + IMPORT_MAX + ".") }, 400);
  }
  const publish = body.publish !== false;

  if (env.LOOKUP_THROTTLE) {
    const t = await env.LOOKUP_THROTTLE.limit({ key: lookupKey(ip) });
    if (!t.success) return json({ error: "slow_down", message: "That is a lot of new characters at once — you have hit the lookup limit, which resets in under a minute.", rateLimited: true, retryAfterMs: 20000 }, 429);
  }

  // Site-wide cap on NEW page fetches, so the queue can never grow faster than
  // the drain empties it however many users arrive at once.
  if (env.IMPORT_GATE) {
    const g = await env.IMPORT_GATE.limit({ key: "import" });
    if (!g.success) return json({ error: "busy", message: "Imports are backed up right now — this is temporary, try again in a minute.", rateLimited: true }, 429);
  }

  const cfg = await getDrainConfig(env);
  if (cfg.mode !== "run") return json({ unavailable: true, error: "unavailable", message: UNAVAILABLE_MSG + " — this is temporary." }, 503);

  const results = [];
  let queued = 0;
  for (const raw of wanted) {
    const name = String(isObj(raw) ? raw.name : raw || "").trim();
    const region = normRegion((isObj(raw) && raw.region) || body.region || "NA");
    if (!name || name.length > 40) { results.push({ name: String(raw).slice(0, 40), status: "bad_name" }); continue; }
    if (!region) { results.push({ name: name, status: "bad_region" }); continue; }

    // A record inside the 7-day window needs no fetch at all, whatever the budget.
    const ck = charKey(region, name);
    const existing = await kvGetJson(env, ck);
    if (existing && (Date.now() - (existing.pulledAt || 0)) < CHAR_TTL_MS) {
      if (publish && !existing.published) {
        existing.published = true;
        try { await env.CHARS.put(ck, JSON.stringify(existing)); await markDirty(env, ck); } catch (e) {}
      }
      results.push({ name: existing.name, region: region, status: "cached", pct: existing.score && existing.score.pct });
      continue;
    }
    await enqueue(env, region, name, token);
    queued++;
    results.push({ name: name, region: region, status: "queued" });
  }
  // One kick, for the first queued character only — the rest are the drain's, at
  // its pace. Kicking each of them would be twenty fetches with no spacing at all.
  const first = results.find(function (r) { return r.status === "queued"; });
  if (first && ctx && ctx.waitUntil) ctx.waitUntil(kickFetch(env, first.region, first.name, token));
  return json({ ok: true, results: results, queued: queued,
    drainPerMin: cfg.drainPerMin, queuedDrainEveryMinutes: 1 }, 200);
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

/** Count keys under a prefix. Cheaper and clearer than one prefix-less sweep. */
async function countPrefix(env, prefix) {
  let n = 0, cursor;
  do {
    const res = await env.CHARS.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    n += res.keys.length;
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return n;
}

/**
 * GET /admin/metrics — one call, four panels (ARCHITECTURE §3.7).
 *
 * Nested `queue` / `drain` / `drainLog` / `health` blocks, with the older flat
 * fields kept beside them so nothing that read the first shape breaks.
 *
 * `health.probeArmed` IS A BOOLEAN. The token is never returned, not truncated,
 * not hinted at — there is nothing on the admin page that could render one, and
 * a credential in a response body is a credential in someone's browser cache.
 *
 * The queue is listed LIVE rather than read from the order snapshot: there is one
 * admin, and seeing a just-enqueued character immediately is worth a list().
 */
async function handleAdminMetrics(env) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  const [items, chars, dirty, lw, ba, dlog, cfg, usage, pv] = await Promise.all([
    listQueueOrder(env).catch(function () { return []; }),
    countPrefix(env, CHAR_PREFIX).catch(function () { return null; }),
    countPrefix(env, DIRTY_PREFIX).catch(function () { return null; }),
    env.CHARS.get(LASTWRITE_KEY).catch(function () { return null; }),
    env.CHARS.get(BUILTAT_KEY).catch(function () { return null; }),
    kvGetJson(env, DRAIN_LOG_KEY).catch(function () { return null; }),
    getDrainConfig(env).catch(function () { return { mode: "run", drainPerMin: DRAIN_PER_MIN_DEFAULT }; }),
    kvGetJson(env, USAGE_KEY).catch(function () { return null; }),
    env.CHARS.get(PARSEVERSION_KEY).catch(function () { return null; })
  ]);
  const lastWrite = parseInt(lw, 10) || 0;
  const builtAt = parseInt(ba, 10) || 0;
  const drainLog = Array.isArray(dlog) ? dlog : [];
  const now = Date.now();
  const lastRun = drainLog.length ? drainLog[drainLog.length - 1].t : 0;
  const list = items.slice(0, 500).map(function (it) {
    // ts <= 1e12 is a FRONT SENTINEL (a requeue, ts=1), not a timestamp. Ageing it
    // from the epoch would print a 57-year wait; the client prints "—" for null.
    return { region: it.r, name: it.n, ts: it.t,
      waitedS: it.t > 1e12 ? Math.round((now - it.t) / 1000) : null,
      attempts: it.a || 0 };
  });
  return json({
    ok: true, nowMs: now,
    // ---- §3.7 nested blocks ----
    queue: { total: items.length, list: list, shown: list.length },
    drain: {
      mode: cfg.mode, perMin: cfg.drainPerMin, spacingMs: drainSpacingMs(cfg.drainPerMin),
      lastRun: lastRun,
      budgetUsed: (usage && usage.month === monthKey()) ? (usage.count | 0) : 0,
      budgetCap: MONTHLY_CHAR_BUDGET,
      budgetMonth: monthKey(),
      nextProbeAt: cfg.mode === "probe" ? (cfg.lastProbe || 0) + (cfg.interval || PAUSE_PROBE_FIRST_MS) : null
    },
    drainLog: drainLog,
    health: {
      lastPull: lastWrite, lastSnapshot: builtAt,
      probeArmed: !!(env && env.BIBLE_TOKEN),        // boolean only, forever
      snapshotIntervalMs: SNAPSHOT_MIN_INTERVAL_MS
    },
    // IS EACH LIMITER ACTUALLY THERE? Every gate in this file is written
    // `if (env.X) { … }`, which degrades silently to NO LIMIT when a binding is
    // missing — and a CLI deploy replaces the whole binding set, so one is one
    // typo away at any time. That was survivable while a sign-in stood in front of
    // every lookup. It is not survivable now, so the admin page can see it.
    rateLimits: {
      HARD_CAP: !!(env && env.HARD_CAP),
      LOOKUP_THROTTLE: !!(env && env.LOOKUP_THROTTLE),
      LB_THROTTLE: !!(env && env.LB_THROTTLE),
      GLOBAL_GATE: !!(env && env.GLOBAL_GATE),
      IMPORT_GATE: !!(env && env.IMPORT_GATE)
    },
    // ---- the flat fields the first version answered, kept as fallbacks ----
    characters: chars, queued: items.length, dirty: dirty,
    lastWrite: lastWrite, snapshotBuiltAt: builtAt,
    modelSig: MODEL_SIG, parseVersion: parseInt(pv, 10) || 0,
    hasBibleToken: !!(env && env.BIBLE_TOKEN),
    paused: cfg.mode !== "run"
  }, 200);
}

/**
 * POST /admin/control {mode, rate} — the drain switch.
 *
 * `rate` is clamped 1–20 here as well as in the page, because a control that
 * trusts its client is not a control. Twenty is the ceiling the 3s floor implies;
 * asking for more silently gets twenty.
 */
async function handleAdminControl(env, request, ctx) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const cur = await getDrainConfig(env);
  const next = { mode: cur.mode, drainPerMin: cur.drainPerMin };
  let modeChanged = false;

  const mode = body && body.mode;
  if (mode != null) {
    if (DRAIN_MODES.indexOf(mode) === -1) return json({ error: "bad_mode", message: "mode must be run, off or probe." }, 400);
    if (mode !== cur.mode) modeChanged = true;
    next.mode = mode;
    // Entering probe deliberately probes AT ONCE and only then starts backing off:
    // the common reason to press it is "I think it is back".
    if (mode === "probe") { next.lastProbe = 0; next.interval = PAUSE_PROBE_FIRST_MS; }
  }
  if (body && body.rate != null) {
    const rate = parseInt(body.rate, 10);
    if (!Number.isFinite(rate) || rate < 1 || rate > DRAIN_PER_MIN_MAX) {
      return json({ error: "bad_rate", message: "rate must be a whole number from 1 to " + DRAIN_PER_MIN_MAX + "." }, 400);
    }
    next.drainPerMin = rate;
  }
  await setDrainConfig(env, next);
  // Coming out of "off" should feel immediate, not "some time in the next minute".
  if (modeChanged && next.mode !== "off" && ctx && ctx.waitUntil) {
    try { ctx.waitUntil(drainQueue(env)); } catch (e) {}
  }
  return json({ ok: true, config: { mode: next.mode, drainPerMin: next.drainPerMin, spacingMs: drainSpacingMs(next.drainPerMin) } }, 200);
}

/**
 * POST /admin/dequeue {match|all} — evict queue items.
 *
 * Matching is on the KEY SUBSTRING, deliberately: some queued names are mojibake
 * and their key cannot be rebuilt from a clean string, so "delete the item whose
 * key contains this" is the only handle that always works.
 */
async function handleAdminDequeue(env, request) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const all = !!(body && body.all);
  const match = String((body && body.match) || "").toLowerCase();
  if (!all && !match) return json({ error: "bad_request", message: "Send { match: \"<key substring>\" } or { all: true }." }, 400);

  const keys = [];
  let cursor;
  do {
    const res = await env.CHARS.list({ prefix: QUEUE_PREFIX, cursor: cursor, limit: 1000 });
    for (const k of res.keys) {
      if (k.name === Q_ORDER_KEY) continue;
      if (all || k.name.toLowerCase().indexOf(match) !== -1) keys.push(k.name);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  for (const k of keys) { try { await env.CHARS.delete(k); } catch (e) {} }
  // Always drop the order snapshot afterwards, or position reads keep answering
  // from an order that still lists what was just evicted.
  try { await env.CHARS.delete(Q_ORDER_KEY); } catch (e) {}
  return json({ ok: true, removed: keys.length, keys: keys.slice(0, 200) }, 200);
}

/**
 * POST /admin/rescore — re-score stored records against the current model and
 * bump `parseVersion` so a client can tell its cached copies are behind.
 *
 * Cheap because the Worker stores RAW stats: nothing is refetched, nothing is
 * asked of lostark.bible. Chunked at RESCORE_PER_CALL records because each one
 * costs a read plus two writes and a Worker invocation gets ~1,000 subrequests;
 * the answer says how many are left, so a big store is a few clicks.
 */
async function handleAdminRescore(env, request) {
  if (!env || !env.CHARS) return json({ error: "no_kv" }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const version = (parseInt(await env.CHARS.get(PARSEVERSION_KEY), 10) || 0) + (body && body.cursor ? 0 : 1);
  if (!(body && body.cursor)) { try { await env.CHARS.put(PARSEVERSION_KEY, String(version)); } catch (e) {} }

  const res = await env.CHARS.list({ prefix: CHAR_PREFIX, cursor: (body && body.cursor) || undefined, limit: RESCORE_PER_CALL });
  const names = res.keys.map(function (k) { return k.name; });
  const recs = await Promise.all(names.map(function (k) { return kvGetJson(env, k); }));
  let done = 0, failed = 0;
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec || !Array.isArray(rec.stats)) { failed++; continue; }
    try {
      rec.score = score(rec.stats);
      if (Array.isArray(rec.loadouts)) {
        for (const l of rec.loadouts) if (Array.isArray(l.stats)) l.score = briefScore(score(l.stats));
      }
      rec.modelSig = MODEL_SIG;
      rec.scoredAt = Date.now();
      rec.parseVersion = version;
      await env.CHARS.put(names[i], JSON.stringify(rec));
      await markDirty(env, names[i]);
      done++;
    } catch (e) { failed++; }
  }
  return json({ ok: true, parseVersion: version, rescored: done, failed: failed,
    modelSig: MODEL_SIG,
    cursor: res.list_complete ? null : res.cursor,
    more: !res.list_complete }, 200);
}

/**
 * POST /admin/delete {region, name} — takedown, for anyone who asks.
 *
 * Reads the BODY (§3.7 says POST with a body) and falls back to the query string,
 * which is what it used to read and what the client still repeats. Neither carries
 * a secret: the admin token is a header and stays one.
 */
async function handleAdminDelete(env, request, u) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* query-string callers send no body */ }
  const name = String((body && body.name) || u.searchParams.get("name") || "").trim();
  const region = normRegion((body && body.region) || u.searchParams.get("region") || "NA");
  if (!name || !region) return json({ error: "bad_request", message: "name and region are required." }, 400);
  const key = charKey(region, name);
  // markDirty AFTER the delete: the marker now points at a missing record, which is
  // exactly how the snapshot rebuild learns to take the row off the board.
  try { await env.CHARS.delete(key); await markDirty(env, key); } catch (e) {}
  try { await env.CHARS.delete(QUEUE_PREFIX + key); await env.CHARS.delete(Q_ORDER_KEY); } catch (e) {}
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
    // Every minute: drain a few queued characters, paced, then rebuild the board
    // snapshot if anything changed. The rebuild reads its throttle key first, so
    // in the nine minutes out of ten when it has nothing to do it costs one get().
    try { await drainQueue(env); } catch (e) { console.log("[cron] drain failed: " + ((e && e.message) || e)); }
    try { await rebuildSnapshotIfChanged(env); } catch (e) { console.log("[cron] snapshot failed: " + ((e && e.message) || e)); }
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

  // ---- admin (X-Admin-Token, fail closed, header only) ----
  // Every mutation here is POST. A GET with side effects is a drive-by: one <img
  // src> in any page a signed-in admin opens would fire it, and /admin/drain used
  // to be exactly that — a GET that drained the queue.
  if (p.indexOf("/admin/") === 0) {
    if (!adminOk(request, env)) return json({ error: "forbidden", message: "Admin token required (X-Admin-Token header)." }, 403);
    const post = request.method === "POST";
    const postOnly = json({ error: "post_only", message: "This route is POST only — a GET with side effects is a drive-by risk." }, 405);
    if (p === "/admin/seed")     return post ? handleAdminSeed(env, request) : postOnly;
    if (p === "/admin/delete")   return post ? handleAdminDelete(env, request, u) : postOnly;
    if (p === "/admin/control")  return post ? handleAdminControl(env, request, ctx) : postOnly;
    if (p === "/admin/dequeue")  return post ? handleAdminDequeue(env, request) : postOnly;
    if (p === "/admin/rescore")  return post ? handleAdminRescore(env, request) : postOnly;
    if (p === "/admin/drain")    return post ? json(Object.assign({ ok: true }, await drainQueue(env)), 200) : postOnly;
    if (p === "/admin/snapshot") return post ? json(Object.assign({ ok: true }, await rebuildSnapshotIfChanged(env, 0)), 200) : postOnly;
    if (p === "/admin/feedback") return post ? handleAdminFeedbackMutate(env, request, u) : handleAdminFeedback(env);
    if (p === "/admin/metrics")  return handleAdminMetrics(env);
    if (p === "/admin/page")     return handleAdminPage(env, request, u);
    return json({ error: "not_found" }, 404);
  }

  // ---- writes ----
  if (request.method === "POST") {
    // Feedback is not upstream work — it stays open while the site is degraded.
    if (p === "/feedback") return handleFeedback(env, request, ip);
    if (degraded) return json({ error: "busy", message: busyMsg, rateLimited: true, degraded: true }, 429);
    if (p === "/import") return handleImport(env, request, ip, ctx);
    if (p === "/forget") return handleForget(env, request);
    return json({ error: "not_found", message: "POST /feedback, /import or /forget." }, 404);
  }

  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  // ---- the leaderboard snapshot ----
  // The stored gzip bytes, as they are. Open to everyone, throttled against a
  // held-down refresh key, and never rebuilt on demand — the cron owns the build.
  if (u.searchParams.get("list") === "1" || p === "/list") {
    if (env.LB_THROTTLE) {
      const l = await env.LB_THROTTLE.limit({ key: ip });
      if (!l.success) return json({ error: "slow_down", message: "The board refreshes every few minutes — please wait a moment.", rateLimited: true }, 429);
    }
    return handleList(env, request.headers.get("Accept-Encoding"));
  }

  // ---- the long poll ----
  if (p === "/wait") return handleWait(env, request, u);

  // ---- the import round trip ----
  // `degraded` is PASSED IN rather than answered here: a cached record must still
  // be served while the site is busy. Only the fetch/enqueue branch is paused.
  if (p === "/character" || p === "/bracelet") {
    return handleCharacter(env, request, u, ip, ctx, degraded);
  }

  // ---- public drain status, for the "lookups are paused" notice ----
  if (p === "/status") {
    const cfg = await getDrainConfig(env);
    return json({ ok: true, paused: cfg.mode !== "run", mode: cfg.mode,
      message: cfg.mode !== "run" ? UNAVAILABLE_MSG + "." : "Character lookups are running." },
      200, { "Cache-Control": "public, max-age=30" });
  }

  // ---- health ----
  if (p === "/") {
    return json({
      ok: true, service: "bracelet-bible",
      model: { version: Bracelet.VERSION, signature: Bracelet.MODEL_SIG },
      profile: "canonical-default (normalizeProfile({}))",
      kv: !!(env && env.CHARS),
      bibleToken: !!(env && env.BIBLE_TOKEN),
      routes: ["/character?name=&region=&queue=1&pos=1", "/wait?region=&name=&since=",
               "/?list=1", "/status", "POST /feedback", "POST /import", "POST /forget"]
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
  MASTER_NODE_ID: MASTER_NODE_ID, GEM_AP_LEVEL: GEM_AP_LEVEL,
  // Snapshot + drain pieces that are worth checking without a live KV. The drain
  // is the code with the least live coverage — the enqueue gate needs a real
  // lostark.bible sign-in — so its three-way failure branch, its breaker and its
  // pacing are exercised against a stub KV and a stub fetch instead.
  drainQueue: drainQueue, enqueue: enqueue, queueStatus: queueStatus,
  getDrainConfig: getDrainConfig, setDrainConfig: setDrainConfig,
  rebuildSnapshotIfChanged: rebuildSnapshotIfChanged,
  encodeSnapshot: encodeSnapshot, snapshotEntry: snapshotEntry,
  drainSpacingMs: drainSpacingMs, validateNameRegion: validateNameRegion,
  isCharKey: isCharKey,
  // The failure copy. It is checked here rather than against the live Worker
  // because the only way to see it upstream is to fetch a name that does not
  // exist, and spending a real lostark.bible request to read our own sentence is
  // exactly the kind of request we promised not to make.
  noSuchMsg: noSuchMsg, lookupKey: lookupKey, regionLabel: regionLabel,
  DRAIN_PER_MIN_MAX: DRAIN_PER_MIN_MAX, DRAIN_MIN_SPACING_MS: DRAIN_MIN_SPACING_MS,
  SNAPSHOT_MIN_INTERVAL_MS: SNAPSHOT_MIN_INTERVAL_MS, CHAR_TTL_MS: CHAR_TTL_MS
};
