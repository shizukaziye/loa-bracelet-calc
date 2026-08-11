/**
 * bible-import.js — the CHARACTER panel: pull a bracelet off a character the same
 * way the astrogem calculator's Grader pulls a gem loadout.
 *
 * This is a PORT of loa-astrogem-calc/grader.js's pull experience, kept as close
 * to it as the subject allows. What came over, function for function:
 *
 *   tabMarkup()          -> panelMarkup()      the mode pills, the pull row, the
 *                                              status line, the free-tier note and
 *                                              the saved-character grid
 *   renderAuth()         -> renderAuth()       sign in / load my characters / sign out,
 *                                              riding at the END of the mode row
 *   renderFavRow()       -> renderFavRow()     one row per saved character: ★ to
 *                                              unsave, class icon, name, region badge
 *   runPull()            -> runPull()          the five branches: unavailable ·
 *                                              needSignIn · data · queued · error
 *   startQueueWatch()    -> startQueueWatch()  the three mechanisms — a 1s local
 *                                              countdown at the drain rate, a 30s
 *                                              server re-sync, and a /wait long poll
 *   showQueued() / showRefreshBanner()         the queued panel, and the thin bar that
 *                                              rides ABOVE a cached bracelet instead
 *                                              of blanking it
 *   fillFieldRank()      -> fieldRank()        "Top 11% of Reapers (#3 of 24) · #9 of
 *                                              30 tracked characters", conservative
 *                                              estimator, class line only at n>=5
 *   loadRosters() / favoriteRoster()           sign-in -> roster -> Favorites.add each
 *   setPullStatus() / syncSourceUI() / setFreeStatus()
 *   maybeAutoRepullForCp -> maybeAutoRepullForProfile()
 *
 * WHAT IS DIFFERENT, AND WHY
 *   - Astrogem's second mode is a live gem form ("Custom input"). Ours is "Manual
 *     entry", which is a pointer at the bracelet panel below — the bracelet form
 *     already exists and is the tool's main surface, so duplicating it would be
 *     two editors for one bracelet.
 *   - Astrogem's Raid/Chaos preset pills grade two gem sets. We have the same axis
 *     for real — a lostark.bible character page carries one loadout per tab, each
 *     with its OWN bracelet, and 9 of the 30 seeded characters wear different ones
 *     — so the loadout pills take that slot, with the same segmented-pill look.
 *   - Astrogem blanks its result pane for the "queued" panel. Ours never blanks the
 *     calculator: the queued panel and the refresh bar both live in their own host
 *     above the character banner.
 *   - THE WORKER IS NOT DEPLOYED (WORKER_URL is ""). The whole pull path is built
 *     and waits on one string. Until then the 30 characters baked into
 *     data/leaderboard-seed.json load instantly, by chip or by name, so the panel
 *     is useful today.
 *
 * WHAT IT TALKS TO
 *   window.BibleOAuth      bible-oauth.js — PKCE sign-in, GET /api/oauth/rosters
 *   window.Bracelet        model/bracelet.js — decodeBibleBracelet(stats) and the
 *                          canonical-default scorer behind the board figure
 *   window.Favorites       favorites.js — the saved-character spine
 *   window.BraceletApp     app.js — applyImport(patch), the one hook into the UI
 *   WORKER_URL             worker/bracelet.js — the only thing allowed to touch a
 *                          lostark.bible character page, and only with the token
 *   data/leaderboard-seed.json — the baked board, used as a free instant cache
 *
 * NETWORK RULE, ABSOLUTE. The browser NEVER fetches a lostark.bible character page.
 * The only direct calls to that host are BibleOAuth's /oauth/* and /api/oauth/* with
 * the Bearer header. Raid statistics are never touched.
 *
 * THE SHAPE PROBLEM (still true for the roster payload). /api/oauth/rosters is an
 * INDEX — name, class, ilvl, lastUpdate, with region on the ROSTER — so nothing here
 * keys off a field name it has not seen. `findCharacters` and `findBracelet` walk
 * whatever JSON arrives looking for shapes rather than paths, and
 * `BraceletImport.dumpShape()` prints the real key paths. See
 * docs/research/oauth-rosters-shape.md.
 *
 * TWO SCORES, AND THEY DIFFER. Everything called a board figure here is the bracelet
 * on the CANONICAL DEFAULT profile, Bracelet.normalizeProfile({}) — the only number
 * the leaderboard ever ranks on. The calculator below scores the same bracelet on the
 * user's own settings. Both are on screen and the copy says which is which; an
 * imported profile must never be allowed to move a leaderboard number.
 */
