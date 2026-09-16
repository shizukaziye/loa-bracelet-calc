/**
 * leaderboard.js — the "Leaderboard" tab: every character we have a bracelet for,
 * ranked by what that bracelet is worth in % damage.
 *
 * Structure follows loa-astrogem-calc/leaderboard.js almost line for line (region
 * chips, class select, debounced name search, PAGE_SIZE pager, pinned ★ favourites,
 * delegated row clicks, one <style> block scoped to the pane). What changed is the
 * data and the columns.
 *
 * WHERE THE DATA COMES FROM
 *   1. WORKER_URL + "/?list=1", when a Worker is deployed and answers with rows.
 *   2. data/leaderboard-seed.json otherwise — which is the SAME v3 payload, baked.
 * One decoder reads both, so a wire-format change cannot pass the baked copy by.
 * The fallback is silent: a line in the footer says which source the table came
 * from, and only a real failure (no file, HTTP error, network error) speaks up.
 *
 * THE ROW IS A SUMMARY, AND THIS FILE DOES NOT SCORE. Until v3 the payload
 * shipped every character's raw bracelet — and every loadout's, for anyone
 * wearing more than one — and this file decoded and re-scored all of it on load:
 * a grade-checked decode, a set score, a joint score and a 0-100 grade per row,
 * twice over for a support class. That is the whole record travelling to every
 * reader so a table of letters can be drawn.
 *
 * The scoring moved to the Worker, which was already scoring every record it
 * stored. A row now carries the two finished numbers, the decoded effect lines
 * (a family and a tier, not a stat index and a raw value) and the two combat
 * traits. What is left here is DISPLAY: band the numbers on subrank's ladders,
 * letter each line with one lineDamage() call, sort. Anything that needs the
 * bracelet itself — the row click, which loads it into the Calculator — asks
 * GET /character for that one character.
 *
 * WHAT IT RANKS
 *   Everyone is scored on the CANONICAL DEFAULT profile, Bracelet.normalizeProfile({}),
 *   never on the user's own settings. Otherwise the board would rank gear, not
 *   bracelets, and your rank would move when you dragged a slider.
 *
 * MULTI-LOADOUT
 *   A lostark.bible character page carries one loadout per tab (Raid / Chaos /
 *   Est. Raid) and each has its OWN bracelet — 19 of the 59 baked characters wear
 *   different ones. Every loadout is scored; the board ranks the highest, and a
 *   marker beside the name names the alternatives.
 *
 * THE COLUMNS
 *   ★ · Rank · iLvl · Character · Grade · Damage % · Effects · Last pulled.
 *   GRADE is the whole bracelet on the shared 0–100 subrank scale (subrank.js):
 *   0 is the worst bracelet the game can hand you — both combat traits at the
 *   bottom of the band (61 Ancient, 41 Relic) and three lines worth nothing;
 *   100 is a reachable good bracelet, the three best distinct families at Epic
 *   with both traits at 110 (92 Relic). EFFECTS is three subrank letters, one
 *   per line, each scored as that line's share of the strongest single roll on
 *   its grade: the same yardstick the Tier List's by-roll view bands on. Hover
 *   any of them for the full text. Bracelet grade (Relic/Ancient), rolls left
 *   and gap-to-#1 used to have their own columns; they said less than the space
 *   they cost.
 *
 * TWO BOARDS (Shizu, 2026-09-15; astrogem's DPS / Support toggle). A Bard,
 *   Paladin, Artist or Valkyrie is scored twice by the Worker — once as a damage
 *   dealer, once as a support — and the row carries both readings. The DPS
 *   board reads everyone as a damage dealer and drops a support MAIN (support
 *   reading two or more subranks above the dealer one); the Support board reads
 *   the four support classes as supports, where every figure is what ONE damage
 *   dealer gains. Each board sorts on its own Damage % column. Until now one
 *   board showed each character on whichever reading graded better and sorted
 *   on a mapped 0–100 key, because a support's 2% and a dealer's 15% cannot
 *   share a column. Split, they do not have to. See applyMode() and rebuild().
 *
 * NETWORK: this file talks to our own origin (the seed file) and, when configured,
 * to our own Worker. It never touches lostark.bible — only the Worker may, and only
 * with the token.
 *
 * Model API used (window.Bracelet, never modified): normalizeProfile,
 * damagePercent, lineDamage, DATA. Plus window.Subrank for the two ladders and
 * their anchors. The decode and the set scoring are the Worker's now.
 */