(function (root) {
  "use strict";

  var OA = root.BibleOAuth;
  var B = root.Bracelet;
  var DATA = root.BraceletData;
  if (!OA || !B || !DATA) return;               // a dependency failed to load; leave the panel alone

  /**
   * The deployed bracelet-bible Worker (worker/bracelet.js). EMPTY until Shizu
   * deploys it and pastes the printed URL here — see docs/deploy-worker.md.
   *
   * Empty is a supported state, not a bug: the seeded characters still load
   * instantly by chip or by name, signing in and listing characters still works,
   * and a live pull lands on one honest sentence rather than a broken request.
   * Deploying it is the ONLY change needed to switch the whole pull path on.
   */
  var WORKER_URL = "";

  /** The baked board, used as a free instant cache. ?v= for the edge, as everywhere. */
  var SEED_URL = "data/leaderboard-seed.json?v=2";

  // One silent re-auth per page load. A dead token sends the user straight back
  // through /oauth/authorize, which auto-approves while the grant lives — but if
  // that comes back dead too, a second bounce would loop the browser forever.
  var REAUTH_FLAG = "bc_bible_reauth";
  var LAST_KEY = "bc_bi_last";      // localStorage: {region, name}, prefills next visit

  var MOUNT_ID = "bc-import";
  var REGIONS = ["NA", "EU"];

  var state = {
    mode: "pull",      // "pull" | "manual"
    busy: false,
    error: null,       // {kind, detail, who}
    user: null,
    chars: null,       // roster index: [{name, cls, ilvl, region, node}]
    raw: null,         // the last rosters payload, for dumpShape()
    picked: null,      // name of the character last imported
    note: null,        // a one-line result under the list
    // A character wears one bracelet PER LOADOUT on lostark.bible — a raid one,
    // a chaos-dungeon one, sometimes an estimated-raid one — and nine of the
    // thirty characters read so far wear a DIFFERENT bracelet in each. So the
    // panel offers them all instead of deciding for the user.
    loadouts: null,    // [{classification, label, stats, rolls, pct, grade, isRendered}]
    loadoutIdx: 0,     // which one is in the calculator right now
    bestLoadout: 0,    // the highest, which is what the board ranks
    record: null       // the whole character record on screen
  };

  // ------------------------------------------------------------------
  // shape-blind walkers
  // ------------------------------------------------------------------

  function isObj(v) { return v && typeof v === "object"; }

  /** Depth-limited, cycle-guarded walk. fn(node, key, path) on every object. */
  function walk(root_, fn) {
    var seen = [], out = [];
    (function rec(node, path, depth) {
      if (!isObj(node) || depth > 8) return;
      if (seen.indexOf(node) >= 0) return;
      seen.push(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && i < 400; i++) rec(node[i], path + "[]", depth + 1);
        return;
      }
      var r = fn(node, path);
      if (r) out.push(r);
      for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) {
        rec(node[k], path ? path + "." + k : k, depth + 1);
      }
    })(root_, "", 0);
    return out;
  }

  /** Every distinct key path in a payload — what dumpShape() reports. */
  function keyPaths(v, prefix, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 8) return out;
    if (Array.isArray(v)) {
      if (v.length) keyPaths(v[0], prefix + "[]", out, depth + 1);
    } else if (isObj(v)) {
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) {
        var p = prefix ? prefix + "." + k : k;
        if (out.indexOf(p) < 0) out.push(p);
        keyPaths(v[k], p, out, depth + 1);
      }
    }
    return out;
  }

  /**
   * Does this array look like lostark.bible's bracelet `stats`? Every entry is
   * {type, index, value} with numeric type and index. Two entries minimum, so a
   * one-element coincidence somewhere else in the payload can't win.
   */
  function looksLikeStats(a) {
    if (!Array.isArray(a) || a.length < 2) return false;
    for (var i = 0; i < a.length; i++) {
      var e = a[i];
      if (!isObj(e) || typeof e.type !== "number" || typeof e.index !== "number") return false;
    }
    return true;
  }

  /**
   * Find the bracelet inside one character node. Three shapes, most explicit
   * first — the documented character-page payload is
   * {slot:"bracelet", data:{type:"bracelet", stats:[…], numRerolls, numTicketRerolls}}.
   */
  function findBracelet(node) {
    var hits = walk(node, function (n) {
      var slot = String(n.slot || "").toLowerCase();
      var type = String(n.type || "").toLowerCase();
      if (slot === "bracelet" && isObj(n.data) && looksLikeStats(n.data.stats)) return { d: n.data, sure: 3 };
      if (type === "bracelet" && looksLikeStats(n.stats)) return { d: n, sure: 2 };
      if ((slot === "bracelet" || type === "bracelet") && looksLikeStats(n.stats)) return { d: n, sure: 2 };
      if (looksLikeStats(n.stats) && n.numRerolls !== undefined) return { d: n, sure: 1 };
      return null;
    });
    hits.sort(function (a, b) { return b.sure - a.sure; });
    return hits.length ? hits[0].d : null;
  }

  function firstString(n, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = n[keys[i]];
      if (typeof v === "string" && v) return v;
      if (isObj(v) && typeof v.name === "string" && v.name) return v.name;
    }
    return "";
  }
  function firstNumber(n, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = n[keys[i]];
      if (typeof v === "number" && isFinite(v)) return v;
      if (typeof v === "string" && /^[\d.,]+$/.test(v)) return parseFloat(v.replace(/,/g, ""));
    }
    return null;
  }

  /**
   * /api/oauth/rosters names classes with the game's internal codes
   * ("devil_hunter_female"), not the English name a player recognises. The first
   * nine rows were confirmed 2026-08-11 by joining the live payload against the
   * character pages — docs/research/oauth-rosters-shape.md has the table and the
   * working. The rest are astrogem's own CLASS_SLUG map, which follows the same
   * Korean-original naming and is UNVERIFIED; a code that is wrong shows the wrong
   * NAME, never a wrong icon, because the icon is looked up by file and a miss
   * renders nothing.
   *
   * An unknown code is title-cased, never dropped: "Devil Hunter Male" on screen
   * is a bug report, a blank is a shrug.
   */
  var CLASS_NAME = {
    // verified
    arcana: "Arcanist", berserker: "Berserker", blade: "Deathblade",
    devil_hunter_female: "Gunslinger", dragon_knight: "Guardianknight",
    alchemist: "Wildsoul", reaper: "Reaper", soul_eater: "Souleater", bard: "Bard",
    // unverified, from loa-astrogem-calc/grader.js CLASS_SLUG
    warrior: "Berserker", destroyer: "Destroyer", warlord: "Gunlancer", holyknight: "Paladin",
    berserker_female: "Slayer", valkyrie: "Valkyrie",
    battle_master: "Wardancer", infighter: "Scrapper", force_master: "Soulfist",
    lance_master: "Glaivier", battle_master_male: "Striker", infighter_male: "Breaker",
    devil_hunter: "Deadeye", devil_hunter_male: "Deadeye", blaster: "Artillerist",
    hawk_eye: "Sharpshooter", scouter: "Machinist",
    summoner: "Summoner", elemental_master: "Sorceress", demonic: "Shadowhunter",
    weather_artist: "Aeromancer", yinyangshi: "Artist"
  };
  function classLabel(code) {
    if (!code) return "";
    var k = String(code).toLowerCase();
    if (CLASS_NAME[k]) return CLASS_NAME[k];
    return k.split("_").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
  }

  var CLASS_KEYS = ["class", "className", "characterClassName", "job", "jobName", "classId"];
  var ILVL_KEYS = ["itemLevel", "ilvl", "itemMaxLevel", "gearScore", "level", "itemAvgLevel"];
  var REGION_KEYS = ["region", "world", "server", "serverName", "worldName"];
  var CONTAINER_KEYS = /^(characters|chars|members|roster|rosters)$/i;

  /**
   * A roster has a name too, and the bracelet of every character it holds sits
   * somewhere underneath it — so "carries a bracelet" alone would promote the
   * roster to a character. Anything holding a list of characters is a container.
   */
  function isContainer(n) {
    for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) {
      if (CONTAINER_KEYS.test(k) && Array.isArray(n[k]) && n[k].length && isObj(n[k][0])) return true;
    }
    return false;
  }

  /** Every character-looking object in the payload, deduped by name. */
  function findCharacters(payload) {
    var byName = {}, out = [];
    walk(payload, function (n, path) {
      if (typeof n.name !== "string" || !n.name) return null;
      if (isContainer(n)) return null;
      var cls = firstString(n, CLASS_KEYS);
      var ilvl = firstNumber(n, ILVL_KEYS);
      // A bare {name} is a roster label, a server, an owner — not a character.
      if (!cls && ilvl === null && !findBracelet(n)) return null;
      var key = n.name.toLowerCase();
      if (byName[key]) return null;
      byName[key] = 1;
      out.push({
        name: n.name,
        cls: cls,
        ilvl: ilvl,
        region: firstString(n, REGION_KEYS),
        path: path,
        node: n
      });
      return null;
    });
    return out;
  }

  // ------------------------------------------------------------------
  // decode -> the patch app.js applies
  // ------------------------------------------------------------------

  // decodeBibleBracelet names the Swiftness trait the way the official table
  // does; app.js's three trait rows call it "swift". Crit and Spec already agree.
  var TRAIT_TO_APP = { crit: "crit", spec: "spec", swiftness: "swift" };

  function slotChoices(grade) { return grade === "relic" ? [1, 2] : [2, 3]; }

  function rowFor(line) {
    if (line.cat === "basic") {
      return { fam: "basic:" + line.family, tier: "mid", value: line.value };
    }
    if (line.cat === "trait") {
      return { fam: "trait:" + line.family, tier: "mid", value: null };
    }
    if (line.cat === "special") {
      return { fam: "sp:" + line.family, tier: line.tier || "mid", value: null };
    }
    return null;
  }

  /**
   * Combat-trait caps: Relic 100, Ancient 120. A bracelet showing Crit +116 is
   * not Relic whatever else says otherwise — 63 brackets read off character
   * pages top out at 119 and none passes 120.
   */
  var TRAIT_CAP = { relic: 100, ancient: 120 };
  function traitsBreakCap(dec, grade) {
    for (var i = 0; i < dec.lines.length; i++) {
      var l = dec.lines[i];
      if (l.cat === "trait" && l.value > TRAIT_CAP[grade]) return true;
    }
    return false;
  }

  /**
   * The decoder guesses Relic or Ancient by matching special-effect values
   * against both tables, and the two tables overlap enough that it can land on
   * the wrong one. Two further witnesses settle it, strongest first:
   *
   *   1. the combat-trait cap above — a fact about the item;
   *   2. the granted-slot count (Ancient 2–3, Relic 1–2) — a guess about the
   *      player, because locking granted lines is allowed and four of the thirty
   *      seeded characters lock four of five, leaving one granted line that
   *      reads as Relic while they wear Crit +116.
   *
   * A grade change is a RE-DECODE, not a relabel: tiers have to come from the
   * right value table.
   */
  function decodeWithGradeCheck(stats) {
    var dec = B.decodeBibleBracelet(stats), i;

    // The cap is a hard fact about the item; the slot count is a guess about how
    // the player has been playing. The fact wins.
    if (traitsBreakCap(dec, dec.grade)) {
      var forced = dec.grade === "relic" ? "ancient" : "relic";
      var fdec = B.decodeBibleBracelet(stats, { grade: forced });
      if (!traitsBreakCap(fdec, forced)) return fdec;
    }

    var granted = 0;
    for (i = 0; i < dec.lines.length; i++) if (!dec.lines[i].fixed) granted++;
    if (slotChoices(dec.grade).indexOf(granted) >= 0) return dec;
    var other = dec.grade === "relic" ? "ancient" : "relic";
    if (slotChoices(other).indexOf(granted) < 0) return dec;   // fits neither; leave the guess alone
    var alt = B.decodeBibleBracelet(stats, { grade: other });
    if (traitsBreakCap(alt, other)) return dec;                // the slot count is the thing that is wrong
    return alt;
  }

  /**
   * decodeBibleBracelet's lines -> the state patch app.js merges.
   * Fixed lines split two ways: a Crit / Spec / Swiftness trait is one of the two
   * combat traits the panel shows at the top, anything else is a fixed line in
   * the Advanced fold. Unlocked lines are the granted slots.
   */
  function buildPatch(data) {
    var dec = decodeWithGradeCheck(data.stats || []);
    var grade = dec.grade;
    var traits = { crit: { on: false, v: 120 }, spec: { on: false, v: 120 }, swift: { on: false, v: 120 } };
    var traitOrder = [], rows = [], fixedRows = [], warn = [];
    var i, line, r;

    for (i = 0; i < dec.lines.length; i++) {
      line = dec.lines[i];
      if (line.fixed && line.cat === "trait" && TRAIT_TO_APP[line.family]) {
        var tk = TRAIT_TO_APP[line.family];
        traits[tk] = { on: true, v: Math.round(line.value) };
        if (traitOrder.indexOf(tk) < 0) traitOrder.push(tk);
        continue;
      }
      r = rowFor(line);
      if (!r) continue;
      if (line.unmatchedValue) warn.push("a special effect whose value matched no tier");
      if (line.fixed) fixedRows.push(r); else rows.push(r);
    }

    // The panel always shows exactly two combat traits. A bracelet that reported
    // fewer keeps the defaults switched on so the score stays sane; app.js's own
    // fitTraits() would do it anyway, this just picks a sensible pair.
    while (traitOrder.length < 2) {
      var fill = traitOrder.indexOf("crit") < 0 ? "crit" : (traitOrder.indexOf("spec") < 0 ? "spec" : "swift");
      traits[fill].on = true;
      traitOrder.push(fill);
      warn.push("only " + (traitOrder.length - 1) + " combat trait came back, so the panel kept its own second one");
    }
    while (traitOrder.length > 2) { traits[traitOrder.shift()].on = false; }

    if (fixedRows.length > 2) { fixedRows.length = 2; warn.push("more than two fixed lines came back"); }

    var choices = slotChoices(grade);
    var slots = rows.length;
    if (choices.indexOf(slots) < 0) {
      slots = slots < choices[0] ? choices[0] : choices[choices.length - 1];
      // Padding up is harmless — an empty row IS an empty slot. Cutting down is
      // not, so do it here and say which lines went rather than letting app.js
      // trim the tail quietly.
      if (rows.length > slots) {
        warn.push("the bracelet reported " + rows.length + " granted lines, more than " +
          (grade === "relic" ? "Relic" : "Ancient") + " allows, so the last " +
          (rows.length - slots) + " went unread");
        rows.length = slots;
      }
    }

    var patch = {
      grade: grade,
      slots: slots,
      traits: traits,
      traitOrder: traitOrder,
      rows: rows,
      fixedRows: fixedRows
    };

    // numRerolls / numTicketRerolls: seen as 4 and 3 on live characters, which is
    // exactly a fresh bracelet's allowance, so they read as ROLLS REMAINING. That
    // is an inference from two samples, not a documented field — if an imported
    // character ever shows the wrong number here, this is the line to fix.
    var nr = firstNumber(data, ["numRerolls"]);
    var nt = firstNumber(data, ["numTicketRerolls"]);
    if (nr !== null || nt !== null) patch.rollsLeft = Math.max(0, Math.min(20, (nr || 0) + (nt || 0)));

    if (dec.unknown && dec.unknown.length) {
      warn.push(dec.unknown.length + " line" + (dec.unknown.length > 1 ? "s" : "") +
        " used an index the decoder does not map yet, so " +
        (dec.unknown.length > 1 ? "they were" : "it was") + " left out");
    }
    return { patch: patch, warn: warn, decoded: dec };
  }

  // ------------------------------------------------------------------
  // the board figure — the bracelet on the CANONICAL DEFAULT profile
  //
  // Same split as leaderboard.js's score() and worker/bracelet.js's: the two fixed
  // combat traits are scored by traitDamage, every other line by setDamage. The
  // duplication is deliberate and matches astrogem's own house pattern — the
  // leaderboard is lazy-loaded and this panel is eager, so neither may depend on
  // the other. The MODEL is the single source; only the call sequence repeats.
  // ------------------------------------------------------------------

  var DEFAULT_PROFILE = B.normalizeProfile({});

  function defaultScore(stats) {
    if (!stats || !stats.length) return null;
    var dec, i, l, k;
    try { dec = decodeWithGradeCheck(stats); } catch (e) { return null; }
    var traits = { crit: 0, spec: 0, swift: 0 }, lines = [];
    for (i = 0; i < dec.lines.length; i++) {
      l = dec.lines[i];
      k = TRAIT_TO_APP[l.family];
      if (l.fixed && l.cat === "trait" && k) { traits[k] = l.value; continue; }
      lines.push(l);
    }
    var d = B.traitDamage(traits, DEFAULT_PROFILE) + B.setDamage(lines, dec.grade, DEFAULT_PROFILE);
    var p = B.damagePercent(d);
    if (typeof p !== "number" || !isFinite(p)) return null;
    return { grade: dec.grade, pct: p, unmapped: (dec.unknown || []).length };
  }

  /**
   * A whole-bracelet letter, on the SAME ladder model/bracelet.js grades families
   * with (FAMILY_GRADE_BANDS: share of the best -> S/A/B/C/D/F). There the share is
   * of the best family; here it is of the best bracelet on the board, which is what
   * ARCHITECTURE §3.5 asks for — "extend the same ladder to a whole-bracelet rank so
   * a character gets one letter". The bands are mirrored rather than imported
   * because the model exports familyGrades(), not bandLetter(); this is a banding of
   * a ratio, not damage maths, and the model stays the only place damage is scored.
   */
  var RANK_BANDS = [[0.90, "S"], [0.70, "A"], [0.50, "B"], [0.30, "C"], [0.10, "D"], [-1, "F"]];
  function bandLetter(share) {
    for (var i = 0; i < RANK_BANDS.length; i++) if (share >= RANK_BANDS[i][0]) return RANK_BANDS[i][1];
    return "F";
  }

  // ------------------------------------------------------------------
  // small helpers
  // ------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function nf(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fx(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
  function charKey(region, name) {
    return String(region || "").toUpperCase() + "|" + String(name || "").trim().toLowerCase();
  }

  /**
   * lostark.bible calls EU Central "CE". A roster payload might say anything —
   * "EU", a server name, or nothing at all — so map what we recognise and return
   * "" for the rest rather than guessing a region and fetching a stranger's page.
   */
  function bibleRegion(r) {
    var s = String(r || "").trim().toUpperCase();
    if (!s) return "";
    if (s === "NA" || s === "NAE" || s === "NAW" || s === "US" || s === "NORTH AMERICA") return "NA";
    if (s === "CE" || s === "EU" || s === "EUC" || s === "EUROPE" ||
        s === "CENTRAL EUROPE" || s === "EU CENTRAL") return "CE";
    return "";
  }
  /**
   * The region a PERSON reads, for the header chip and the Favorites key. Bible
   * calls central Europe CE in its URLs; every store here says EU, healed in one
   * place so a character cannot be favourited twice under two names.
   */
  function normRegion(r) {
    var s = bibleRegion(r);
    return s === "CE" ? "EU" : s;
  }

  /**
   * The class glyph, from assets/class-icons/<Class>.svg — the same 29 files the
   * astrogem calculator ships. Spelled out because an unknown class must get NO
   * icon rather than a wrong one or a broken image. app.js and leaderboard.js each
   * keep their own copy for the same reason the scorer is duplicated above.
   */
  var CLASS_ICONS = ("Aeromancer Arcanist Artillerist Artist Bard Berserker Breaker Deadeye Deathblade " +
    "Destroyer Glaivier Guardianknight Gunlancer Gunslinger Machinist Paladin Reaper Scrapper " +
    "Shadowhunter Sharpshooter Slayer Sorceress Souleater Soulfist Striker Summoner Valkyrie " +
    "Wardancer Wildsoul").split(" ");
  var CLASS_ICON_BY_KEY = (function () {
    var m = {}, i;
    for (i = 0; i < CLASS_ICONS.length; i++) m[CLASS_ICONS[i].toLowerCase()] = CLASS_ICONS[i];
    return m;
  })();
  function classIconFile(cls) {
    if (!cls) return null;
    return CLASS_ICON_BY_KEY[String(cls).replace(/[^A-Za-z]/g, "").toLowerCase()] || null;
  }
  function classIconHtml(cls) {
    var f = classIconFile(cls);
    if (!f) return "";
    return '<img class="bi-classicon" src="assets/class-icons/' + encodeURIComponent(f) +
      '.svg" alt="" aria-hidden="true" loading="lazy" onerror="this.style.display=\'none\'">';
  }

  // ------------------------------------------------------------------
  // the baked board — a free, instant cache of 30 characters
  // ------------------------------------------------------------------

  var seedPromise = null;

  /** [{region, name, class, itemLevel, pulledAt, loadouts:[…], best, pct}] */
  function seedIndex() {
    if (seedPromise) return seedPromise;
    seedPromise = fetch(SEED_URL).then(function (r) {
      if (!r.ok) throw new Error("http_" + r.status);
      return r.json();
    }).then(function (j) {
      var list = ((j && j.entries) || []).map(fromSeedEntry).filter(function (e) { return !!e; });
      var byKey = {};
      list.forEach(function (e) { byKey[charKey(e.region, e.name)] = e; });
      return { list: list, byKey: byKey };
    }).catch(function () { seedPromise = null; return { list: [], byKey: {} }; });
    return seedPromise;
  }

  /**
   * One seed row -> the internal record every render path reads. Scores every
   * loadout on the canonical default profile HERE rather than trusting the file's
   * stored number, for exactly the reason the leaderboard does: a model change
   * must show up without re-baking the seed.
   */
  function fromSeedEntry(e) {
    if (!e || !e.name) return null;
    var raw = (e.loadouts && e.loadouts.length) ? e.loadouts : [e];
    var los = raw.map(function (l, i) {
      var rolls = l.rollsRemaining || e.rollsRemaining || { base: 0, ticket: 0 };
      var stats = l.rawStats || e.rawStats || [];
      var s = defaultScore(stats);
      return {
        classification: l.classification || "loadout",
        label: l.label || ("Loadout " + (i + 1)),
        itemLevel: l.itemLevel != null ? Math.round(l.itemLevel) : (e.itemLevel != null ? Math.round(e.itemLevel) : null),
        isRendered: !!l.isRendered,
        stats: stats,
        numRerolls: rolls.base || 0,
        numTicketRerolls: rolls.ticket || 0,
        pct: s ? s.pct : null,
        grade: s ? s.grade : (l.grade || e.grade || null),
        unmapped: s ? s.unmapped : 0
      };
    });
    var best = bestOf(los, e.chosenLoadout || 0);
    return {
      region: normRegion(e.region) || "NA",
      name: e.name,
      "class": e["class"] || null,
      itemLevel: e.itemLevel != null ? Math.round(e.itemLevel) : null,
      pulledAt: Date.parse(e.scoredAt || "") || null,
      source: "seed",
      cached: true,
      loadouts: los,
      best: best,
      pct: los[best] ? los[best].pct : null,
      profile: null
    };
  }

  /** The highest-scoring loadout; the file's own index only breaks a tie. */
  function bestOf(los, chosen) {
    var best = -Infinity, bi = -1, i;
    for (i = 0; i < los.length; i++) {
      var p = los[i].pct;
      if (p == null) continue;
      if (p > best + 1e-9 || (Math.abs(p - best) < 1e-9 && i === chosen)) { best = p; bi = i; }
    }
    return bi >= 0 ? bi : (chosen || 0);
  }

  /** The Worker's /character answer -> the same internal record. */
  function fromWorkerRecord(d) {
    var raw = (d.loadouts && d.loadouts.length) ? d.loadouts : [{
      classification: "loadout", label: "Bracelet", itemLevel: d.itemLevel,
      isRendered: true, bracelet: d.bracelet, defaultScore: d.defaultScore
    }];
    var los = raw.map(function (l, i) {
      var br = (l && (l.bracelet || l)) || {};
      var stats = br.stats || [];
      var s = defaultScore(stats);
      return {
        classification: l.classification || "loadout",
        label: l.label || l.classification || ("Loadout " + (i + 1)),
        itemLevel: l.itemLevel != null ? Math.round(l.itemLevel) : null,
        isRendered: !!l.isRendered,
        stats: stats,
        numRerolls: br.numRerolls || 0,
        numTicketRerolls: br.numTicketRerolls || 0,
        pct: s ? s.pct : (l.defaultScore && typeof l.defaultScore.pct === "number" ? l.defaultScore.pct : null),
        grade: s ? s.grade : (l.defaultScore && l.defaultScore.grade) || null,
        unmapped: s ? s.unmapped : 0
      };
    }).filter(function (l) { return l.stats && l.stats.length; });
    if (!los.length) return null;
    var best = bestOf(los, typeof d.chosenLoadout === "number" ? d.chosenLoadout : 0);
    return {
      region: normRegion(d.region) || "NA",
      name: d.name,
      "class": d["class"] || null,
      itemLevel: d.itemLevel != null ? Math.round(d.itemLevel) : null,
      pulledAt: d.pulledAt || Date.now(),
      source: "bible",
      cached: d.cached != null ? !!d.cached : null,
      stale: !!d.stale,
      staleHours: d.staleHours || 0,
      loadouts: los,
      best: best,
      pct: los[best] ? los[best].pct : null,
      // ARCHITECTURE §1.1: the record may carry the grader-profile block. Passed
      // straight through — app.js decides what of it the deck can honestly hold.
      profile: d.profile || null
    };
  }

  // ------------------------------------------------------------------
  // "where does this bracelet sit?" — rank vs the board
  // ------------------------------------------------------------------

  /**
   * fillFieldRank(), ported. The estimator is astrogem's and it is deliberately
   * conservative: (better+1)/(total+1) rounded UP, so a character can never be
   * told they are top 0% and a small class sample cannot flatter anyone. The class
   * line only appears at n>=5, because below that the percentage is noise.
   *
   * The comparison is on the CANONICAL DEFAULT profile at both ends — the board's
   * number against the board's numbers. Scoring one side on the user's own deck
   * would rank their gear, not their bracelet.
   */
  function fieldRank(char, cb) {
    if (!char || char.defaultPct == null || typeof cb !== "function") return;
    seedIndex().then(function (idx) {
      var list = idx && idx.list;
      if (!list || !list.length) return;
      var mine = char.defaultPct, best = 0, better = 0, total = 0, cBetter = 0, cTotal = 0, i, e;
      for (i = 0; i < list.length; i++) {
        e = list[i];
        if (e.pct == null) continue;
        if (e.pct > best) best = e.pct;
        total++;
        if (e.pct > mine + 1e-9) better++;
        if (char["class"] && e["class"] === char["class"]) {
          cTotal++;
          if (e.pct > mine + 1e-9) cBetter++;
        }
      }
      if (!total) return;
      var bits = [];
      if (char["class"] && cTotal >= 5) {
        var p = Math.max(1, Math.ceil(100 * (cBetter + 1) / (cTotal + 1)));
        bits.push("Top " + p + "% of " + char["class"] + "s (#" + (cBetter + 1) + " of " + cTotal + ")");
      }
      bits.push("#" + (better + 1) + " of " + total.toLocaleString("en-US") + " tracked characters");
      var share = best > 0 ? mine / best : 0;
      cb({
        text: bits.join(" · "),
        letter: bandLetter(share),
        share: share,
        best: best,
        rank: better + 1,
        total: total
      });
    }).catch(function () { /* the rank is a nicety; never break the panel over it */ });
  }

  // ------------------------------------------------------------------
  // the Worker — the ONLY thing allowed near a lostark.bible character page
  // ------------------------------------------------------------------

  /**
   * Econ.fetchCharacter(region, name, {refresh}) — astrogem's loadout-econ.js
   * entry point, in our route shape:
   *
   *   GET {WORKER}/character?region=&name=&queue=1&pos=1[&refresh=1]
   *   Authorization: Bearer <BibleOAuth.accessToken()>
   *
   * `queue=1&pos=1` asks the Worker to answer with a queue position instead of
   * blocking when the character is not cached — the contract the queue watch below
   * is written to. Resolves { ok, status, data } whatever the status, because every
   * branch of runPull reads the body.
   */
  function fetchCharacter(region, name, opts) {
    var url = WORKER_URL.replace(/\/+$/, "") +
      "/character?region=" + encodeURIComponent(bibleRegion(region) || "NA") +
      "&name=" + encodeURIComponent(name) +
      "&queue=1&pos=1" +
      (opts && opts.refresh ? "&refresh=1" : "");
    var headers = {};
    var tok = OA.accessToken && OA.accessToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    return fetch(url, { headers: headers }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        return { ok: resp.ok, status: resp.status, data: data || {} };
      });
    });
  }

  var Econ = {
    WORKER_URL: WORKER_URL,
    fetchCharacter: fetchCharacter,
    fieldRank: fieldRank,
    defaultScore: defaultScore,
    seed: seedIndex
  };

  /** Worker error codes -> the message kinds msgHtml() knows how to word. */
  function workerErrorKind(status, code) {
    if (code === "not_yours") return "notyours";
    if (code === "no_bracelet") return "nobracelet";
    if (code === "no_such_character") return "nopage";
    if (code === "slow_down" || status === 429) return "slowdown";
    if (code === "not_signed_in" || code === "bad_token" || status === 401) return "expired";
    return "worker";
  }

  // ------------------------------------------------------------------
  // markup
  // ------------------------------------------------------------------

  function styleBlock() {
    return "<style>" +
      // The panel scrolls normally — styles.css makes .inputs sticky, and a frozen
      // bar over a page this tall is the complaint astrogem fixed the same way.
      "#bc-import .inputs{position:static;top:auto;z-index:auto;margin-bottom:12px}" +
      "#bc-import .bi-modes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;align-items:center}" +
      // the auth buttons ride at the far END of the mode row, so the mode toggles keep their group
      "#bc-import .bi-authbtns{display:flex;gap:8px;margin-left:auto}" +
      "@media(max-width:560px){#bc-import .bi-authbtns{margin-left:0}}" +
      "#bc-import .bi-modebody{margin-top:12px}" +
      "#bc-import button.primary{background:var(--accent);color:#06121f;border:none;border-radius:7px;" +
        "padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}" +
      "#bc-import button.primary:hover{filter:brightness(1.08)}" +
      "#bc-import button.primary:disabled,#bc-import .mbtn:disabled{opacity:.45;cursor:not-allowed}" +
      "#bc-import .bi-status{font-size:12px;color:var(--dim);min-height:16px}" +
      "#bc-import .bi-status.working{color:var(--accent)}" +
      "#bc-import .bi-status.err{color:var(--bad)}" +
      "#bc-import .bi-status.ok{color:var(--good)}" +
      // pull mode: controls LEFT, saved characters RIGHT
      "#bc-import .bi-pullgrid{display:grid;grid-template-columns:auto 1fr;gap:14px 32px;align-items:start}" +
      "@media(max-width:700px){#bc-import .bi-pullgrid{grid-template-columns:1fr}}" +
      "#bc-import .bi-pullleft,#bc-import .bi-pullright{min-width:0}" +
      "#bc-import .bi-pullctl{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:0 0 10px}" +
      "#bc-import .bi-pullctl .fld{margin:0}" +
      "#bc-import .bi-pullctl .fld-region{flex:0 0 auto;width:84px}" +
      "#bc-import .bi-pullctl .fld-name{flex:0 0 auto;width:200px}" +
      "@media(max-width:520px){#bc-import .bi-pullctl .fld-name{flex:1 1 160px;width:auto}}" +
      "#bc-import .bi-pullbtns{display:flex;gap:10px;flex-wrap:wrap;align-items:center}" +
      "#bc-import .bi-freenote{font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5}" +
      "#bc-import .bi-freenote b{color:var(--text)}" +
      "#bc-import .bi-freenote .bi-cap{color:#e0683c;font-weight:600}" +
      "#bc-import .bi-msg{color:var(--dim);font-size:11.5px;margin-top:6px;max-width:74ch;line-height:1.55}" +
      "#bc-import .bi-msg.bad{color:var(--bad)}" +
      "#bc-import .bi-msg.good{color:var(--good)}" +
      "#bc-import .bi-who{color:var(--dim);font-size:11px}" +
      "#bc-import .bi-who b{color:var(--text);font-weight:700}" +
      // ---- saved-characters quick-pick ----
      "#bc-import .bi-favs{margin:0}" +
      "#bc-import .bi-favs .lab{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;" +
        "color:var(--dim);font-weight:700;margin:0 0 8px}" +
      "#bc-import .bi-favs .lab .lab-star{color:var(--high);margin-right:3px}" +
      "#bc-import .bi-favs .lab+.bi-favlist{margin-bottom:12px}" +
      "#bc-import .bi-favlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;"
      // three rows of chips, then scroll: 3*32px chip + 2*6px gap (measured)
      + "max-height:108px;overflow-y:auto;padding-right:4px}" +
      "#bc-import .bi-favlist.bi-board{max-height:186px;overflow-y:auto;padding-right:4px}" +
      "#bc-import .bi-favrow{display:flex;align-items:stretch;gap:5px}" +
      "#bc-import .bi-favrow .bi-favbtn{flex:1 1 auto;min-width:0}" +
      "#bc-import .bi-favbtn{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;" +
        "text-align:left;background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:7px 12px;" +
        "font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--text);line-height:1.3;" +
        "transition:border-color .12s,background .12s,color .12s}" +
      "#bc-import .bi-favbtn:hover{border-color:var(--accent);background:var(--panel);color:var(--accent)}" +
      "#bc-import .bi-favbtn.on{border-color:var(--accent);color:var(--accent)}" +
      "#bc-import .bi-favbtn .nm{flex:0 1 auto;min-width:0;margin-right:auto;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap}" +
      "#bc-import .bi-favbtn .rg{font-size:9.5px;font-weight:700;color:var(--dim);text-transform:uppercase;" +
        "letter-spacing:.04em;flex:0 0 auto;transition:color .12s,opacity .12s}" +
      "#bc-import .bi-favbtn:hover .rg{color:var(--accent);opacity:.6}" +
      // an <img> cannot inherit the SVG's fill=currentColor, so flatten it and invert
      "#bc-import .bi-favbtn .bi-classicon{width:16px;height:16px;object-fit:contain;flex:0 0 auto;" +
        "margin-right:7px;filter:brightness(0) invert(1)}" +
      "#bc-import .bi-favstar{flex:0 0 auto;background:none;border:none;color:var(--high);cursor:pointer;" +
        "font-size:15px;line-height:1;padding:2px 5px;font-family:inherit;transition:transform .08s,color .12s}" +
      "#bc-import .bi-favstar:hover{transform:scale(1.15);color:#fff}" +
      "#bc-import .bi-favstar.off{color:var(--none)}" +
      "#bc-import .bi-favempty{display:block;font-size:11px;color:var(--dim);font-style:italic;margin:0 0 12px}" +
      // ---- the "lookups" notice: amber when paused, blue when a sign-in is what's missing ----
      "#bc-import .bi-unavail{--gu:#60a5fa;--gutext:#06172e;--gubg:rgba(96,165,250,0.11);--gubd:rgba(96,165,250,0.5);" +
        "margin:0 0 14px;padding:18px 20px;border-radius:14px;background:var(--gubg);border:1px solid var(--gubd)}" +
      "#bc-import .bi-unavail.amber{--gu:#e8b54a;--gutext:#1a1205;--gubg:rgba(232,181,74,0.13);--gubd:rgba(232,181,74,0.55)}" +
      "#bc-import .bi-unavail-hd{font-size:16px;font-weight:800;color:var(--gu);line-height:1.35;margin:0 0 8px}" +
      "#bc-import .bi-unavail-bd{font-size:13px;line-height:1.6;color:var(--text);margin:0}" +
      "#bc-import .bi-unavail-bd b{color:var(--gu)}" +
      "#bc-import .bi-unavail-steps{margin:10px 0 0;padding-left:20px;font-size:13px;line-height:1.7;color:var(--text)}" +
      "#bc-import .bi-unavail-steps b{color:var(--gu)}" +
      "#bc-import .bi-unavail-btn{margin-top:14px;padding:10px 18px;border-radius:10px;background:var(--gu);" +
        "color:var(--gutext);font-weight:800;font-size:14px;border:0;cursor:pointer;font-family:inherit}" +
      "#bc-import .bi-unavail-btn:hover{filter:brightness(1.08)}" +
      // ---- the queue: a thin bar over a cached bracelet, or its own panel ----
      "#bc-refresh-banner:empty{display:none}" +
      "#bc-refresh-banner .bi-refresh-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px;" +
        "padding:9px 13px;border-radius:9px;background:rgba(127,127,127,0.10);border:1px solid var(--accent);font-size:13px}" +
      "#bc-refresh-banner .bi-refresh-bar b{color:var(--accent)}" +
      "#bc-refresh-banner .bi-rb-dim{color:var(--dim)}" +
      "#bc-refresh-banner .bi-rb-spin{display:inline-block;animation:bi-rb-spin 1.1s linear infinite}" +
      "@keyframes bi-rb-spin{to{transform:rotate(360deg)}}" +
      "#bc-refresh-banner .bi-queued{display:flex;align-items:center;gap:14px;padding:6px 2px}" +
      "#bc-refresh-banner .bi-queued-icon{font-size:30px;line-height:1}" +
      "#bc-refresh-banner .bi-queued-main{font-size:14px}" +
      "#bc-refresh-banner .bi-queued-pos{font-size:13px;font-weight:600;color:var(--accent);margin-top:5px}" +
      "#bc-refresh-banner .bi-queued-sub{font-size:12px;color:var(--dim);margin-top:4px}" +
      "#bc-refresh-banner #bi-queued-timer,#bc-refresh-banner #bi-rb-timer{color:var(--accent)}" +
      // ---- loadout pills: astrogem's preset-pill segmented control ----
      "#bc-loadouts:empty{display:none}" +
      "#bc-loadouts .bi-axis{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}" +
      "#bc-loadouts .bi-axis .lab{font-size:10px;text-transform:uppercase;letter-spacing:.07em;" +
        "color:var(--dim);font-weight:700}" +
      "#bc-loadouts .bi-axispills{display:inline-flex;gap:0;border:1px solid var(--border);border-radius:99px;" +
        "overflow:hidden;background:var(--panel2)}" +
      "#bc-loadouts .bi-axispill{background:none;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;" +
        "font-weight:700;color:var(--dim);padding:6px 16px;line-height:1.3;transition:background .12s,color .12s}" +
      "#bc-loadouts .bi-axispill:not(:last-child){border-right:1px solid var(--border)}" +
      "#bc-loadouts .bi-axispill:hover:not(.active){color:var(--text)}" +
      "#bc-loadouts .bi-axispill.active{background:var(--accent);color:#06121f}" +
      "#bc-loadouts .bi-axispill b{font-weight:800;font-variant-numeric:tabular-nums;margin-left:5px}" +
      "#bc-loadouts .bi-axispill i{font-style:normal;color:var(--good);margin-left:4px}" +
      "#bc-loadouts .bi-axispill.active i{color:#06121f}" +
      "#bc-loadouts .bi-axisnote{font-size:11px;color:var(--dim)}" +
      "</style>";
  }

  function regionOptions(sel) {
    return REGIONS.map(function (r) {
      return '<option value="' + r + '"' + (r === sel ? " selected" : "") + ">" + r + "</option>";
    }).join("");
  }

  function panelMarkup(last) {
    return styleBlock() +
      '<div class="bi-unavail" id="bi-unavailable" style="display:none"></div>' +
      '<div class="inputs" id="bi-inputs">' +
      '  <div class="ihdr"><span>Character — pull a bracelet from lostark.bible</span></div>' +
      '  <div class="bi-modes">' +
      '    <button class="mbtn active" id="bi-mode-pull" type="button">Pull from lostark.bible</button>' +
      '    <button class="mbtn" id="bi-mode-manual" type="button">Manual entry</button>' +
      '    <span class="bi-authbtns" id="bi-authbtns"></span>' +
      '  </div>' +
      '  <div class="bi-modebody" id="bi-body-manual" style="display:none">' +
      '    <div class="note" style="margin-top:0">Nothing to pull — type the bracelet into the panel below. ' +
      'The two combat traits, then one row per granted slot; leave every slot empty for an unrolled bracelet. ' +
      'Your character settings stay exactly as you left them.</div>' +
      '  </div>' +
      '  <div class="bi-modebody" id="bi-body-pull">' +
      '    <div class="bi-pullgrid">' +
      '      <div class="bi-pullleft">' +
      '        <div class="bi-pullctl">' +
      '          <div class="fld fld-region"><label>Region</label><select id="bi-region">' +
                   regionOptions((last && last.region) || "NA") + '</select></div>' +
      '          <div class="fld fld-name"><label>Character name</label>' +
      '            <input id="bi-name" type="text" placeholder="e.g. White" autocomplete="off" value="' +
                   esc((last && last.name) || "") + '"></div>' +
      '        </div>' +
      '        <div class="bi-pullbtns">' +
      '          <button class="primary" id="bi-pull-go" type="button">Grade bracelet</button>' +
      '          <button class="mbtn" id="bi-pull-refresh" type="button" style="display:none">Re-pull from lostark.bible</button>' +
      '        </div>' +
      '        <div class="barrow" style="margin-top:8px"><span class="bi-status" id="bi-pull-status"></span></div>' +
      '        <div class="bi-freenote" id="bi-free-note"></div>' +
      '        <div id="bi-msg-host"></div>' +
      '      </div>' +
      '      <div class="bi-pullright"><div class="bi-favs" id="bi-favs"></div></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
  }

  /**
   * The mount. app.js provides `#bc-import` at the top of the Calculator pane; if a
   * stale build does not, make one there so the panel is never lost.
   */
  function mount() {
    var box = $(MOUNT_ID);
    if (box) return box;
    var pane = document.getElementById("tab-calculator");
    if (!pane || !pane.firstChild) return null;
    box = document.createElement("div");
    box.id = MOUNT_ID;
    pane.insertBefore(box, pane.firstChild);
    return box;
  }

  var built = false;

  /** Build the panel once; everything after that repaints a region of it. */
  function render() {
    var box = mount();
    if (!box) return;
    if (!built) {
      var last = null;
      try { last = JSON.parse(localStorage.getItem(LAST_KEY) || "null"); } catch (e) {}
      box.innerHTML = panelMarkup(last);
      built = true;
      bind();
      selectMode(state.mode);
      setFreeStatus();
    }
    renderAuth();
    renderFavRow();
    renderMsg();
  }

  /** Every failure gets its own sentence — never one shrug for all of them. */
  function msgHtml() {
    if (state.error) {
      var e = state.error, t;
      if (e.kind === "expired") {
        t = "Your lostark.bible pass ran out. Sending you back to sign in — it should come straight back without asking anything.";
      } else if (e.kind === "reauth-failed") {
        t = "Signing back in did not take. Use the button above to start the sign-in again.";
      } else if (e.kind === "noworker") {
        t = "Live lookups need our lostark.bible fetch service, which is not deployed for this build yet — " +
          "so " + esc(e.who || "that character") + " cannot be fetched. The characters listed on the right are baked " +
          "into this build and load instantly; pick any of them.";
      } else if (e.kind === "notyours") {
        t = "lostark.bible would not confirm that " + esc(e.who || e.detail || "that character") +
          " is on your roster, so nothing was fetched. Only characters your own account shows can be read here — " +
          "check the character is not hidden on lostark.bible, and that its roster is linked.";
      } else if (e.kind === "nopage") {
        t = "lostark.bible has no character page for " + esc(e.who || "that character") + " yet. " +
          "Visit the character on lostark.bible once so their profile syncs, then try again.";
      } else if (e.kind === "slowdown") {
        t = "That is a few characters in quick succession — give it a few seconds and click again. " +
          "The limit exists so this tool stays a welcome guest on lostark.bible.";
      } else if (e.kind === "worker") {
        t = "The import service could not be reached" + (e.detail ? " (" + esc(e.detail) + ")" : "") +
          ". Your bracelet is fine — try again in a minute, or pick a character on the right.";
      } else if (e.kind === "nobracelet") {
        t = "We can see " + esc(e.who || e.detail || "that character") + ", but there is no bracelet on them. " +
          "If they are wearing one, it may not have synced to lostark.bible yet — open the character there once, " +
          "then try again.";
      } else if (e.kind === "undecodable") {
        t = "A bracelet came back for " + esc(e.detail || "that character") + ", but none of its lines decoded. " +
          "That usually means a new stat index — worth reporting with the payload from BraceletImport.dumpShape().";
      } else {
        t = "lostark.bible answered with an error" + (e.detail ? " (" + esc(e.detail) + ")" : "") +
          ". Nothing is wrong with your bracelet — try Load my characters in a minute.";
      }
      return '<div class="bi-msg bad">' + t + "</div>";
    }
    if (state.note) return '<div class="bi-msg good">' + esc(state.note) + "</div>";
    return "";
  }
  function renderMsg() {
    var host = $("bi-msg-host");
    if (host) host.innerHTML = msgHtml();
  }

  function setPullStatus(msg, kind) {
    var el = $("bi-pull-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "bi-status" + (kind ? " " + kind : "");
  }

  /**
   * The note under the pull buttons. Cached characters are free and instant; a new
   * one is paced by the Worker's own throttle. setFreeStatus(true) is the "site
   * busy" state the Worker reports with `degraded`.
   */
  function setFreeStatus(degraded) {
    var el = $("bi-free-note");
    if (!el) return;
    if (degraded) {
      el.innerHTML = '<span class="bi-cap">The site is very busy — new-character lookups are paused. ' +
        "Cached characters still work.</span>";
      return;
    }
    el.innerHTML = "Cached characters are free &amp; instant · new characters: <b>~1 lookup / 5s</b>" +
      (WORKER_URL ? "" : " · live lookups need the fetch service, which is not deployed yet");
  }

  /**
   * Keep the Re-pull button's label and title honest about where a pull would go.
   * Both our regions read from lostark.bible, so this is one site today; it exists
   * because astrogem's does and because a KR-style second source would land here.
   */
  function syncSourceUI() {
    var btn = $("bi-pull-refresh");
    if (!btn) return;
    btn.textContent = "Re-pull from lostark.bible";
    btn.title = WORKER_URL
      ? "Force a fresh pull from lostark.bible"
      : "Needs the lostark.bible fetch service, which is not deployed yet";
  }

  // ------------------------------------------------------------------
  // saved characters — renderFavRow(), ported
  // ------------------------------------------------------------------

  var favClasses = {};        // charKey -> English class name, for the row icon
  var favClassFetch = false;  // the seed is read at most once for this

  function favClass(region, name) { return favClasses[charKey(region, name)] || null; }

  /**
   * Fill in the class of any saved character we do not know yet, from the baked
   * board. Runs at most once per session and only when something is missing.
   */
  function ensureFavClasses(favs) {
    if (favClassFetch) return;
    var unknown = favs.some(function (f) { return !favClass(f.region, f.name); });
    if (!unknown) return;
    favClassFetch = true;
    seedIndex().then(function (idx) {
      var before = JSON.stringify(favClasses), changed = false;
      (idx.list || []).forEach(function (e) {
        if (e["class"]) favClasses[charKey(e.region, e.name)] = e["class"];
      });
      changed = JSON.stringify(favClasses) !== before;
      if (changed) renderFavRow();
    }).catch(function () { /* no board — rows just show no icon */ });
  }

  function favRowHtml(f, i, saved, which) {
    return '<div class="bi-favrow" data-fi="' + i + '" data-set="' + which + '">' +
      '<button type="button" class="bi-favstar' + (saved ? "" : " off") + '" title="' +
        (saved ? "Unsave " : "Save ") + esc(f.name) + '" aria-label="' +
        (saved ? "Unsave " : "Save ") + esc(f.name) + '">' + (saved ? "&#9733;" : "&#9734;") + "</button>" +
      '<button type="button" class="bi-favbtn' + (state.picked === f.name ? " on" : "") +
        '" title="Load ' + esc(f.name) + " (" + esc(f.region) + ')">' +
      classIconHtml(favClass(f.region, f.name)) +
      '<span class="nm">' + esc(f.name) + "</span>" +
      '<span class="rg">' + esc(f.region) + "</span></button>" +
      "</div>";
  }

  /**
   * The saved-character grid: one row per favourite, a ★ that unsaves and a button
   * that LOADS. Below it, the characters baked into this build — the same rows, so
   * the panel is useful before anyone has signed in or saved anything.
   */
  var boardChars = null;
  function renderFavRow() {
    var host = $("bi-favs");
    if (!host) return;
    var F = root.Favorites;
    var favs = F ? F.list() : [];
    var h = '<span class="lab"><span class="lab-star">&#9733;</span> Saved characters</span>';
    if (favs.length) {
      h += '<div class="bi-favlist" data-set="fav">' + favs.map(function (f, i) {
        return favRowHtml(f, i, true, "fav");
      }).join("") + "</div>";
    } else {
      h += '<span class="bi-favempty">No saved characters yet — grade one and tap its ★.</span>';
    }
    if (boardChars && boardChars.length) {
      // The "On the board" list was removed (Shizu, 2026-08-11): the Leaderboard tab
      // already lists everyone, and 59 extra chips buried the saved characters. The
      // board index is still fetched — it feeds class icons and the field rank.
      boardRest = [];
    }
    host.innerHTML = h;
    ensureFavClasses(favs);
    bindFavRows(host, favs);
    if (!boardChars) {
      seedIndex().then(function (idx) {
        boardChars = (idx.list || []).map(function (e) {
          favClasses[charKey(e.region, e.name)] = e["class"] || favClasses[charKey(e.region, e.name)];
          return { region: e.region, name: e.name };
        });
        renderFavRow();
      }).catch(function () { boardChars = []; });
    }
  }
  var boardRest = [];

  function bindFavRows(host, favs) {
    var rows = host.querySelectorAll(".bi-favrow"), i;
    for (i = 0; i < rows.length; i++) {
      (function (rowEl) {
        var set = rowEl.getAttribute("data-set");
        var f = (set === "fav" ? favs : boardRest)[parseInt(rowEl.getAttribute("data-fi"), 10)];
        if (!f) return;
        rowEl.querySelector(".bi-favbtn").onclick = function () {
          loadCharacter(f.region, f.name);
        };
        rowEl.querySelector(".bi-favstar").onclick = function () {
          var F = root.Favorites;
          if (F) F.toggle(f.region, f.name);   // Favorites.onChange repaints this grid
        };
      })(rows[i]);
    }
  }

  // ------------------------------------------------------------------
  // the loadout pills — astrogem's preset toggle, with our two-bracelet axis
  // ------------------------------------------------------------------

  function renderLoadoutPills() {
    var host = $("bc-loadouts");
    if (!host) return;
    var los = state.loadouts;
    if (!los || los.length < 2) { host.innerHTML = ""; return; }
    var pills = los.map(function (l, i) {
      var p = l.pct == null ? "—" : fx(l.pct, 2) + "%";
      return '<button type="button" class="bi-axispill' + (i === state.loadoutIdx ? " active" : "") +
        '" data-ld="' + i + '" title="' + esc(pillTitle(l, i)) + '">' +
        esc(l.label || l.classification) + "<b>" + p + "</b>" +
        (i === state.bestLoadout ? '<i title="highest — the one the leaderboard ranks">&#9650;</i>' : "") +
        "</button>";
    }).join("");
    var cur = los[state.loadoutIdx] || los[0];
    var note = "Scoring the " + (cur.label || cur.classification) + " bracelet" +
      (state.loadoutIdx === state.bestLoadout
        ? " — the one the board ranks"
        : " — the board ranks the highest, not this one");
    host.innerHTML = '<div class="bi-axis"><span class="lab">Loadout</span>' +
      '<span class="bi-axispills">' + pills + "</span>" +
      '<span class="bi-axisnote">' + esc(note) + "</span></div>";
    var btns = host.querySelectorAll(".bi-axispill"), i;
    for (i = 0; i < btns.length; i++) {
      (function (b) {
        b.onclick = function () { pickLoadout(parseInt(b.getAttribute("data-ld"), 10)); };
      })(btns[i]);
    }
  }

  function pillTitle(l, i) {
    var bits = [];
    if (l.itemLevel) bits.push("item level " + l.itemLevel);
    if (l.isRendered) bits.push("the one lostark.bible's own page draws");
    if (i === state.bestLoadout) bits.push("highest — the figure the board ranks");
    return (l.classification || "loadout") + (bits.length ? " — " + bits.join("; ") : "");
  }

  /** Click a loadout pill: fill the calculator with that loadout's bracelet. */
  function pickLoadout(i) {
    if (!state.loadouts || !state.loadouts[i]) return;
    state.loadoutIdx = i;
    state.error = null;
    applyLoadout();
  }

  // ------------------------------------------------------------------
  // handing a bracelet to the calculator
  // ------------------------------------------------------------------

  /** How many DIFFERENT brackets sit behind the pills. Usually fewer than pills. */
  function distinctBracelets() {
    if (!state.loadouts) return 0;
    var seen = [], i, sig;
    for (i = 0; i < state.loadouts.length; i++) {
      sig = statsSig(state.loadouts[i].stats);
      if (seen.indexOf(sig) < 0) seen.push(sig);
    }
    return seen.length;
  }
  function statsSig(stats) {
    var out = [], i, s;
    for (i = 0; i < (stats || []).length; i++) {
      s = stats[i];
      out.push(s.type + ":" + s.index + ":" + s.value + ":" + (s.fixed ? 1 : 0));
    }
    return out.join("|");
  }

  /**
   * Decode the selected loadout and hand it to app.js. The character block carries
   * everything the banner draws AND everything the deck can honestly auto-fill;
   * app.js decides what of the profile it will accept.
   */
  function applyLoadout() {
    var rec = state.record;
    if (!rec) return false;
    var l = rec.loadouts[state.loadoutIdx] || rec.loadouts[0];
    if (!l) return false;

    var built;
    try {
      built = buildPatch({
        stats: l.stats,
        numRerolls: l.numRerolls,
        numTicketRerolls: l.numTicketRerolls
      });
    } catch (e) {
      state.error = { kind: "undecodable", detail: rec.name };
      renderMsg();
      return false;
    }
    if (!built.patch.rows.length && !built.patch.fixedRows.length && !built.decoded.lines.length) {
      state.error = { kind: "undecodable", detail: rec.name };
      renderMsg();
      return false;
    }

    var app = root.BraceletApp;
    if (!app || !app.applyImport) {
      state.error = { kind: "api", detail: "the calculator panel is not ready" };
      renderMsg();
      return false;
    }

    built.patch.character = {
      name: rec.name,
      region: rec.region,
      "class": rec["class"] || null,
      itemLevel: l.itemLevel != null ? l.itemLevel : rec.itemLevel,
      source: rec.source,
      cached: rec.cached,
      pulledAt: rec.pulledAt || Date.now(),
      // The BOARD figure for the bracelet on screen — the canonical default
      // profile, never the user's deck. Drives the rank badge and the field rank.
      defaultPct: l.pct,
      grade: l.grade,
      loadoutLabel: rec.loadouts.length > 1 ? (l.label || l.classification) : null,
      // ARCHITECTURE §1.1: whatever of the grader profile the record carried.
      profile: rec.profile || null
    };
    app.applyImport(built.patch);

    state.picked = rec.name;
    state.error = null;
    renderLoadoutPills();
    renderFavRow();

    var n = built.patch.rows.length;
    var note = "Loaded " + rec.name +
      (built.patch.character.loadoutLabel ? " (" + built.patch.character.loadoutLabel + " loadout)" : "") +
      " — " + (built.patch.grade === "relic" ? "Relic" : "Ancient") + ", " +
      n + " granted slot" + (n === 1 ? "" : "s") + ".";
    if (rec.loadouts.length > 1) {
      var d = distinctBracelets();
      note += " " + rec.loadouts.length + " loadouts on lostark.bible" +
        (d > 1
          ? ", holding " + d + " different bracelets — the pills above swap between them" +
            (state.loadoutIdx === state.bestLoadout ? ", and this is the highest" : "")
          : ", all holding this same bracelet") + ".";
    }
    if (l.pct != null) {
      var isBest = rec.loadouts.length < 2 || state.loadoutIdx === state.bestLoadout;
      note += " On default settings it is worth +" + fx(l.pct, 2) + "% damage — " +
        (isBest ? "that is the figure the leaderboard ranks on"
                : "the board ranks the highest loadout, not this one") +
        "; the panel below scores it on YOUR character.";
    }
    if (l.unmapped) {
      built.warn.push(l.unmapped + " line" + (l.unmapped > 1 ? "s use stat indices" : " uses a stat index") +
        " the model does not map yet, so " + (l.unmapped > 1 ? "they score" : "it scores") + " zero");
    }
    if (rec.stale) {
      built.warn.push("lostark.bible could not be reached, so this is a copy from about " +
        (rec.staleHours || 0) + "h ago");
    }
    if (built.warn.length) note += " Note: " + built.warn.join("; ") + ".";
    state.note = note;
    renderMsg();
    return true;
  }

  /** Put a whole record on screen: pills, bracelet, banner, Re-pull button. */
  function showRecord(rec) {
    if (!rec || !rec.loadouts || !rec.loadouts.length) return false;
    state.record = rec;
    state.loadouts = rec.loadouts;
    state.bestLoadout = rec.best || 0;
    state.loadoutIdx = rec.best || 0;
    var btn = $("bi-pull-refresh");
    if (btn) { btn.style.display = ""; syncSourceUI(); }
    renderLoadoutPills();
    return applyLoadout();
  }

  // ------------------------------------------------------------------
  // the pull — runPull(), ported branch for branch
  // ------------------------------------------------------------------

  var autoRepulled = {};   // charKey -> 1 once auto-re-pulled this session

  /** The one entry point everything else calls: a chip, the banner, the console. */
  function loadCharacter(region, name, opts) {
    if (!name) return;
    selectMode("pull");
    var r = normRegion(region) || "NA";
    if ($("bi-region") && REGIONS.indexOf(r) !== -1) $("bi-region").value = r;
    if ($("bi-name")) $("bi-name").value = name;
    runPull(!!(opts && opts.refresh));
  }

  function runPull(refresh) {
    var region = normRegion($("bi-region") && $("bi-region").value) || "NA";
    var name = (($("bi-name") && $("bi-name").value) || "").trim();
    if (!name) { setPullStatus("Enter a character name.", "err"); return; }
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ region: region, name: name })); } catch (e) {}

    state.error = null;
    stopPoll(); clearRefreshBanner();

    // The board has to be in hand before any decision: it is the cache, and on a
    // cold start it is the only source there is. One fetch, session-cached.
    if (!seedCache) {
      setPullStatus("Loading the board…", "working");
      seedIndex().then(function (idx) { seedCache = idx; runPull(refresh); });
      return;
    }

    // The baked board is a real cache: instant, free, and it needs no sign-in. A
    // Re-pull deliberately skips it — that is what Re-pull means.
    if (!refresh) {
      var hit = seedHit(region, name);
      if (hit) { showSeed(hit); return; }
    }

    if (!WORKER_URL) {
      // The honest version of "not built yet". The board characters are right there.
      var baked = seedHit(region, name);
      if (baked) {
        showSeed(baked);
        setPullStatus("Showing the copy baked into this build — a live re-pull needs the fetch service, " +
          "which is not deployed yet.", "");
        return;
      }
      setPullStatus("", "");
      state.error = { kind: "noworker", who: name };
      renderMsg();
      return;
    }

    // Refreshing the character that is CURRENTLY shown? Keep its bracelet on screen
    // with a queue banner over it, instead of blanking it for the queued panel.
    var cur = state.record;
    var refreshingCached = !!(refresh && cur && cur.loadouts && cur.loadouts.length &&
      charKey(cur.region, cur.name) === charKey(region, name));

    setPullStatus((refresh ? "Re-pulling " : "Fetching ") + name + " (" + region + ")…", "working");
    setBusy(true);

    fetchCharacter(region, name, { refresh: refresh }).then(function (r) {
      var d = r.data || {};

      // 1) the Worker says lookups are off right now
      if (d.unavailable) {
        renderLookupPanel("paused");
        setPullStatus(d.message || d.error || "Lookups are temporarily unavailable.", "err");
        return;
      }
      // 2) a fresh pull needs the visitor's own lostark.bible token
      if (d.needSignIn || d.error === "not_signed_in") {
        renderLookupPanel("back");
        setPullStatus("Sign in with lostark.bible to look up a character.", "err");
        state.error = { kind: "expired", who: name };
        renderMsg();
        return;
      }

      // 3) data present — render it. A cached bracelet stays on screen whatever
      //    else the answer says; a queue banner layers on top.
      var rec = (d.bracelet && d.bracelet.stats && d.bracelet.stats.length) ? fromWorkerRecord(d) : null;
      var show = rec || (refreshingCached ? cur : null);
      var since = show ? (show.pulledAt || 0) : 0;
      if (show) showRecord(show);

      // 4) queued
      if (d.queued) {
        if (show) {
          setPullStatus((d.stale ? "Cached (stale) — refreshing " : "Cached — refreshing ") + name + "…", "");
          showRefreshBanner(name, d);
        } else {
          setPullStatus("Queued — fetching " + name + "…", "");
          showQueued(name, d);
        }
        startQueueWatch(region, name, since, !!show, d);
        return;
      }

      if (show) {
        if (!maybeAutoRepullForProfile(show)) {
          setPullStatus("Graded " + name + " on " + (show.cached ? "a cached" : "a fresh") + " copy.", "ok");
        }
        return;
      }

      // 5) anything else is an error, and it gets its own sentence
      var msg = d.message || d.error || "The import service returned an error.";
      setPullStatus(msg, "err");
      state.error = { kind: workerErrorKind(r.status, d.error), detail: msg, who: name };
      renderMsg();
      if (d.degraded) setFreeStatus(true);
    }).catch(function (e) {
      setPullStatus("Request failed: " + ((e && e.message) || e), "err");
      state.error = { kind: "worker", detail: (e && e.message) || "no answer", who: name };
      renderMsg();
    }).then(function () { setBusy(false); });
  }

  function setBusy(on) {
    state.busy = !!on;
    var go = $("bi-pull-go"), rb = $("bi-pull-refresh");
    if (go) go.disabled = !!on;
    if (rb) rb.disabled = !!on;
  }

  var seedCache = null;
  function seedHit(region, name) {
    return seedCache ? seedCache.byKey[charKey(region, name)] : null;
  }
  function showSeed(rec) {
    if (!showRecord(rec)) return;
    setPullStatus("Loaded " + rec.name + " (" + rec.region + ") from the board baked into this build — " +
      "free and instant, no lookup used.", "ok");
  }

  /**
   * A cached record with no grader-profile block predates the Worker's profile
   * fields — re-pull it once, per character, per session, so the deck can fill
   * itself instead of asking the user to press Re-pull. A FRESH pull that still
   * lacks it is cached:false and can never re-trigger this, so there is no loop.
   * (astrogem's maybeAutoRepullForCp, in our terms.)
   */
  function maybeAutoRepullForProfile(rec) {
    if (!WORKER_URL) return false;
    if (!rec || rec.cached !== true || rec.profile) return false;
    if (rec.source !== "bible") return false;                   // the seed never carries one
    if (!(OA.signedIn && OA.signedIn())) return false;          // signed out, a re-pull would just fail
    var k = charKey(rec.region, rec.name);
    if (autoRepulled[k]) return false;
    autoRepulled[k] = 1;
    setPullStatus("Cached record has no character stats — re-pulling " + rec.name + "…", "working");
    setTimeout(function () { runPull(true); }, 0);              // deferred: let this chain finish
    return true;
  }

  // ------------------------------------------------------------------
  // the queue — startQueueWatch(), all three mechanisms
  // ------------------------------------------------------------------

  var pollTimer = null, paintTimer = null, watching = false;

  function stopPoll() {
    watching = false;                                     // also stops the long poll's reconnect loop
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (paintTimer) { clearInterval(paintTimer); paintTimer = null; }
  }

  function fmtEta(sec) {
    if (sec == null) return "";
    if (sec < 60) return "~" + Math.max(1, Math.round(sec)) + "s";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return "~" + m + "m" + (s ? " " + s + "s" : "");
  }
  /** "Position 3 of 12 · ~50s" from {position, total, drainPerMin}. */
  function queueLine(d) {
    if (!d || !(d.position > 0)) return "";
    var perMin = d.drainPerMin || 6;
    var head = d.position <= 1 ? "Next up"
      : ("Position " + d.position + " of " + Math.max(d.total || d.position, d.position));
    return head + " · " + fmtEta(Math.ceil(d.position / perMin * 60));
  }

  function bannerHost() { return $("bc-refresh-banner"); }
  function clearRefreshBanner() { var b = bannerHost(); if (b) b.innerHTML = ""; }

  /** A refresh of a CACHED character: a thin bar ABOVE the bracelet still on screen. */
  function showRefreshBanner(name, d) {
    var b = bannerHost();
    if (!b) return;
    var ql = queueLine(d);
    b.innerHTML = '<div class="bi-refresh-bar"><span class="bi-rb-spin">&#128260;</span><span>' +
      "<b>Refreshing " + esc((d && d.name) || name) + "</b>" +
      (ql ? ' — <span id="bi-rb-pos">' + esc(ql) + "</span>" : "") +
      ' <span class="bi-rb-dim">· the cached bracelet is loaded below · ' +
      '<span id="bi-rb-timer">checking…</span></span></span></div>';
  }

  /**
   * Nothing cached: the queue panel. Astrogem replaces its whole result pane; ours
   * rides in its own host so the calculator underneath is never blanked.
   */
  function showQueued(name, d) {
    var b = bannerHost();
    if (!b) return;
    var disp = (d && d.name) || name;
    b.innerHTML = '<div class="panel"><div class="bi-queued">' +
      '<div class="bi-queued-icon">&#9203;</div>' +
      '<div class="bi-queued-main"><b>' + esc(disp) + "</b> is in the queue." +
      '<div class="bi-queued-pos" id="bi-queued-pos">' + esc(queueLine(d)) + "</div>" +
      '<div class="bi-queued-sub">Fetching it now — this updates on its own when it is ready. ' +
      '<span id="bi-queued-timer">checking…</span></div></div>' +
      "</div></div>";
  }

  /**
   * The watch, with all three mechanisms astrogem runs at once:
   *   1) a LOCAL position countdown, one step per 60/perMin seconds — the drain
   *      rate — so the number moves every second at no server cost;
   *   2) a server RE-SYNC every 30s WHILE QUEUED, which also detects completion;
   *   3) a /wait LONG POLL that returns the instant the drain re-caches the
   *      character, so the banner clears in seconds rather than on the 30s tick.
   * Completion is gated on pulledAt > since: a stale cache hit answers with the
   * same pulledAt until the drain re-fetches, and must not pass for the refresh.
   * Ten minutes and it gives up rather than polling forever.
   */
  function startQueueWatch(region, name, since, cachedRefresh, st) {
    stopPoll();
    watching = true;
    since = since || 0;
    var perMin = (st && st.drainPerMin) || 6;
    var pos = (st && st.position > 0) ? st.position : null;
    var total = (st && st.total) || null;
    var syncAt = Date.now();
    var started = Date.now(), MAX_MS = 10 * 60 * 1000;

    function tick(html) {
      var t = $(cachedRefresh ? "bi-rb-timer" : "bi-queued-timer");
      if (t) t.innerHTML = html;
    }
    function curPos() {
      if (pos == null) return null;
      return Math.max(1, pos - Math.floor((Date.now() - syncAt) / 1000 / (60 / perMin)));
    }
    function paint() {
      var p = curPos();
      var el = $(cachedRefresh ? "bi-rb-pos" : "bi-queued-pos");
      if (el) el.innerHTML = (p == null) ? "checking…" : esc(queueLine({ position: p, total: total, drainPerMin: perMin }));
    }
    paintTimer = setInterval(paint, 1000);                       // 1) the free local tick

    function scheduleSync() { pollTimer = setTimeout(doSync, 30000); }   // 2) flat 30s while queued
    function doSync() {
      if (Date.now() - started > MAX_MS) {
        stopPoll();
        tick(cachedRefresh ? "still refreshing — try again later." : "still queued — check back later, or search again.");
        return;
      }
      fetchCharacter(region, name).then(function (r) {
        var d = r.data || {};
        var has = !!(d.bracelet && d.bracelet.stats && d.bracelet.stats.length);
        if ((d.cached || has) && (d.pulledAt || 0) > since) { finishWatch(d); return; }
        if (d.queued && d.position > 0) {
          pos = d.position;
          total = d.total || total;
          if (d.drainPerMin) perMin = d.drainPerMin;
          syncAt = Date.now();
        } else if (!d.queued && !has && (!r.ok || d.error)) {
          endWatch(d.message || d.error);
          return;
        }
        paint();
        scheduleSync();
      }).catch(function () { scheduleSync(); /* transient — keep watching */ });
    }

    function finishWatch(d) {
      stopPoll(); clearRefreshBanner();
      var rec = fromWorkerRecord(d);
      if (!rec) { endWatch("The refresh came back with no bracelet."); return; }
      showRecord(rec);
      setPullStatus("Graded " + rec.name + " on a fresh copy.", "ok");
    }
    function endWatch(msg) {
      stopPoll(); clearRefreshBanner();
      setPullStatus(msg || "Lookup ended.", "err");
      if (!cachedRefresh) {
        state.error = { kind: "worker", detail: msg || "the lookup ended", who: name };
        renderMsg();
      }
    }

    // 3) the long poll: the Worker answers the moment the drain re-caches this
    //    character, then we reconnect. A timeout is not a failure.
    function waitLoop() {
      if (!watching) return;
      var url = WORKER_URL.replace(/\/+$/, "") + "/wait?region=" +
        encodeURIComponent(bibleRegion(region) || "NA") +
        "&name=" + encodeURIComponent(name) + "&since=" + since;
      var headers = {};
      var tok = OA.accessToken && OA.accessToken();
      if (tok) headers.Authorization = "Bearer " + tok;
      fetch(url, { headers: headers }).then(function (r) { return r.json(); }).then(function (d) {
        if (!watching) return;
        if (d && d.done && d.bracelet) finishWatch(d);
        else if (d && d.notFound) endWatch(d.message || d.error);
        else waitLoop();
      }).catch(function () { if (watching) setTimeout(waitLoop, 3000); });
    }

    paint();
    scheduleSync();
    waitLoop();
  }

  // ------------------------------------------------------------------
  // the "how lookups work now" notice
  // ------------------------------------------------------------------

  /**
   * Two states, both ported from astrogem:
   *   "paused" -> amber: the Worker says it cannot read character pages right now.
   *   "back"   -> blue: lookups work, but they run on a signed-in account's behalf.
   *   null     -> hidden.
   */
  function renderLookupPanel(stateName) {
    var el = $("bi-unavailable");
    if (!el) return;
    if (stateName !== "paused" && stateName !== "back") { el.style.display = "none"; return; }
    if (stateName === "paused") {
      el.className = "bi-unavail amber";
      el.innerHTML =
        '<div class="bi-unavail-hd">&#9888;&#65039; Character lookups are temporarily unavailable</div>' +
        '<div class="bi-unavail-bd">lostark.bible is not answering our fetch service right now, so looking a ' +
        'character up by name will not work yet. <b>Characters already on the board still load instantly</b> — ' +
        'they are on the right — and you can always type a bracelet in by hand.</div>';
    } else {
      el.className = "bi-unavail";
      el.innerHTML =
        '<div class="bi-unavail-hd">Character lookups run on your own account</div>' +
        '<div class="bi-unavail-bd">lostark.bible asks that character pages be read on behalf of a signed-in ' +
        'account. Sign in once and you can look up <b>the characters in your own roster</b> by name.</div>' +
        '<ol class="bi-unavail-steps">' +
        '<li>Click <b>Sign in with lostark.bible</b> and approve the access request.</li>' +
        '<li>You land back here signed in — nothing else to set up.</li>' +
        '<li>Pick a <b>region</b>, type a <b>character name</b> from your roster, and hit <b>Grade bracelet</b>.</li>' +
        "</ol>" +
        '<button type="button" class="bi-unavail-btn" id="bi-unavail-in">Sign in with lostark.bible</button>';
    }
    el.style.display = "";
    var b = $("bi-unavail-in");
    if (b) b.onclick = function () { try { OA.login(); } catch (e) {} };
  }

  // ------------------------------------------------------------------
  // sign in / load my characters / sign out — renderAuth(), ported
  // ------------------------------------------------------------------

  function renderAuth() {
    var btns = $("bi-authbtns");
    if (!btns) return;
    if (!OA.configured()) {
      btns.innerHTML = '<span class="bi-who">Import is switched off: no lostark.bible app is configured for this build.</span>';
      return;
    }
    if (!OA.signedIn()) {
      btns.innerHTML = '<button class="mbtn" id="bi-auth-in" type="button">Sign in with lostark.bible</button>';
      $("bi-auth-in").onclick = function () {
        try { OA.login(); } catch (e) { setPullStatus(String((e && e.message) || e), "err"); }
      };
      return;
    }
    var who = state.user && (state.user.username || state.user.name || state.user.globalName || state.user.id);
    btns.innerHTML =
      (who ? '<span class="bi-who">signed in as <b>' + esc(who) + "</b></span>" : "") +
      '<button class="mbtn" id="bi-auth-load" type="button"' + (state.busy ? " disabled" : "") + ">" +
        (state.busy ? "Loading…" : "Load my characters") + "</button>" +
      '<button class="mbtn" id="bi-auth-out" type="button">Sign out</button>';
    $("bi-auth-load").onclick = function () { loadRosters(true); };
    $("bi-auth-out").onclick = function () {
      state.chars = null; state.user = null; state.raw = null;
      state.note = null; state.error = null;
      OA.logout().then(render);       // logout() forgets locally first, so render is already right
      render();
    };
  }

  /**
   * Sign-in -> roster -> a Favorite per character. Favorites is the spine every tab
   * reads, so favouriting here is what gives the saved grid and the Leaderboard's ★
   * section their contents without any per-tab wiring.
   */
  function loadRosters(force) {
    if (!OA.signedIn()) { render(); return; }
    if (state.busy) return;
    if (state.chars && !force) { render(); return; }
    state.busy = true; state.error = null; state.note = null;
    setPullStatus("Loading your roster…", "working");
    renderAuth();

    Promise.all([
      OA.user().catch(function () { return null; }),
      OA.rosters(),
      seedIndex().catch(function () { return { list: [], byKey: {} }; })
    ]).then(function (r) {
      state.busy = false;
      state.user = r[0];
      state.raw = r[1];
      var idx = r[2] || { byKey: {} };
      var chars = flattenRosters(r[1]);
      state.chars = chars;
      // The roster's own class code covers anyone the board does not know yet.
      chars.forEach(function (c) {
        var k = charKey(c.region, c.name);
        if (!favClasses[k]) {
          var known = idx.byKey[k];
          if (known && known["class"]) favClasses[k] = known["class"];
          else if (CLASS_NAME[String(c.cls || "").toLowerCase()]) favClasses[k] = CLASS_NAME[String(c.cls).toLowerCase()];
        }
      });
      var added = favoriteRoster(chars);
      renderAuth();
      renderFavRow();
      var have = chars.filter(function (c) { return !!idx.byKey[charKey(c.region, c.name)]; }).length;
      setPullStatus(chars.length + " characters · " + have + " with a bracelet already on the board" +
        (added ? " · " + added + " added to saved characters" : ""), "ok");
    }).catch(function (e) {
      state.busy = false;
      var status = e && e.status;
      if (status === 401) {
        // The token is already forgotten by bible-oauth.js. Bounce once through
        // /oauth/authorize, which auto-approves while the grant is alive.
        if (!sessionStorage.getItem(REAUTH_FLAG)) {
          try { sessionStorage.setItem(REAUTH_FLAG, "1"); } catch (err) {}
          state.error = { kind: "expired" };
          render();
          OA.login();
          return;
        }
        state.error = { kind: "reauth-failed" };
      } else {
        state.error = { kind: "api", detail: (e && (e.error || e.message)) || "no answer" };
      }
      setPullStatus("Couldn't load your roster.", "err");
      render();
    });
  }

  /** Save every roster character. Additive only; returns how many were new. */
  function favoriteRoster(chars) {
    var F = root.Favorites;
    if (!F) return 0;
    var n = 0;
    (chars || []).forEach(function (c) {
      if (!c.name || !c.region) return;
      if (F.has(c.region, c.name)) return;
      F.add(c.region, c.name);
      n++;
    });
    return n;
  }

  /**
   * Flatten the rosters payload into [{region, name, cls, itemLevel}]. Region sits
   * on the ROSTER, not the character (docs/research/oauth-rosters-shape.md), so it
   * has to be inherited downward — and lostark.bible's CE becomes our EU here, once,
   * or a saved favourite would come back under a region the select refuses.
   */
  function flattenRosters(j) {
    var rosters = Array.isArray(j) ? j : (j && (j.rosters || j.data)) || [];
    var out = [];
    (Array.isArray(rosters) ? rosters : []).forEach(function (ros) {
      var chars = (ros && (ros.characters || ros.chars)) || [];
      (Array.isArray(chars) ? chars : []).forEach(function (c) {
        if (!c) return;
        var reg = normRegion(c.region || ros.region || "") ||
          String(c.region || ros.region || "").toUpperCase();
        if (reg === "CE") reg = "EU";
        out.push({
          region: reg,
          name: c.name || c.characterName || "",
          cls: c["class"] || c.className || "",
          itemLevel: c.ilvl || c.itemLevel || null,
          raw: c
        });
      });
    });
    return out;
  }

  // ------------------------------------------------------------------
  // modes
  // ------------------------------------------------------------------

  function selectMode(mode) {
    mode = mode === "manual" ? "manual" : "pull";
    state.mode = mode;
    var p = $("bi-mode-pull"), m = $("bi-mode-manual");
    if (!p || !m) return;
    p.classList.toggle("active", mode === "pull");
    m.classList.toggle("active", mode === "manual");
    $("bi-body-pull").style.display = mode === "pull" ? "" : "none";
    $("bi-body-manual").style.display = mode === "manual" ? "" : "none";
    if (mode === "pull") { renderFavRow(); setFreeStatus(); }
  }

  function bind() {
    $("bi-mode-pull").onclick = function () { selectMode("pull"); };
    $("bi-mode-manual").onclick = function () { selectMode("manual"); };
    $("bi-pull-go").onclick = function () { runPull(false); };
    $("bi-pull-refresh").onclick = function () { runPull(true); };
    $("bi-name").onkeydown = function (e) { if (e.key === "Enter") runPull(false); };
    $("bi-region").onchange = syncSourceUI;
    syncSourceUI();
  }

  // ------------------------------------------------------------------
  // the probe helper
  // ------------------------------------------------------------------

  /**
   * BraceletImport.dumpShape() — what /api/oauth/rosters actually returns.
   * Prints every key path plus the first character node, and hands the payload
   * back so it can be copied. The answer belongs in
   * docs/research/oauth-rosters-shape.md; redact character and account names.
   */
  function dumpShape() {
    if (!state.raw) {
      if (!OA.signedIn()) { console.log("[bracelet] not signed in — click the button first."); return null; }
      console.log("[bracelet] no payload yet — fetching…");
      return OA.rosters().then(function (j) { state.raw = j; return dumpShape(); });
    }
    var paths = keyPaths(state.raw, "rosters");
    console.log("[bracelet] /api/oauth/rosters key paths (" + paths.length + "):\n" + paths.join("\n"));
    var chars = findCharacters(state.raw);
    console.log("[bracelet] character-shaped nodes:", chars.length,
      chars.map(function (c) { return c.name + " @ " + c.path; }));
    console.log("[bracelet] bracelet found on first character:", chars.length ? !!findBracelet(chars[0].node) : "n/a");
    console.log("[bracelet] raw payload:", state.raw);
    return state.raw;
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------

  function boot() {
    var box = mount();
    if (!box) return false;
    render();
    // Keep the saved grid honest when a star is toggled anywhere — here, on the
    // banner, or on the Leaderboard.
    if (root.Favorites) root.Favorites.onChange(function () { renderFavRow(); });
    OA.onChange(function () { renderAuth(); });
    // Warm the board so the first chip click and the first field rank are instant.
    seedIndex().then(function (idx) { seedCache = idx; renderFavRow(); });
    // A redirect back from the consent screen carries ?code=…; swap it for a
    // token, scrub the address bar, then load the roster straight away.
    OA.handleRedirect().then(function (r) {
      if (r && !r.ok) {
        state.error = r.error === "access_denied"
          ? { kind: "api", detail: "you turned the request down" }
          : { kind: "api", detail: r.error };
        render();
        return;
      }
      if (r && r.ok) { try { sessionStorage.removeItem(REAUTH_FLAG); } catch (e) {} }
      if (OA.signedIn()) loadRosters(true);
      else renderAuth();
    });
    return true;
  }

  // app.js builds the pane this mounts into, so wait for the host rather than
  // racing it: script order already puts app.js first, but a lazy load or a slow
  // parse must not lose the panel.
  function waitForPanel(tries) {
    if (boot()) return;
    if (tries <= 0) return;
    setTimeout(function () { waitForPanel(tries - 1); }, 60);
  }

  // Console shorthand for the probe. Signed in, `__probeRosters()` prints the
  // real shape of /api/oauth/rosters. See docs/research/oauth-rosters-shape.md.
  root.__probeRosters = dumpShape;

  root.BraceletEcon = Econ;

  root.BraceletImport = {
    dumpShape: dumpShape,
    findCharacters: findCharacters,
    findBracelet: findBracelet,
    buildPatch: buildPatch,
    reload: function () { loadRosters(true); },
    raw: function () { return state.raw; },
    // The loadouts behind the pills, and a way to switch without clicking:
    //   BraceletImport.loadouts()
    //   BraceletImport.pickLoadout(1)
    loadouts: function () { return state.loadouts; },
    pickLoadout: pickLoadout,
    // The one load entry point — a chip, the character banner and the console all
    // come through here, so every path lands in identical state.
    loadCharacter: loadCharacter,
    record: function () { return state.record; },
    // The board figure + where a bracelet sits on the board (app.js draws both).
    defaultScore: defaultScore,
    fieldRank: fieldRank,
    seed: seedIndex,
    // Console handles for checking a fresh deploy without clicking:
    //   BraceletImport.workerUrl()
    //   BraceletImport.fetchCharacter("NA", "Paroxysmal").then(console.log)
    workerUrl: function () { return WORKER_URL; },
    fetchCharacter: fetchCharacter
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForPanel(50); });
  } else {
    waitForPanel(50);
  }
})(window);