(function () {
  "use strict";

  // Kept in sync BY HAND with bible-import.js's own WORKER_URL. Empty = no Worker;
  // the board then reads the baked seed, which is the state this ships in.
  var WORKER_URL = "https://bracelet-bible.shizukaziye.workers.dev";

  // The baked board — the v3 summary. ?v= for the same reason every other file
  // carries one: the loseii zone edge-caches for four hours, so a re-baked seed
  // needs a new URL. It moved to 4 when the file's SHAPE changed, which is the
  // one bump that cannot be skipped: a v3 client reading a cached v2 seed would
  // read percentages out of a stat index.
  var SEED_URL = "data/leaderboard-seed.json?v=4";

  // The whole characters, baked — raw stat lines and every loadout, ~940KB.
  // Fetched ONCE, and only when a row click needs a bracelet and no Worker
  // answered. The Worker's GET /character is the normal path and costs 2KB.
  var CHARS_URL = "data/characters.json?v=1";

  var PAGE_SIZE = 100;      // rows per page; the pager hides itself below one page
  var SEARCH_DEBOUNCE = 200;

  var B = (typeof window !== "undefined" && window.Bracelet) || null;
  var Favs = (typeof window !== "undefined" && window.Favorites) || null;
  var SR = (typeof window !== "undefined" && window.Subrank) || null;

  // The two profiles this tab ever letters a line on. Computed once: both are
  // constants. The DPS board reads every line on the damage-dealer one, the
  // Support board on the support one — see applyMode().
  var DEFAULT_PROFILE = B ? B.normalizeProfile({}) : null;
  var SUPPORT_PROFILE = B ? B.normalizeProfile({ role: "support" }) : null;

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------

  var rawChars = [];      // every row as loaded, scored, unfiltered
  var allChars = [];      // the current DISPLAY list, tagged _rank/_idx
  var searchQuery = "";
  var classFilter = "";
  var mode = "dps";       // "dps" | "support" — which board is shown
  var page = 1;
  var loadedOnce = false;
  var busy = false;
  var sourceNote = "";    // which source the current table came from (footer)

  // ------------------------------------------------------------------
  // region
  // ------------------------------------------------------------------

  /**
   * ONE bucket per region, and EU is that bucket's name.
   *
   * lostark.bible calls central Europe "CE" in its URLs and its payloads, and the
   * seed keeps their spelling. Everything on this side says EU: favorites.js heals
   * a stored "CE" to "EU" when it parses the store, so a character starred as CE
   * would come back as EU on the next page load and its star would go out. A
   * separate CE chip would be a second bucket for one region and a broken star, so
   * CE folds into EU here, once, and only the lostark.bible LINK spells it CE.
   */
  var REGIONS = ["NA", "EU"];
  var REGION_GLOSS = {
    NA: "North America",
    EU: "Europe Central — lostark.bible spells this CE in its URLs"
  };
  function normRegion(r) {
    var s = String(r == null ? "" : r).trim().toUpperCase();
    if (s === "NA" || s === "NAE" || s === "NAW" || s === "US") return "NA";
    if (s === "CE" || s === "EU" || s === "EUC" || s === "EUROPE" || s === "CENTRAL EUROPE") return "EU";
    return s || "";
  }

  var LB_REGION_KEY = "bc_lb_regions";
  var LB_CLASS_KEY = "bc_lb_class";

  function lsGet(k) {
    try { return (typeof localStorage !== "undefined") ? localStorage.getItem(k) : null; }
    catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {}
  }

  function loadRegions() {
    var def = {}, i;
    for (i = 0; i < REGIONS.length; i++) def[REGIONS[i]] = true;   // default: every region on
    var raw = lsGet(LB_REGION_KEY);
    if (raw == null) return def;
    var on = {}, any = false;
    for (i = 0; i < REGIONS.length; i++) on[REGIONS[i]] = false;
    raw.split(",").forEach(function (r) {
      var k = normRegion(r);
      if (on.hasOwnProperty(k)) { on[k] = true; any = true; }
    });
    return any ? on : def;   // never persist an all-off trap: an empty set falls back to all-on
  }
  function writeRegions(regs) {
    var on = [];
    for (var i = 0; i < REGIONS.length; i++) if (regs[REGIONS[i]]) on.push(REGIONS[i]);
    lsSet(LB_REGION_KEY, on.join(","));
  }
  var regions = loadRegions();
  classFilter = lsGet(LB_CLASS_KEY) || "";

  // ------------------------------------------------------------------
  // small helpers
  // ------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function nf(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fx(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }

  /** Compact relative age, the same wording app.js uses for its cache pill. */
  function ageLabel(t) {
    if (!t) return "";
    var ms = Date.now() - t;
    if (ms < 0) ms = 0;
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    return days + "d ago";
  }
  function toTime(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    var t = Date.parse(v);
    return isFinite(t) ? t : null;
  }

  /** The character's page on lostark.bible. EU is CE there, as their URLs have it. */
  function bibleUrl(region, name) {
    var r = normRegion(region) === "EU" ? "CE" : (normRegion(region) || "NA");
    return "https://lostark.bible/character/" + encodeURIComponent(r) + "/" + encodeURIComponent(name || "");
  }

  /**
   * The class glyph. The 29 file names are spelled out because a class we have no
   * file for must get NO icon rather than a wrong one — the same rule app.js
   * follows. Matching ignores case and spacing, so "Guardian Knight" finds
   * Guardianknight; onerror still hides a file that fails for any other reason.
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
  function classIconHtml(cls) {
    if (!cls) return "";
    var file = CLASS_ICON_BY_KEY[String(cls).replace(/[^A-Za-z]/g, "").toLowerCase()];
    if (!file) return "";
    return '<img class="lb-classicon" width="20" height="20" src="assets/class-icons/' +
      encodeURIComponent(file) + '.svg" alt="" aria-hidden="true" loading="lazy" ' +
      'onerror="this.style.display=\'none\'">';
  }

  // ------------------------------------------------------------------
  // display arithmetic — the scoring is the Worker's
  // ------------------------------------------------------------------

  /** The profile a reading letters its lines on. Two constants, one lookup. */
  function profileFor(role) { return role === "support" ? SUPPORT_PROFILE : DEFAULT_PROFILE; }

  // subrank.js caches its anchors for the CANONICAL profile only — pass any
  // other and it recomputes, about 165 lineDamage() calls a time. The support
  // profile is a constant here too, so memoise its yardstick per grade rather
  // than paying for it once a line.
  var supportBestCache = {};
  function bestRollFor(grade, role) {
    if (role !== "support") return SR.bestRoll(grade);
    if (supportBestCache[grade] === undefined) supportBestCache[grade] = SR.bestRoll(grade, SUPPORT_PROFILE);
    return supportBestCache[grade];
  }

  /**
   * The band a row's 0–100 grade falls in, on ITS OWN ROLE'S LADDER.
   *
   * The number comes from the Worker; the cuts stay here. That split is the point:
   * tools/rank-match.mjs re-cuts the support ladder whenever a line's damage
   * moves, and a re-cut has to reach the board on a site deploy rather than
   * waiting for a Worker one.
   */
  function bandOf(c) {
    if (!SR || c._score == null) return null;
    return SR.of(c._score, c._role);
  }

  /** The grade's ANCHOR in % damage — the "good bracelet" a score of 100 means.
   *  A constant per grade and role, so subrank's own cache answers most calls. */
  function anchorPctOf(c) {
    if (!SR || !SR.anchorsFor) return null;
    var a = SR.anchorsFor(c._grade || "ancient", c._role === "support" ? SUPPORT_PROFILE : null);
    return a ? a.perfect : null;
  }

  /**
   * One effect line's subrank: its damage on the canonical default character of
   * THIS READING'S ROLE, as a share of the strongest single roll on that grade —
   * the Tier List's by-roll yardstick, so an S+ pill here and an S+ row there
   * mean the same thing. A line worth nothing is pinned to the bottom band
   * whatever the arithmetic.
   *
   * The role is what finally lets a support's four party lines read as the
   * letters they are: an ally attack-power rider is worth exactly nothing to a
   * damage dealer, so on the DPS reading those lines all pill out at F-.
   */
  function lineSubrank(line, grade, role) {
    if (!SR) return null;
    var sup = role === "support";
    var d = 0;
    try { d = B.lineDamage(line, grade, profileFor(role)) || 0; } catch (e) { d = 0; }
    var best = bestRollFor(grade, role);
    var pct = (best > 0 && d > 0) ? 100 * d / best : 0;
    var ladder = SR.bandsFor(sup ? "support" : "dps");
    return { d: d, pct: pct, band: d > 0 ? SR.of(pct, sup ? "support" : "dps") : ladder[ladder.length - 1] };
  }

  // ---- line text -------------------------------------------------------------

  function resolveFam(f) {
    if (f == null || !B) return null;
    return B.DATA.SPECIAL_BY_ID[f] || B.DATA.SPECIAL_BY_KEY[f] || null;
  }
  /** The official labels carry placeholders (+A%, +X, +B%) that say nothing once
   *  the tier is known, and an ally rider a damage dealer can ignore. Strip both. */
  function cleanFamLabel(fam) {
    return fam.label
      .replace(/;\s*ally[^;]*$/i, "")
      .replace(/\(1\/party\)/g, "")
      .replace(/[+−-]\s*[AXB]%?/g, "")
      .replace(/\s+([;,])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[;,]$/, "");
  }
  /**
   * One effect line as a SUBRANK PILL — the letter and nothing else, coloured by
   * the ladder. Three of them read as "S+ S+ S" at a glance, which is the whole
   * point of the change; every word the old pill printed moved into the tooltip,
   * so nothing was lost, only unstacked.
   */
  function linePill(line, grade, role) {
    var sup = role === "support";
    var sr = lineSubrank(line, grade, role);
    var what, worth, tier = line.tier || "";
    if (line.cat === "basic") {
      what = (line.family === "mainStat" ? "Str / Dex / Int" : "Vitality") + " +" + nf(line.value);
      worth = line.family === "mainStat"
        ? "A flat main-stat line — real damage, but a fraction of what an effect line is worth."
        : "Vitality is dead weight: the model scores it zero.";
      tier = "";
    } else if (line.cat === "trait") {
      what = "Combat trait +" + nf(line.value);
      worth = "A combat trait in a granted slot. The model scores it zero: only the two " +
        "trait lines the bracelet came with count.";
      tier = "";
    } else {
      var fam = resolveFam(line.family);
      if (!fam) {
        return '<span class="lb-sr lb-sr-unk" data-gloss="This line uses a stat index the model does not map yet, ' +
          'so it scores zero. The real bracelet is worth more than this row says.">?</span>';
      }
      var vals = (fam.values[grade] && fam.values[grade][line.tier]) || [];
      what = cleanFamLabel(fam) + (tier ? " · " + tier : "") + (vals.length ? " (" + vals.join(" / ") + ")" : "");
      worth = "Full text: " + fam.label + ".";
    }
    var pct = sr ? sr.pct : 0;
    var key = sr ? sr.band.key : "?";
    var gloss = key + " · " + what + " — worth " +
      fx(B.damagePercent(sr ? sr.d : 0), 2) + "% damage " +
      (sup ? "to one damage dealer, on the default support, " : "on the default character, ") +
      (pct > 0 ? fx(pct, 1) + "% of the strongest single roll an " +
        (grade === "relic" ? "Relic" : "Ancient") + " can carry" +
        (sup ? " for a support." : ".") : "which is nothing at all.") +
      " " + worth + (line.fixed ? " This line is locked." : "");
    var col = sr ? sr.band : SR.BOTTOM;
    return '<span class="lb-sr' + (line.fixed ? " fixed" : "") +
      '" style="background:' + col.bg + ';color:' + col.fg +
      '" data-gloss="' + esc(gloss) + '">' + esc(key) + '</span>';
  }

  // ------------------------------------------------------------------
  // loading — the Worker when it answers, the baked seed otherwise
  // ------------------------------------------------------------------

  /**
   * THE SNAPSHOT ROW, decoded — v3.
   *
   * One row in, one display object out, and no arithmetic on the way except the
   * two things that must stay on this side: the LADDER a number is banded on,
   * and the per-line letters. Everything the row asserts — which loadout the
   * board ranks, which axis a support-class character is shown on, the two
   * percentages and the 0–100 grade — the Worker settled at snapshot time.
   *
   * The row is fixed width at 13. See encodeSnapshot() in worker/bracelet.js for
   * what each slot holds; the short version is
   *
   *   [region, name, ilvl, classIdx, pulledAt, grade, role,
   *    [pct, score, isPerfect], alt, traits, lines, unmapped, loadouts]
   *
   * with `lines` a flat run of (cat, family, tierOrValue, fixed) and `traits` a
   * flat run of (traitCode, value).
   *
   * THE SUPPORT CLASSES no longer appear in this file. A Bard, Paladin, Artist or
   * Valkyrie is read twice — once as a damage dealer, once as a support — and
   * both readings are in the row: slot 6 says which one the Worker's
   * better-letter rule picked, slot 7 is that one, slot 8 the other. This side
   * files them by AXIS instead — `_dps` and `_sup` — because the two boards
   * each want one axis, not the winner. The list of which classes get the
   * second reading is the Worker's SUPPORT_CLASSES, so there is one copy of it
   * and not two drifting apart: a row with a slot-8 reading is a support class.
   */
  var CATS = ["special", "basic", "trait"];
  var TIERS = ["low", "mid", "high"];
  var BASIC_FAMS = ["mainStat", "vitality"];
  var TRAIT_FAMS = ["crit", "spec", "swiftness"];

  function fromSnapshot(data) {
    if (!data || !Array.isArray(data.characters)) return [];
    var classes = data.classes || [], labels = data.labels || [];

    function unlines(flat, grade) {
      var out = [], i;
      flat = flat || [];
      for (i = 0; i + 3 < flat.length; i += 4) {
        var cat = CATS[flat[i]] || "special";
        var line = { cat: cat, fixed: !!flat[i + 3], tier: null, value: null };
        if (cat === "special") {
          line.family = flat[i + 1];
          line.tier = TIERS[flat[i + 2]] || null;
        } else {
          line.family = (cat === "basic" ? BASIC_FAMS : TRAIT_FAMS)[flat[i + 1]] || null;
          line.value = flat[i + 2];
        }
        out.push(line);
      }
      return out;
    }
    function untraits(flat) {
      var out = [], i;
      flat = flat || [];
      for (i = 0; i + 1 < flat.length; i += 2) {
        out.push({ family: TRAIT_FAMS[flat[i]] || null, value: flat[i + 1] });
      }
      return out;
    }

    return data.characters.map(function (a) {
      var read = a[7] || [], alt = a[8], lo = a[12];
      var grade = a[5] === 1 ? "relic" : "ancient";
      var won = {
        pct: typeof read[0] === "number" ? read[0] : null,
        score: typeof read[1] === "number" ? read[1] : null,
        isPerfect: !!read[2]
      };
      // The Worker settles the rainbow on the reading it picked, and a bracelet
      // at the ceiling of one axis is nowhere near the ceiling of the other (the
      // best families differ), so the reading it did not pick is never perfect.
      var lost = (alt && typeof alt[0] === "number")
        ? { pct: alt[0], score: typeof alt[1] === "number" ? alt[1] : null, isPerfect: false }
        : null;
      var supWon = a[6] === 1;
      var c = {
        name: a[1],
        region: normRegion(a[0]),
        "class": (a[3] != null && a[3] >= 0) ? (classes[a[3]] || null) : null,
        itemLevel: a[2] != null ? Math.round(a[2]) : null,
        pulledAt: toTime(a[4]),
        _grade: grade,
        // Both axes, filed by axis. `_sup` is null on every class but the four.
        _dps: supWon ? lost : won,
        _sup: supWon ? won : lost,
        // The display fields every cell reads. applyMode() fills them from the
        // active board's axis before each rebuild.
        _role: "dps",
        _pct: null,
        _score: null,
        _isPerfect: false,
        _traits: untraits(a[9]),
        _lines: unlines(a[10], grade),
        _unmapped: a[11] || 0,
        loadouts: null,
        best: 0,
        distinctBrackets: 1
      };
      if (lo && lo.length === 3) {
        c.distinctBrackets = lo[0] || 1;
        c.best = lo[1] || 0;
        c.loadouts = [];
        for (var i = 0; i + 1 < lo[2].length; i += 2) {
          c.loadouts.push({
            label: (lo[2][i] >= 0 && labels[lo[2][i]]) || ("Loadout " + (c.loadouts.length + 1)),
            // The DAMAGE-DEALER reading, always: that is the axis the loadout is
            // picked on, for every character, and the marker says so.
            pct: typeof lo[2][i + 1] === "number" ? lo[2][i + 1] : null
          });
        }
      }
      return c;
    });
  }

  /**
   * TWO BOARDS, ONE ROW.
   *
   * The board used to show each support-class character on whichever reading
   * graded better and sort every row on one 0–100 key, mapping a support score
   * onto the DPS scale through the two ladders' cut pairs — because a support
   * reading is ~1-2% where a dealer's is ~15%, and the two cannot share a
   * column. They no longer have to. The DPS board reads everyone as a damage
   * dealer; the Support board reads the four support classes as supports; and
   * each sorts on its own Damage % column, as the board did before supports
   * were scored at all. A rank is once more "how much damage", within one axis.
   */
  function isSupportClass(c) { return !!(c && c._sup); }

  /**
   * A SUPPORT MAIN leaves the DPS board: a support class whose support reading
   * lands two or more subranks above its damage-dealer one. astrogem's rule,
   * for astrogem's reason — they are playing support, and their dealer-read
   * bracelet would only clutter a board they are not competing on. Within one
   * subrank, or with the dealer reading ahead, they stay on both boards. Band
   * index 0 is S+, so "above" is a SMALLER index.
   */
  function isSupportMain(c) {
    if (!SR || !c._sup || !c._dps || c._sup.score == null || c._dps.score == null) return false;
    return SR.of(c._dps.score, "dps").i - SR.of(c._sup.score, "support").i >= 2;
  }

  /** The active board's reading of this row — null when it has none for it. */
  function readingFor(c) { return mode === "support" ? c._sup : c._dps; }

  /**
   * Put the active board's reading on the display fields every cell reads.
   * `_role` is what bandOf(), the line letters and every gloss key on, so this
   * one assignment is what makes a Bard's four party lines pill out as letters
   * on the Support board and as F- on the DPS one.
   */
  function applyMode(c) {
    var r = readingFor(c);
    c._role = mode;
    c._pct = r ? r.pct : null;
    c._score = r ? r.score : null;
    c._isPerfect = !!(r && r.isPerfect);
  }

  // ------------------------------------------------------------------
  // the four degradation messages
  // ------------------------------------------------------------------

  var MSG = {
    missing: {
      title: "No board data on this deploy",
      body: "data/leaderboard-seed.json is not on the server and no Worker is configured, " +
            "so there is nothing to rank. Nothing is wrong with your browser."
    },
    empty: {
      title: "Nobody on the board yet",
      body: "The data loaded, but it carries no characters. Import one in the Calculator and it will appear here."
    },
    http: {
      title: "The board could not be loaded",
      body: "The server answered with an error. Try Refresh in a moment."
    },
    network: {
      title: "Could not reach the board",
      body: "The request failed before it got an answer — usually a connection that dropped, or an extension blocking it."
    }
  };

  // ------------------------------------------------------------------
  // styles — one block, scoped to the pane (astrogem's pattern)
  // ------------------------------------------------------------------

  var STYLE =
'<style>' +
'  #tab-leaderboard .lb-status{font-size:12px;color:var(--dim);min-height:16px}' +
'  #tab-leaderboard .lb-status.err{color:var(--bad)}' +
'  #tab-leaderboard .lb-actions{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}' +
'  #tab-leaderboard table{width:100%;table-layout:fixed}' +
// The fixed column widths add up to more than a narrow laptop window. When they
// do, the TABLE scrolls sideways inside its own box — the page never does.
'  #tab-leaderboard .lb-tw{overflow-x:auto}' +
'  #tab-leaderboard .lb-tw table{min-width:660px}' +
'  #tab-leaderboard td,#tab-leaderboard th{overflow:hidden}' +
'  #tab-leaderboard tbody tr{cursor:pointer}' +
'  #tab-leaderboard tbody tr:hover{background:var(--panel2)}' +
// A clicked row fetches its bracelet — the row no longer carries one. Usually
// one small KV read and gone in a blink; visible when the network is slow, and
// it has to be, or a slow click reads as a dead one.
'  #tab-leaderboard tbody tr.loading{cursor:progress;opacity:.55}' +
'  #tab-leaderboard td.lb-char{white-space:nowrap}' +
'  #tab-leaderboard .lb-charwrap{display:flex;align-items:center;min-width:0}' +
'  #tab-leaderboard .lb-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
     'font-weight:700;color:var(--text);text-decoration:none;border-bottom:1px dotted transparent}' +
'  #tab-leaderboard .lb-name:hover{color:var(--accent);border-bottom-color:var(--accent)}' +
'  #tab-leaderboard .lb-region{color:var(--dim);font-weight:600;font-size:11px;margin-left:6px;flex:0 0 auto}' +
'  #tab-leaderboard .lb-rank{font-variant-numeric:tabular-nums;color:var(--dim);font-weight:700}' +
'  #tab-leaderboard .lb-ilvl{color:var(--text);font-weight:700;font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-dmg{color:var(--axis,var(--accent));font-weight:800;font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-age{font-variant-numeric:tabular-nums;color:var(--dim)}' +
'  #tab-leaderboard .lb-dash{color:var(--dim)}' +
'  #tab-leaderboard img.lb-classicon{width:20px;height:20px;vertical-align:middle;margin-right:7px;' +
     'object-fit:contain;opacity:.9;flex:0 0 auto;filter:brightness(0) invert(.82)}' +
// the overall grade: a big subrank badge, astrogem's rank shape, plus the number
'  #tab-leaderboard .lb-gradecell{white-space:nowrap}' +
'  #tab-leaderboard .lb-badge{display:inline-flex;align-items:center;justify-content:center;min-width:34px;' +
     'height:26px;padding:0 6px;border-radius:6px;font-weight:900;' +
     'font-size:15px;line-height:1;letter-spacing:-.02em;vertical-align:middle;text-decoration:none;cursor:help}' +
'  #tab-leaderboard .lb-badge.top{box-shadow:0 0 14px rgba(230,213,166,.45)}' +
// The perfect-bracelet rainbow, lifted from astrogem's styles.css. The inline
// background shorthand resets background-size, so the tiling needs !important;
// 0%->400% is exactly three tile widths, so the slide loops without a seam.
// Static gradient under reduced-motion.
'  #tab-leaderboard .rank-rainbow{background-size:400% 100% !important}' +
'  @media (prefers-reduced-motion:no-preference){' +
'    #tab-leaderboard .rank-rainbow{animation:rank-rainbow-slide 8s linear infinite}' +
'    @keyframes rank-rainbow-slide{from{background-position:0% 50%}to{background-position:400% 50%}}' +
'  }' +
'  #tab-leaderboard .lb-score{margin-left:7px;color:var(--text);font-weight:700;font-size:12.5px;' +
     'font-variant-numeric:tabular-nums;vertical-align:middle}' +
// only phones show this: there the Damage % column collapses to buy the name room
'  #tab-leaderboard .lb-dmgmini{display:none}' +
// effect lines, as subrank letters
'  #tab-leaderboard .lb-lines{display:flex;gap:4px;flex-wrap:nowrap;overflow:hidden}' +
'  #tab-leaderboard .lb-sr{display:inline-flex;align-items:center;justify-content:center;min-width:26px;' +
     'height:19px;padding:0 4px;border-radius:5px;box-shadow:inset 0 0 0 1px transparent;' +
     'font-weight:900;font-size:11.5px;line-height:1;letter-spacing:-.03em;' +
     'text-decoration:none;cursor:help;flex:0 0 auto}' +
// A locked line keeps the dashed tell the old pill had, drawn INSIDE the chip so
// it costs no width — the ring is the panel colour, which reads as a cut edge.
'  #tab-leaderboard .lb-sr.fixed{outline:1px dashed var(--bg);outline-offset:-3px}' +
'  #tab-leaderboard .lb-sr-unk{color:var(--bad) !important;background:none !important;box-shadow:inset 0 0 0 1px var(--bad)}' +
// the multi-loadout marker
'  #tab-leaderboard .lb-lo{flex:0 0 auto;margin-left:6px;font-size:10px;font-weight:800;color:var(--mid);' +
     'border:1px solid var(--border);border-radius:5px;padding:0 4px;cursor:help;text-decoration:none}' +
'  #tab-leaderboard .lb-warn{flex:0 0 auto;margin-left:5px;color:var(--bad);font-size:11px;cursor:help;text-decoration:none}' +
// star cell
'  #tab-leaderboard th.lb-star,#tab-leaderboard td.lb-star{text-align:center;padding-left:4px;padding-right:4px}' +
'  #tab-leaderboard .lb-starbtn{background:none;border:none;cursor:pointer;font-size:17px;line-height:1;' +
     'padding:2px 3px;color:var(--none);font-family:inherit;transition:color .12s,transform .08s}' +
'  #tab-leaderboard .lb-starbtn:hover{transform:scale(1.18);color:var(--high)}' +
'  #tab-leaderboard .lb-starbtn.on{color:var(--high)}' +
// pinned favourites
'  #tab-leaderboard .lb-favsec{margin:2px 0 18px}' +
'  #tab-leaderboard .lb-favsec h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--high);' +
     'margin:0 0 8px;font-weight:700;display:flex;align-items:center;gap:8px}' +
'  #tab-leaderboard .lb-favsec h3 .ct{color:var(--dim);font-weight:600;letter-spacing:.02em;font-size:11px;text-transform:none}' +
'  #tab-leaderboard .lb-favsec table{border:1px solid var(--border);border-radius:10px;overflow:hidden}' +
'  #tab-leaderboard .lb-mainhdr{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--axis,var(--accent));margin:0 0 8px;font-weight:700}' +
// controls
// The DPS / Support toggle — astrogem's pill, and astrogem's two axis colours.
// The toggle, the Damage % column and the section header take the board's
// colour, so a glance says which board this is. Everything else keeps --accent.
'  #tab-leaderboard.axis-dps{--axis:#e18ac0}' +
'  #tab-leaderboard.axis-support{--axis:#66c7ff}' +
'  #tab-leaderboard .lb-modes{display:inline-flex;border:1px solid var(--border);border-radius:99px;overflow:hidden}' +
'  #tab-leaderboard .lb-modebtn{background:none;border:none;cursor:pointer;color:var(--dim);font-family:inherit;' +
     'font-weight:700;font-size:12px;padding:5px 16px;line-height:1.4;transition:background .12s,color .12s;text-decoration:none}' +
'  #tab-leaderboard .lb-modebtn:hover:not(.on){color:var(--text)}' +
'  #tab-leaderboard .lb-modebtn.on{background:var(--axis,var(--accent));color:#0c0e12}' +
'  #tab-leaderboard .lb-regs{display:inline-flex;border:1px solid var(--border);border-radius:99px;overflow:hidden}' +
'  #tab-leaderboard .lb-regbtn{background:none;border:none;cursor:pointer;color:var(--dim);font-family:inherit;' +
     'font-weight:700;font-size:12px;padding:5px 13px;line-height:1.4;transition:background .12s,color .12s}' +
'  #tab-leaderboard .lb-regbtn + .lb-regbtn{border-left:1px solid var(--border)}' +
// A button carrying data-gloss inherits the dotted "hover me" underline from
// styles.css. On a chip that reads as a rendering fault, so buttons opt out.
'  #tab-leaderboard .lb-regbtn,#tab-leaderboard .lb-refresh{text-decoration:none;cursor:pointer}' +
'  #tab-leaderboard .lb-regbtn:hover:not(.on){color:var(--text)}' +
'  #tab-leaderboard .lb-regbtn.on{background:#4b5563;color:#fff}' +
'  #tab-leaderboard .lb-classsel{background:var(--panel2);border:1px solid var(--border);border-radius:99px;' +
     'color:var(--text);font-family:inherit;font-weight:700;font-size:12px;padding:6px 12px;outline:none;cursor:pointer;max-width:170px}' +
'  #tab-leaderboard .lb-search{background:var(--panel2);border:1px solid var(--border);border-radius:99px;' +
     'color:var(--text);font-family:inherit;font-size:12px;padding:6px 14px;width:150px;outline:none}' +
'  #tab-leaderboard .lb-search:focus,#tab-leaderboard .lb-classsel:focus{border-color:var(--axis,var(--accent))}' +
'  #tab-leaderboard .lb-search::placeholder{color:var(--dim)}' +
'  #tab-leaderboard .lb-refresh{background:var(--panel2);border:1px solid var(--border);border-radius:99px;' +
     'color:var(--text);font-family:inherit;font-weight:700;font-size:12px;padding:6px 14px;cursor:pointer}' +
'  #tab-leaderboard .lb-refresh:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}' +
'  #tab-leaderboard .lb-refresh:disabled{opacity:.45;cursor:default}' +
// pager + footer
'  #tab-leaderboard .lb-pager{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap;color:var(--dim);font-size:12px}' +
'  #tab-leaderboard .lb-pagebtn{background:var(--panel2);border:1px solid var(--border);border-radius:8px;' +
     'color:var(--text);font-family:inherit;font-weight:700;font-size:12px;padding:5px 12px;cursor:pointer}' +
'  #tab-leaderboard .lb-pagebtn:disabled{opacity:.4;cursor:default}' +
'  #tab-leaderboard .lb-pageinfo{font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-jump{width:56px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;' +
     'color:var(--text);font-family:inherit;font-size:12px;padding:5px 6px;text-align:center}' +
'  #tab-leaderboard .lb-hint{color:var(--dim);font-size:11px;margin-top:10px}' +
'  #tab-leaderboard .lb-foot{color:var(--dim);font-size:11px;line-height:1.6;margin-top:14px;max-width:95ch}' +
'  #tab-leaderboard .lb-foot:empty{display:none}' +
'  #tab-leaderboard .lb-foot b{color:var(--text)}' +
'  #tab-leaderboard .lb-foot p{margin:0 0 5px}' +
// PHONES: the fixed columns overflow a 375px screen and squeeze the name to nothing.
// Zero the columns that can go, kill their padding, and never display:none a MIDDLE
// cell — that shifts every cell after it off its column. Only the LAST cell is hidden.
'  @media(max-width:700px){' +
'    #tab-leaderboard .panel{padding-left:6px;padding-right:6px}' +
'    #tab-leaderboard .lb-tw table{min-width:0}' +
// Age is the LAST cell, so display:none is safe there and nowhere else.
'    #tab-leaderboard .lc-age{width:0 !important}#tab-leaderboard .lb-agecell{display:none}' +
// Damage % collapses and reappears under the grade badge, which buys the name
// about seventy pixels — the difference between a readable name and four letters.
'    #tab-leaderboard .lc-dmg{width:0 !important}' +
'    #tab-leaderboard .lb-dmg{padding-left:0 !important;padding-right:0 !important;font-size:0}' +
'    #tab-leaderboard .lb-dmgmini{display:block;color:var(--axis,var(--accent));font-weight:700;font-size:10.5px;' +
       'font-variant-numeric:tabular-nums;margin-top:2px}' +
// The grade cell stacks instead of sitting on one line: badge, then number,
// then the damage the collapsed column used to carry.
'    #tab-leaderboard .lb-score{display:block;margin-left:0;font-size:11px}' +
'    #tab-leaderboard .lc-star{width:22px !important}#tab-leaderboard .lc-rank{width:28px !important}' +
'    #tab-leaderboard .lc-ilvl{width:38px !important}#tab-leaderboard .lb-ilvl{font-size:11px}' +
'    #tab-leaderboard .lc-grade{width:46px !important}' +
'    #tab-leaderboard .lc-lines{width:82px !important}' +
'    #tab-leaderboard .lb-sr{min-width:22px;height:17px;font-size:10.5px;padding:0 2px}' +
'    #tab-leaderboard .lb-lines{gap:3px}' +
'    #tab-leaderboard .lb-badge{min-width:28px;height:22px;font-size:13px;padding:0 4px}' +
'    #tab-leaderboard img.lb-classicon{width:16px;height:16px;margin-right:4px}' +
'    #tab-leaderboard .lb-region{display:none}' +
'    #tab-leaderboard td,#tab-leaderboard th{padding-left:3px;padding-right:3px}' +
'    #tab-leaderboard .lb-search{width:110px}' +
'  }' +
'</style>';

  // ------------------------------------------------------------------
  // markup
  // ------------------------------------------------------------------

  /**
   * One of the grade scale's anchors, as a damage percentage, READ FROM THE
   * MODEL. The method block used to carry 22.87% and 2.00% as literals; both had
   * been wrong since the trait floor was raised to the band end, and a figure
   * that cannot go stale is the only kind worth printing beside a scale that
   * moves. `which` is "floor", "perfect" or "ceiling".
   */
  function anchorPct(grade, which) {
    if (!B || !SR || !SR.anchorsFor) return "—";
    var a = SR.anchorsFor(grade);
    var d = a && a[which];
    return typeof d === "number" && isFinite(d) ? fx(B.damagePercent(d), 2) : "—";
  }

  function regionChips() {
    var h = '<div class="lb-regs" role="group" aria-label="Filter by region">';
    for (var i = 0; i < REGIONS.length; i++) {
      var r = REGIONS[i], on = !!regions[r];
      h += '<button class="lb-regbtn' + (on ? " on" : "") + '" id="lb-reg-' + r + '" type="button"' +
        ' aria-pressed="' + (on ? "true" : "false") + '" data-gloss="' + esc(REGION_GLOSS[r] || r) + '">' + r + '</button>';
    }
    return h + '</div>';
  }

  function shell() {
    return STYLE +
'<div class="panel">' +
'  <h2>Leaderboard</h2>' +
'  <div class="lb-actions">' +
'    <div class="lb-modes" role="group" aria-label="Leaderboard type">' +
'      <button class="lb-modebtn on" id="lb-mode-dps" type="button" aria-pressed="true"' +
       ' data-gloss="Everyone, read as a damage dealer and ranked by what the bracelet is worth to their own damage. A support main — support reading two or more subranks above the dealer one — is on the Support board instead.">DPS</button>' +
'      <button class="lb-modebtn" id="lb-mode-support" type="button" aria-pressed="false"' +
       ' data-gloss="Bard, Paladin, Artist and Valkyrie, every one of them, read as a support and ranked by what the bracelet is worth to ONE damage dealer they buff.">Support</button>' +
'    </div>' +
     regionChips() +
'    <select class="lb-classsel" id="lb-class" aria-label="Filter by class"><option value="">All classes</option></select>' +
'    <input class="lb-search" id="lb-search" type="search" placeholder="Search name&hellip;" autocomplete="off" aria-label="Search characters by name">' +
'    <button type="button" class="lb-refresh" id="lb-refresh" data-gloss="Re-read the board. A character imported a moment ago appears without reloading the page.">Refresh</button>' +
'    <span class="lb-status" id="lb-status"></span>' +
'  </div>' +
'  <div id="lb-body"></div>' +
'  <div class="lb-foot" id="lb-foot"></div>' +
'</div>' +
'<details class="method">' +
'  <summary>How the leaderboard ranks bracelets</summary>' +
'  <p><b>The verdict.</b> Every bracelet is scored in <b>% damage</b> on one shared, canonical character &mdash; ' +
     'the calculator&rsquo;s untouched defaults, <code>normalizeProfile({})</code> &mdash; and the board sorts on that number, highest first.</p>' +
'  <p><b>Why your rank is not your Calculator number.</b> The Calculator scores your bracelet on <i>your</i> character: your crit, ' +
     'your gear, your fight. This board deliberately does not. If it used each player&rsquo;s own settings it would be ranking gear ' +
     'and fight profiles, not bracelets, and nobody&rsquo;s rank would mean anything.</p>' +
'  <p><b>The arithmetic is the Calculator&rsquo;s</b>, called with different settings &mdash; the same trait model, the same line ' +
     'model, pooled across the whole bracelet, added in log space and converted once. Where it runs is the one thing particular to ' +
     'this board: every bracelet is scored <b>once, on the server</b>, when the board is built, and what reaches your browser is a ' +
     'row of finished numbers rather than sixty-odd raw brackets to re-score on every visit. Click a row and it fetches that one ' +
     'character&rsquo;s bracelet to hand to the Calculator.</p>' +
'  <p><b>The 0&ndash;100 grade.</b> The Damage % column answers &ldquo;how much&rdquo;, and the board ranks on it; the Grade column answers ' +
     '&ldquo;how good a bracelet&rdquo;. It is a straight line between two fixed points: ' +
     '<b>0</b> is the worst bracelet the game can hand you &mdash; both combat traits at the bottom of the band, ' +
     '61 on an Ancient and 41 on a Relic, and three effect lines worth nothing &mdash; and <b>100</b> is a reachable ' +
     'good bracelet: the three best distinct effect families at Epic with both traits at 110 (92 on a Relic). ' +
     'On an Ancient that good bracelet is <b>' + anchorPct("ancient", "perfect") + '% damage</b> and that floor is <b>' +
     anchorPct("ancient", "floor") + '%</b>. Scores run past 100, because the yardstick is beatable; the animated rainbow ' +
     'is reserved for the one bracelet that cannot be beaten &mdash; three Legendary rolls of the three best families with ' +
     'both traits at the top of the band, which lands near ' + anchorPct("ancient", "ceiling") + '%. Each effect line gets ' +
     'its own letter on the same ladder, scored against the strongest single roll its grade can carry &mdash; the Tier ' +
     'List&rsquo;s by-roll yardstick, so a letter means one thing across both tabs.</p>' +
'  <p><b>Loadouts.</b> A lostark.bible character page carries one loadout per tab &mdash; Raid, Chaos Dungeon, sometimes an ' +
     'estimated raid one &mdash; and each has its own bracelet. Every loadout is scored and the board ranks the highest. ' +
'     The <span class="lb-lo">2</span> marker beside a name means that character wears more than one distinct bracelet; hover it for the others.</p>' +
'  <p><b>Where the data comes from.</b> It is <b>self-reported</b>: collected from public lostark.bible character pages, showing ' +
     'whatever the owner&rsquo;s roster last synced there, which can be weeks behind what they are wearing today. It is not a ' +
     'verified snapshot and it is not a complete list of anything. The line under the table says which copy you are reading and ' +
     'how old it is.</p>' +
'  <p><b>DPS / Support toggle.</b> DPS reads everyone as a damage dealer and ranks by Damage %. Support keeps only the four ' +
     'support classes &mdash; Bard, Paladin, Artist, Valkyrie, every one of them, even the DPS-built &mdash; read as a support, ' +
     'where the % is what <b>one damage dealer</b> gains from the bracelet rather than the wearer&rsquo;s own damage. A support&rsquo;s ' +
     'couple of percent and a dealer&rsquo;s fifteen are not the same measurement, which is why they are two boards and not one. ' +
     'The letters carry across: the support ladder is cut to the same rarities as the dealer&rsquo;s, so a support A&minus; is as rare as a dealer&rsquo;s.</p>' +
'  <p><b>Support mains move off the DPS board.</b> A support-class character whose <i>support</i> reading grades two or more ' +
     'subranks above their <i>damage-dealer</i> reading (say B&minus; as a dealer but B+ as a support) is really playing support, ' +
     'and is dropped from DPS &mdash; they belong on the Support board. Within one subrank, or with the dealer reading ahead, they stay on both.</p>' +
'  <p><b>What is left out.</b> A line whose stat index the model does not map yet scores zero and is flagged rather than hidden. ' +
     'The default profile leaves the Demon/Archdemon share at zero, which costs the one family that depends on it &mdash; the ' +
     'Method tab has the working.</p>' +
'  <p>Not affiliated with Smilegate, Amazon Games or lostark.bible.</p>' +
'</details>';
  }

  function setStatus(msg, kind) {
    var el = $("lb-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "lb-status" + (kind ? " " + kind : "");
  }

  function renderMessage(m) {
    var body = $("lb-body");
    if (body) body.innerHTML = '<div class="placeholder"><b>' + esc(m.title) + '</b>' + esc(m.body) + '</div>';
  }

  // ---- footer ---------------------------------------------------------------

  /**
   * PROVENANCE ONLY — which source the table on screen came from, and how old it
   * is. That is the one thing the footer can say that the table cannot, so it is
   * the one thing left inline (docs/design/copy-rules.md, rule 4).
   *
   * The disclosure that used to sit here — scored on the default character,
   * self-reported, not affiliated — is unchanged, but it moved into the
   * methodology block at the foot of the tab, where it is read by anyone who
   * opens it and is out of the way of anyone who does not.
   */
  function footHtml() {
    return sourceNote ? "<p>" + esc(sourceNote) + "</p>" : "";
  }
  function paintFoot() {
    var el = $("lb-foot");
    if (el) el.innerHTML = footHtml();
  }

  // ---- rows -----------------------------------------------------------------

  function starCell(c, i) {
    if (!Favs) return '';
    var on = Favs.has(c.region, c.name);
    return '<td class="lb-star">' +
      '<button type="button" class="lb-starbtn' + (on ? " on" : "") + '" data-star="' + i + '"' +
      ' title="' + (on ? "Remove from favorites" : "Add to favorites") + '"' +
      ' aria-pressed="' + (on ? "true" : "false") + '">' + (on ? "&#9733;" : "&#9734;") + '</button></td>';
  }

  /** The >1-bracelet marker and its tooltip, naming the alternatives and their scores. */
  function loadoutMarker(c) {
    if (!c.loadouts || c.loadouts.length < 2 || c.distinctBrackets < 2) return '';
    var parts = [], i;
    for (i = 0; i < c.loadouts.length; i++) {
      var lo = c.loadouts[i];
      parts.push(lo.label + " " + (lo.pct == null ? "—" : fx(lo.pct, 2) + "%") + (i === c.best ? " (ranked)" : ""));
    }
    // The per-loadout figures are the DAMAGE-DEALER reading, always: that is the
    // one the loadout is picked on, for every character. On the Support board
    // the cell's own number is a different measurement, so say which is which
    // rather than let two percentages contradict.
    return '<span class="lb-lo" data-gloss="' + esc(c.distinctBrackets + " different bracelets across this character's " +
      c.loadouts.length + " lostark.bible loadouts. The board ranks the highest. " + parts.join(" · ") +
      (isSupportRead(c) ? " Those are the damage-dealer figures the loadout is chosen on; this board shows the support reading, which is per one dealer." : "")) +
      '">' + c.distinctBrackets + '</span>';
  }

  /**
   * The one sentence that says what 0 and 100 are, used at all three places the
   * board explains the Grade column. It used to say "two 40 combat traits" and
   * "their best roll" and "traits at the cap", none of which was true of the
   * scale subrank.js actually builds.
   */
  function gradeAnchorSentence(grade) {
    var relic = grade === "relic";
    return "0 is the worst bracelet the game can hand you — both combat traits at the bottom of the band (" +
      (relic ? "41 Relic" : "61 Ancient") + ") and three lines worth nothing; 100 is a reachable good bracelet: " +
      "the three best distinct families at Epic with both traits at " + (relic ? "92" : "110") + ".";
  }

  /**
   * The whole bracelet as one big subrank badge plus its 0–100 number — the
   * headline verdict, in the shape astrogem uses for a rank. The damage figure
   * rides along in a second line that only phones show, where the Damage %
   * column has been collapsed to make room for the name.
   */
  function gradeCell(c) {
    var b = bandOf(c);
    if (!b) return '<span class="lb-dash">&mdash;</span>';
    var sup = isSupportRead(c);
    var anchor = anchorPctOf(c);
    var gloss = "Bracelet grade " + fx(c._score, 1) + " out of 100, subrank " + b.key + ". " +
      gradeAnchorSentence(c._grade) + " This bracelet is worth " +
      fx(c._pct == null ? 0 : c._pct, 2) + "% damage " +
      (sup ? "to one damage dealer, on the default support, against " : "on the default character, against ") +
      (anchor == null ? "—" : fx(B.damagePercent(anchor), 2)) + "% for that good one." +
      (sup ? " Read on the support ladder, which is cut to the same rarities as the damage dealer's — a support " +
        b.key + " is as rare as a dealer's " + b.key + "." : "") +
      // A support class is on both boards, or on the other one; name what the
      // other axis says so the two boards never look like they disagree.
      otherAxisSentence(c);
    // Only the CEILING wears the animated rainbow — the three best distinct
    // families at Legendary with both traits at the top of the band. astrogem
    // gates it on the config being perfect rather than on the band, for the same
    // reason: an S+ is not a ceiling, and the rainbow has to mean the ceiling.
    // The Worker decides it, on the same numbers it scored the bracelet with: at
    // the ceiling the total equals an anchor to the last bit, and re-deriving it
    // here from a rounded score would make the rainbow flicker on noise.
    var col = SR.colorOf(b.key, c._isPerfect);
    return '<span class="lb-badge' + (b.top ? " top" : "") + (col.cls ? " " + col.cls : "") +
      '" style="background:' + col.bg + ';color:' + col.fg +
      '" data-gloss="' + esc(gloss) + '">' + esc(b.key) + '</span>' +
      '<span class="lb-score">' + fx(c._score, 1) + '</span>' +
      // Phones collapse the Damage % column into this line, so the per-dealer
      // tell has to ride along with it or it is lost on the smaller screen.
      '<span class="lb-dmgmini">' + (c._pct == null ? "&mdash;" : fx(c._pct, 2) + "%") + '</span>';
  }

  /** Is this row being shown on the support axis rather than the dealer one? */
  function isSupportRead(c) { return c._role === "support"; }

  /**
   * What the OTHER board says about a support class's bracelet, for the Grade
   * tooltip. Empty on a damage dealer, who is only ever on one board.
   */
  function otherAxisSentence(c) {
    if (!SR || !isSupportClass(c)) return "";
    if (isSupportRead(c)) {
      if (!c._dps || c._dps.score == null) return "";
      return " Read as a damage dealer the same bracelet grades " + SR.of(c._dps.score, "dps").key +
        " at " + fx(c._dps.pct == null ? 0 : c._dps.pct, 2) + "%" +
        (isSupportMain(c) ? ", two or more subranks below this, so it is off the DPS board." : ", which is where the DPS board has it.");
    }
    if (c._sup.score == null) return "";
    return " A support class: read as a support, on the Support board, the same bracelet grades " +
      SR.of(c._sup.score, "support").key + " at " + fx(c._sup.pct == null ? 0 : c._sup.pct, 2) + "% per damage dealer.";
  }

  /**
   * The Damage % cell. On the Support board the figure is WHAT ONE DAMAGE
   * DEALER GAINS, not a party total and not the wearer's own damage; the column
   * header says so, and the gloss says it again for anyone who hovers.
   */
  function dmgCell(c) {
    if (c._pct == null) return '<span class="lb-dash">&mdash;</span>';
    var n = fx(c._pct, 2) + "%";
    if (!isSupportRead(c)) return n;
    return '<span data-gloss="' + esc("What one damage dealer standing next to this support gains from the bracelet — " +
      "their buffs and debuffs, measured on the dealer they buff. Not the party total, and not this character's own damage.") +
      '">' + n + '</span>';
  }

  function linesCell(c) {
    if (!c._lines || !c._lines.length) return '<span class="lb-dash">&mdash;</span>';
    var h = '<div class="lb-lines">', i;
    for (i = 0; i < c._lines.length; i++) h += linePill(c._lines[i], c._grade, c._role);
    return h + '</div>';
  }

  /**
   * One row. `i` indexes allChars for the delegated handlers; `rankNum` is the
   * OVERALL rank, so a favourite that is #3 still reads #3 in the pinned section.
   */
  function charRow(c, i, rankNum) {
    var warn = c._unmapped
      ? '<span class="lb-warn" data-gloss="' + esc(c._unmapped + " line" + (c._unmapped === 1 ? " uses a stat index" : "s use stat indices") +
          " the model does not map yet, so " + (c._unmapped === 1 ? "it scores" : "they score") + " zero. The real bracelet is worth more than this row says.") + '">&#9888;</span>'
      : '';
    return '<tr data-i="' + i + '">' +
      starCell(c, i) +
      '<td class="lb-rank">#' + rankNum + '</td>' +
      '<td class="lb-ilvl">' + (c.itemLevel ? nf(c.itemLevel) : '<span class="lb-dash">&mdash;</span>') + '</td>' +
      '<td class="lb-char"><span class="lb-charwrap">' + classIconHtml(c["class"]) +
        '<a class="lb-name" href="' + bibleUrl(c.region, c.name) + '" target="_blank" rel="noopener"' +
        ' onclick="event.stopPropagation()" title="' + esc(c.name || "") + '">' + esc(c.name || "—") + '</a>' +
        '<span class="lb-region">' + esc(c.region || "") + '</span>' + loadoutMarker(c) + warn + '</span></td>' +
      '<td class="lb-gradecell">' + gradeCell(c) + '</td>' +
      '<td class="lb-dmg">' + dmgCell(c) + '</td>' +
      '<td class="lb-linescell">' + linesCell(c) + '</td>' +
      '<td class="lb-agecell"><span class="lb-age">' + esc(ageLabel(c.pulledAt) || "—") + '</span></td>' +
      '</tr>';
  }

  /**
   * Shared <colgroup>, so the pinned Favorites table and the main table line up
   * column for column whatever each one holds. Only Character flexes.
   */
  function colGroup() {
    return '<colgroup>' +
      (Favs ? '<col class="lc-star" style="width:30px">' : '') +
      '<col class="lc-rank" style="width:46px">' +
      '<col class="lc-ilvl" style="width:60px">' +
      '<col class="lc-char">' +
      '<col class="lc-grade" style="width:96px">' +
      '<col class="lc-dmg" style="width:74px">' +
      '<col class="lc-lines" style="width:126px">' +
      '<col class="lc-age" style="width:82px">' +
      '</colgroup>';
  }

  function headRow() {
    var sup = mode === "support";
    return '<thead><tr>' +
      (Favs ? '<th class="lb-star" aria-label="Favorite"></th>' : '') +
      '<th><span class="gloss" data-gloss="' + esc("Position on this board, by " + (sup ? "what one damage dealer gains" : "Damage %") +
        ". Every bracelet is scored on the same default " + (sup ? "support" : "character") + ", so a rank compares bracelets and nothing else.") + '">Rank</span></th>' +
      '<th><span class="gloss" data-gloss="Item level, as the character page reported it.">iLvl</span></th>' +
      '<th>Character</th>' +
      '<th><span class="gloss" data-gloss="' + esc("The whole bracelet on one 0–100 scale, and its subrank. " + gradeAnchorSentence("ancient") +
        (sup ? " Read on the support ladder, which is cut to the same rarities as the damage dealer's." : "")) + '">Grade</span></th>' +
      (sup
        ? '<th><span class="gloss" data-gloss="What ONE damage dealer standing next to this support gains from the bracelet — its buffs and debuffs, measured on the dealer they land on. Not the party total, and not the wearer&rsquo;s own damage. The board ranks on it.">Per-dealer %</span></th>'
        : '<th><span class="gloss" data-gloss="What the whole bracelet — both combat traits and every effect line — is worth in % damage on the canonical default character. The board ranks on it.">Damage %</span></th>') +
      '<th><span class="gloss" data-gloss="' + esc("One subrank per effect line: that line as a share of the strongest single roll its grade can carry, on the same ladder the Tier List uses. " +
        (sup ? "The letters are the support's, so an ally-buff line reads as what it is worth to the dealer it buffs." :
               "The letters are a damage dealer's, so an ally-buff line is worth nothing here and reads F-.") +
        " Hover a letter for the full effect, its roll and what it is worth. A dashed letter is locked.") + '">Effects</span></th>' +
      '<th class="lb-agecell"><span class="gloss" data-gloss="When this character&rsquo;s page was last read.">Last pulled</span></th>' +
      '</tr></thead>';
  }

  // ---- sections -------------------------------------------------------------

  function favSectionHtml() {
    if (!Favs) return '';
    if ((searchQuery || "").trim()) return '';        // hidden while searching
    var rows = '', n = 0, i;
    for (i = 0; i < allChars.length; i++) {
      var c = allChars[i];
      if (Favs.has(c.region, c.name)) { rows += charRow(c, c._idx, c._rank); n++; }
    }
    if (!n) return '';                                 // hidden when empty
    return '<div class="lb-favsec" id="lb-favsec">' +
      '<h3><span>&#9733;</span> Favorites <span class="ct">' + n + ' saved &middot; shown with their overall rank</span></h3>' +
      '<div class="lb-tw"><table>' + colGroup() + headRow() +
      '<tbody id="lb-fav-rows">' + rows + '</tbody></table></div>' +
      '</div>';
  }

  function pageCount() { return Math.max(1, Math.ceil(allChars.length / PAGE_SIZE)); }
  function clampPage() {
    var pc = pageCount();
    if (page < 1) page = 1;
    if (page > pc) page = pc;
  }

  function pagerHtml() {
    if (allChars.length <= PAGE_SIZE) return '';       // one page: no pager at all
    var pc = pageCount();
    var first = (page - 1) * PAGE_SIZE + 1;
    var last = Math.min(page * PAGE_SIZE, allChars.length);
    return '<div class="lb-pager">' +
      '<button type="button" class="lb-pagebtn" id="lb-prev"' + (page <= 1 ? ' disabled' : '') + '>&larr; Prev</button>' +
      '<button type="button" class="lb-pagebtn" id="lb-next"' + (page >= pc ? ' disabled' : '') + '>Next &rarr;</button>' +
      '<span class="lb-pageinfo">Page ' + page + ' of ' + pc + ' &middot; #' + first + '&ndash;#' + last + '</span>' +
      '<span>Jump to <input type="number" class="lb-jump" id="lb-jump" min="1" max="' + pc + '" value="' + page + '"></span>' +
      '</div>';
  }

  function mainTableHtml() {
    clampPage();
    var searching = !!(searchQuery || "").trim();
    if (!allChars.length) {
      return '<div class="lb-mainhdr">' +
        (searching ? 'No character matches that name.' : 'No characters match these filters.') + '</div>';
    }
    var start = (page - 1) * PAGE_SIZE;
    var slice = allChars.slice(start, start + PAGE_SIZE);
    var rows = slice.map(function (c) { return charRow(c, c._idx, c._rank); }).join("");
    var hdr = searching ? (allChars.length + ' match' + (allChars.length === 1 ? '' : 'es'))
      : (mode === "support" ? 'All supports' : 'All characters');
    return '<div class="lb-mainhdr">' + hdr + '</div>' +
      '<div class="lb-tw"><table>' + colGroup() + headRow() +
      '<tbody id="lb-rows">' + rows + '</tbody></table></div>' +
      pagerHtml() +
      '<div class="lb-hint">Click a row to load that bracelet into the Calculator' +
      (Favs ? '; tap the &#9733; to pin it above.' : '.') + '</div>';
  }

  // ------------------------------------------------------------------
  // click -> fetch the bracelet -> load it into the Calculator
  // ------------------------------------------------------------------

  /**
   * THE ROW HAS NO BRACELET, so the click fetches one. That is the trade the v3
   * summary makes: every reader used to download 67 raw brackets to draw a table
   * of letters, and now the one reader who clicks a row downloads one.
   *
   *   1. GET /character on the Worker — a KV read, ~2KB, no lostark.bible traffic
   *      for a character the board already lists (it is on the board because it
   *      is cached). `queue=1` so a record that HAS gone missing answers at once
   *      with "queued" instead of holding the request open on an upstream fetch.
   *   2. data/characters.json otherwise — the whole baked store, ~940KB, fetched
   *      once per page and only ever on this path. It is what makes a row click
   *      work with no Worker at all, which is the state the site can ship in.
   *
   * Both are memoised per character for the session: clicking the same row twice
   * costs one fetch.
   */
  // Only SUCCESS is cached, on both. A click is a thing a reader repeats, and a
  // remembered failure would make the second attempt fail without trying.
  var detailCache = {};     // "REGION|name" -> that character's brackets
  var bakedChars = null;    // the whole data/characters.json, once
  var bakedPromise = null;  // …and the fetch in flight, so two clicks share one

  function detailKey(region, name) {
    var r = normRegion(region);
    return (r === "EU" ? "CE" : r) + "|" + String(name || "").toLowerCase();
  }

  /** The Worker's /character answer, as the list of loadouts the click picks from. */
  function loadoutsFromWorker(j) {
    if (!j || !j.bracelet || !Array.isArray(j.bracelet.stats)) return null;
    var los = (j.loadouts || []).filter(function (l) {
      return l && l.bracelet && Array.isArray(l.bracelet.stats) && l.bracelet.stats.length;
    }).map(function (l) {
      // Rolls LEFT is what the Calculator counts; a record stores rolls USED, and
      // there is no honest way to turn one into the other. So this path fills
      // zero, exactly as the board did before it fetched anything at all.
      return { label: l.label || null, stats: l.bracelet.stats, rollsRemaining: null };
    });
    return { list: los, fallback: { stats: j.bracelet.stats, rollsRemaining: null } };
  }

  /** The same, from the baked whole-character store — which DOES know rolls left. */
  function loadoutsFromBaked(e) {
    if (!e || !Array.isArray(e.rawStats)) return null;
    var los = (e.loadouts || []).filter(function (l) {
      return l && Array.isArray(l.rawStats) && l.rawStats.length;
    }).map(function (l) {
      return { label: l.label || null, stats: l.rawStats,
        rollsRemaining: l.rollsRemaining || e.rollsRemaining || null };
    });
    return { list: los, fallback: { stats: e.rawStats, rollsRemaining: e.rollsRemaining || null } };
  }

  /**
   * WHICH BRACELET DID THE ROW RANK? The detail payload is fetched now and the row
   * was built minutes or hours ago, so the two are matched rather than assumed.
   *
   *   no loadout block   the row ranks the character's OWN bracelet — that is what
   *                      the Worker scored when the loadouts all wore one item, and
   *                      `bracelet` is that item. Not list[0], which is a tab.
   *   a loadout block    index `best`, but only if the label there still agrees;
   *                      otherwise the label is looked up, and otherwise the
   *                      character's own bracelet. A record re-pulled with its tabs
   *                      in a new order must not silently open a different item.
   */
  function pickLoadout(c, d) {
    if (!c.loadouts || !d.list.length) return d.fallback;
    var want = c.loadouts[c.best] || null;
    var byIndex = d.list[c.best] || null;
    if (byIndex && (!want || !want.label || !byIndex.label || want.label === byIndex.label)) return byIndex;
    for (var i = 0; i < d.list.length; i++) if (want && d.list[i].label === want.label) return d.list[i];
    return d.fallback;
  }

  function fetchBaked() {
    if (bakedChars) return Promise.resolve(bakedChars);
    if (bakedPromise) return bakedPromise;
    bakedPromise = fetchJson(CHARS_URL, false).then(function (r) {
      bakedChars = (r.ok && r.data && r.data.characters) ? r.data.characters : null;
      if (!bakedChars) bakedPromise = null;      // a failed fetch is not an answer
      return bakedChars;
    }).catch(function () { bakedPromise = null; return null; });
    return bakedPromise;
  }

  /** One character's brackets, from the Worker if it answers and the baked store
   *  if it does not. Resolves to null when neither can produce one. */
  function fetchDetail(c) {
    var k = detailKey(c.region, c.name);
    if (detailCache[k]) return Promise.resolve(detailCache[k]);
    var baked = function () {
      return fetchBaked().then(function (store) {
        var d = store ? loadoutsFromBaked(store[k]) : null;
        if (d) detailCache[k] = d;
        return d;
      });
    };
    if (!WORKER_URL) return baked();
    var u = WORKER_URL.replace(/\/+$/, "") + "/character?queue=1&region=" +
      encodeURIComponent(normRegion(c.region) === "EU" ? "CE" : (normRegion(c.region) || "NA")) +
      "&name=" + encodeURIComponent(c.name || "");
    return fetchJson(u, false).then(function (r) {
      var d = r.ok ? loadoutsFromWorker(r.data) : null;
      if (!d) return baked();
      detailCache[k] = d;
      return d;
    }).catch(baked);
  }

  /**
   * Hand the clicked bracelet to app.js's own import hook — the same one
   * bible-import.js uses, so a row click and an import land in identical state.
   */
  function openInCalculator(c, tr) {
    var app = window.BraceletApp, imp = window.BraceletImport;
    if (!app || !app.applyImport || !imp || !imp.buildPatch) {
      if (typeof window.selectTab === "function") window.selectTab("calculator");
      setStatus("The Calculator panel is not ready yet.", "err");
      return;
    }
    if (tr) tr.classList.add("loading");
    setStatus("Loading " + (c.name || "that bracelet") + "…", "");
    fetchDetail(c).then(function (d) {
      if (tr) tr.classList.remove("loading");
      if (!d) {
        setStatus("That bracelet could not be loaded — the character store is not reachable right now.", "err");
        return;
      }
      var lo = pickLoadout(c, d);
      if (!lo || !lo.stats || !lo.stats.length) { setStatus("That row carries no bracelet to load.", "err"); return; }
      var rolls = lo.rollsRemaining || { base: 0, ticket: 0 };
      var built;
      try {
        built = imp.buildPatch({
          stats: lo.stats,
          // The panel counts rolls LEFT; a payload's numRerolls are the counts
          // USED, so only a source that stores rolls-left can fill these.
          numRerolls: rolls.base || 0,
          numTicketRerolls: rolls.ticket || 0
        });
      } catch (e) { setStatus("That bracelet could not be decoded.", "err"); return; }
      built.patch.character = {
        name: c.name, region: c.region, "class": c["class"] || null,
        itemLevel: c.itemLevel == null ? null : c.itemLevel,
        source: "leaderboard", cached: null, pulledAt: c.pulledAt || null
      };
      setStatus("", "");
      app.applyImport(built.patch);
      if (typeof window.selectTab === "function") window.selectTab("calculator");
    });
  }

  function wireTbody(tbody) {
    if (!tbody) return;
    tbody.addEventListener("click", function (e) {
      var starBtn = e.target.closest ? e.target.closest(".lb-starbtn") : null;
      if (starBtn) {
        e.stopPropagation();
        var si = parseInt(starBtn.getAttribute("data-star"), 10);
        var sc = allChars[si];
        if (sc && Favs) Favs.toggle(sc.region, sc.name);   // notify -> repaint()
        return;
      }
      var tr = e.target.closest ? e.target.closest("tr[data-i]") : null;
      if (!tr) return;
      var ch = allChars[parseInt(tr.getAttribute("data-i"), 10)];
      if (ch) openInCalculator(ch, tr);
    });
  }

  // ------------------------------------------------------------------
  // rank, filter, paint
  // ------------------------------------------------------------------

  /**
   * Highest Damage % first, on the active board's axis. A row we could not
   * score at all has no figure and sorts last.
   */
  function byPctDesc(a, b) {
    var av = a._pct == null ? -Infinity : a._pct;
    var bv = b._pct == null ? -Infinity : b._pct;
    return bv - av;
  }

  /** The classes that carry a support reading — the Worker's SUPPORT_CLASSES,
   *  learnt from the data rather than copied. */
  function supportClassNames() {
    var set = {}, i;
    for (i = 0; i < rawChars.length; i++) {
      if (isSupportClass(rawChars[i]) && rawChars[i]["class"]) set[rawChars[i]["class"]] = true;
    }
    return set;
  }

  /**
   * The class filter this board honours. A Berserker picked on the DPS board is
   * remembered but means nothing on the Support board, which shows every
   * support rather than an empty table; switch back and it applies again.
   */
  function effectiveClassFilter() {
    if (!classFilter) return "";
    return (mode === "support" && !supportClassNames()[classFilter]) ? "" : classFilter;
  }

  /**
   * Build the display list from rawChars for the active board and paint.
   *
   *   DPS:      everyone with a damage-dealer reading, minus support mains.
   *   Support:  the four support classes, every one of them, on the support reading.
   *
   * Ranking happens BEFORE the name search filters anything, so a searched
   * character keeps its true overall rank.
   */
  function rebuild() {
    rawChars.forEach(applyMode);
    var base = rawChars.filter(function (c) {
      if (!regions[c.region] || !readingFor(c)) return false;
      return mode === "support" ? isSupportClass(c) : !isSupportMain(c);
    });
    var cf = effectiveClassFilter();
    if (cf) base = base.filter(function (c) { return c["class"] === cf; });
    base.sort(byPctDesc);
    for (var i = 0; i < base.length; i++) base[i]._rank = i + 1;
    var q = (searchQuery || "").trim().toLowerCase();
    var list = q
      ? base.filter(function (c) { return (c.name || "").toLowerCase().indexOf(q) !== -1; })
      : base;
    for (var j = 0; j < list.length; j++) list[j]._idx = j;
    allChars = list;
    clampPage();
    repaint();
  }

  function repaint() {
    var body = $("lb-body");
    if (!body) return;
    body.innerHTML = favSectionHtml() + mainTableHtml();
    wireTbody($("lb-fav-rows"));
    wireTbody($("lb-rows"));
    var prev = $("lb-prev"), next = $("lb-next"), jump = $("lb-jump");
    if (prev) prev.onclick = function () { page -= 1; clampPage(); repaint(); };
    if (next) next.onclick = function () { page += 1; clampPage(); repaint(); };
    if (jump) {
      var go = function () {
        var v = parseInt(jump.value, 10);
        if (!isNaN(v)) { page = v; clampPage(); repaint(); } else { jump.value = page; }
      };
      jump.onchange = go;
      jump.onkeydown = function (e) { if (e.key === "Enter") go(); };
    }
    paintFoot();
  }

  function populateClassOptions() {
    var sel = $("lb-class");
    if (!sel) return;
    var set = {}, i;
    if (mode === "support") {
      set = supportClassNames();                   // the Support board lists only the four
    } else {
      for (i = 0; i < rawChars.length; i++) if (rawChars[i]["class"]) set[rawChars[i]["class"]] = true;
      if (classFilter) set[classFilter] = true;    // keep a saved choice selectable
    }
    var classes = Object.keys(set).sort();
    var html = '<option value="">All classes</option>';
    for (i = 0; i < classes.length; i++) html += '<option value="' + esc(classes[i]) + '">' + esc(classes[i]) + '</option>';
    sel.innerHTML = html;
    sel.value = effectiveClassFilter();
  }

  function renderTable(chars) {
    rawChars = chars;
    populateClassOptions();
    page = 1;
    rebuild();
  }

  // ------------------------------------------------------------------
  // load
  // ------------------------------------------------------------------

  function fetchJson(url, fresh) {
    var opts = fresh ? { cache: "no-store" } : {};
    return fetch(url, opts).then(function (resp) {
      return resp.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) {}
        return { ok: resp.ok, status: resp.status, data: data };
      });
    });
  }

  /** The seed file — the baked v3 summary, which is the board's source whenever
   *  the Worker cannot answer with one. */
  function loadSeed(fresh, prefix) {
    return fetchJson(SEED_URL, fresh).then(function (r) {
      if (r.status === 404 || (r.ok && !r.data)) {
        setStatus(r.status === 404 ? "The board data file is missing." : "The board data would not parse.", "err");
        if (!rawChars.length) renderMessage(MSG.missing);
        return;
      }
      if (!r.ok) {
        setStatus("The board data answered " + r.status + ".", "err");
        if (!rawChars.length) renderMessage(MSG.http);
        return;
      }
      var chars = readable(r.data) ? fromSnapshot(r.data) : [];
      if (!chars.length) {
        setStatus("The board data carries no characters.", "");
        if (!rawChars.length) renderMessage(MSG.empty);
        return;
      }
      var stamp = toTime(r.data && r.data._scoredAt);
      sourceNote = (prefix || "") + "Baked board data, collected " +
        (stamp ? ageLabel(stamp) : "on 2026-08-11") + "; it updates when the site is rebuilt.";
      setStatus(chars.length + " character" + (chars.length === 1 ? "" : "s") + " on the board.", "");
      renderTable(chars);
    }).catch(function () {
      setStatus("The board data could not be reached.", "err");
      if (!rawChars.length) renderMessage(MSG.network);
    });
  }

  /**
   * IS THIS PAYLOAD ONE WE CAN READ? v3 and only v3.
   *
   * Every number on the board now comes out of the payload, so a shape this file
   * does not know is not a payload to render as best it can — it is percentages
   * read out of stat indices. v2's row put a packed stat array where v3 puts the
   * two combat traits, and a v2 row decoded as v3 would draw a bracelet worth
   * 15% as one worth 2, with no error anywhere.
   *
   * ONE RELEASE OF TOLERANCE, and it is deliberately the dull kind: a v2 payload
   * is refused, not adapted, and the board falls through to the baked v3 summary
   * with the footer saying so. That is a real board, correctly scored, a few days
   * older — which is what the same fallback already does when the Worker has no
   * snapshot yet. Adapting v2 would mean keeping the whole decode-and-re-score
   * path alive to serve a window that only opens if the site is deployed before
   * the Worker, and the deploy order is Worker first for exactly this reason.
   */
  function readable(data) {
    return !!(data && data.v === 3 && Array.isArray(data.characters));
  }

  /**
   * The Worker first when one is configured, the seed otherwise — and the seed
   * again, quietly, whenever the Worker cannot answer with rows it can read. A
   * 429 is NOT an error: the board throttles refreshes on purpose, so keep
   * whatever is on screen and say so in a neutral voice.
   */
  function load(fresh) {
    if (busy) return;
    busy = true;
    var btn = $("lb-refresh");
    if (btn) btn.disabled = true;
    var done = function () {
      busy = false;
      var b = $("lb-refresh");
      if (b) b.disabled = false;
      loadedOnce = true;
    };
    setStatus(rawChars.length ? "Refreshing…" : "Loading the board…", "");

    if (!WORKER_URL) { loadSeed(fresh, "").then(done, done); return; }

    fetchJson(WORKER_URL.replace(/\/+$/, "") + "/?list=1", fresh).then(function (r) {
      if (r.data && r.data.rateLimited) {
        // Throttled, not broken. Keep the table that is already there.
        setStatus((r.data && r.data.message) || "The board refreshes every few minutes — try again shortly.", "");
        if (!rawChars.length) return loadSeed(fresh, "");
        return null;
      }
      var stale = r.ok && r.data && !readable(r.data) && typeof r.data.v === "number" && r.data.v < 3;
      var chars = (r.ok && readable(r.data)) ? fromSnapshot(r.data) : [];
      if (chars.length) {
        sourceNote = "Live board data from our Worker.";
        setStatus(chars.length + " character" + (chars.length === 1 ? "" : "s") + " on the board.", "");
        renderTable(chars);
        return null;
      }
      // Either the Worker is up but has no snapshot yet (it answers with an empty
      // list until one is built), or it is still serving the older format and has
      // not been redeployed. Neither is a failure the reader needs shouting at
      // them, and both land on the same honest baked copy.
      return loadSeed(fresh, stale
        ? "The Worker is still serving the previous board format, so this is the baked copy. "
        : "The Worker has no snapshot yet, so this is the baked copy. ");
    }).catch(function () {
      return loadSeed(fresh, "The Worker could not be reached, so this is the baked copy. ");
    }).then(done, done);
  }

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------

  function init() {
    var el = $("tab-leaderboard");
    if (!el || el.getAttribute("data-init")) return;
    el.setAttribute("data-init", "1");
    el.innerHTML = shell();
    el.classList.add("axis-dps");                   // the DPS board, and its colour, by default
    paintFoot();

    if (!B) {
      renderMessage({ title: "The model is not loaded",
        body: "model/bracelet.js did not load, so nothing can be scored. Reload the page." });
      return;
    }

    // Name search. Debounced because rebuild() re-ranks and re-renders the whole
    // list; it searches the FULL list and keeps each match's true overall rank.
    var searchEl = $("lb-search"), searchTimer = null;
    if (searchEl) searchEl.addEventListener("input", function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchQuery = searchEl.value || "";
        page = 1;
        if (rawChars.length) rebuild();
      }, SEARCH_DEBOUNCE);
    });

    // DPS / Support toggle: re-filter, re-rank, page 1. The class list and the
    // pinned Favorites follow the board, since both read from the rebuilt list.
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      var dpsBtn = $("lb-mode-dps"), supBtn = $("lb-mode-support");
      if (dpsBtn) { dpsBtn.classList.toggle("on", m === "dps"); dpsBtn.setAttribute("aria-pressed", m === "dps" ? "true" : "false"); }
      if (supBtn) { supBtn.classList.toggle("on", m === "support"); supBtn.setAttribute("aria-pressed", m === "support" ? "true" : "false"); }
      el.classList.toggle("axis-dps", m !== "support");
      el.classList.toggle("axis-support", m === "support");
      page = 1;
      if (rawChars.length) { populateClassOptions(); rebuild(); }
    }
    var dpsBtn = $("lb-mode-dps"), supBtn = $("lb-mode-support");
    if (dpsBtn) dpsBtn.onclick = function () { setMode("dps"); };
    if (supBtn) supBtn.onclick = function () { setMode("support"); };

    // Region chips: independent toggles, persisted, all-on when the store is empty.
    REGIONS.forEach(function (rg) {
      var btn = $("lb-reg-" + rg);
      if (!btn) return;
      btn.onclick = function () {
        regions[rg] = !regions[rg];
        btn.classList.toggle("on", regions[rg]);
        btn.setAttribute("aria-pressed", regions[rg] ? "true" : "false");
        writeRegions(regions);
        page = 1;
        if (rawChars.length) rebuild();
      };
    });

    var classSel = $("lb-class");
    if (classSel) classSel.onchange = function () {
      classFilter = classSel.value || "";
      lsSet(LB_CLASS_KEY, classFilter);
      page = 1;
      if (rawChars.length) rebuild();
    };

    var refresh = $("lb-refresh");
    if (refresh) refresh.onclick = function () { load(true); };

    // A star toggled anywhere — this tab or the Calculator's profile header —
    // repaints the pinned section.
    if (Favs) Favs.onChange(function () { if (allChars.length) repaint(); });

    document.addEventListener("tabselected", function (e) {
      if (e && e.detail && e.detail.tab === "leaderboard" && !loadedOnce) load(false);
    });
    if (el.classList.contains("active")) load(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
