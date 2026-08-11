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
 *   2. data/leaderboard-seed.json — the 30 characters read off public character
 *      pages on 2026-08-11 — otherwise.
 * The Worker is not deployed yet, so (2) is the live path. The fallback is silent:
 * a line in the footer says which source the table came from, and only a real
 * failure (no file, HTTP error, network error) speaks up as an error.
 *
 * WHAT IT RANKS
 *   Everyone is scored on the CANONICAL DEFAULT profile, Bracelet.normalizeProfile({}),
 *   never on the user's own settings. Otherwise the board would rank gear, not
 *   bracelets, and your rank would move when you dragged a slider.
 *   The score is RECOMPUTED here from each row's raw stats rather than read out of
 *   the file, so a change to model/bracelet.js shows up on the board the moment it
 *   ships — the file's stored numbers are only a fallback for a row with no raw
 *   stats. This is the same reason the Worker stores raw payloads and ranks nothing.
 *
 * MULTI-LOADOUT
 *   A lostark.bible character page carries one loadout per tab (Raid / Chaos /
 *   Est. Raid) and each has its OWN bracelet — 9 of the 30 seeded characters wear
 *   different ones. Every loadout is scored; the board ranks the highest, and a
 *   marker beside the name names the alternatives.
 *
 * THE COLUMNS
 *   ★ · Rank · iLvl · Character · Grade · Damage % · Effects · Last pulled.
 *   GRADE is the whole bracelet on the shared 0–100 subrank scale (subrank.js):
 *   0 is an empty bracelet — two 40 traits and three lines worth nothing — and
 *   100 is the three best distinct families at their best roll with both traits
 *   capped. EFFECTS is three subrank letters, one per line, each scored as that
 *   line's share of the strongest single roll on its grade: the same yardstick
 *   the Tier List's by-roll view bands on. Hover any of them for the full text.
 *   Bracelet grade (Relic/Ancient), rolls left and gap-to-#1 used to have their
 *   own columns; they said less than the space they cost.
 *
 * NETWORK: this file talks to our own origin (the seed file) and, when configured,
 * to our own Worker. It never touches lostark.bible — only the Worker may, and only
 * with the token.
 *
 * Model API used (window.Bracelet, never modified): normalizeProfile,
 * decodeBibleBracelet, traitDamage, setDamage, damagePercent, lineDamage,
 * lineInfo, DATA. Plus window.Subrank for the ladder and the 0–100 grade.
 */
(function () {
  "use strict";

  // Kept in sync BY HAND with bible-import.js's own WORKER_URL. Empty = no Worker;
  // the board then reads the baked seed, which is the state this ships in.
  var WORKER_URL = "https://bracelet-bible.shizukaziye.workers.dev";

  // The baked board. ?v= for the same reason every other file carries one: the
  // loseii zone edge-caches for four hours, so a re-baked seed needs a new URL.
  var SEED_URL = "data/leaderboard-seed.json?v=2";

  var PAGE_SIZE = 100;      // rows per page; the pager hides itself below one page
  var SEARCH_DEBOUNCE = 200;

  var B = (typeof window !== "undefined" && window.Bracelet) || null;
  var Favs = (typeof window !== "undefined" && window.Favorites) || null;
  var SR = (typeof window !== "undefined" && window.Subrank) || null;

  // The one profile this tab ever scores on. Computed once: it is a constant.
  var DEFAULT_PROFILE = B ? B.normalizeProfile({}) : null;

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------

  var rawChars = [];      // every row as loaded, scored, unfiltered
  var allChars = [];      // the current DISPLAY list, tagged _rank/_idx
  var searchQuery = "";
  var classFilter = "";
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
  // scoring — the canonical default profile, recomputed from raw stats
  // ------------------------------------------------------------------

  // A FIXED combat-trait line is one of the two the bracelet came with and scores
  // through traitDamage(); everything else — granted lines AND fixed effect lines —
  // scores through setDamage(). A trait rolled into a GRANTED slot scores zero,
  // which is the model's rule. Same split as worker/bracelet.js's score().
  var TRAIT_TO_APP = { crit: "crit", spec: "spec", swiftness: "swift" };
  var TRAIT_CAP = { relic: 100, ancient: 120 };

  function slotChoices(grade) { return grade === "relic" ? [1, 2] : [1, 2, 3]; }
  function traitsBreakCap(dec, grade) {
    for (var i = 0; i < dec.lines.length; i++) {
      if (dec.lines[i].cat === "trait" && dec.lines[i].value > TRAIT_CAP[grade]) return true;
    }
    return false;
  }
  function unplaced(dec) {
    var n = 0;
    for (var i = 0; i < dec.lines.length; i++) {
      var l = dec.lines[i];
      if (l.cat === "special" && (!l.tier || l.unmatchedValue)) n++;
    }
    return n;
  }

  /**
   * The grade the payload does not carry, inferred and then checked twice: a trait
   * above the grade's cap rules that grade out (a hard fact about the item), and
   * the granted-slot count is only a hint (a player can lock granted lines). Copied
   * from bible-import.js so the two paths can never disagree about a bracelet.
   */
  function decodeWithGradeCheck(stats) {
    var dec = B.decodeBibleBracelet(stats), i, granted = 0;
    if (traitsBreakCap(dec, dec.grade)) {
      var forced = dec.grade === "relic" ? "ancient" : "relic";
      var fdec = B.decodeBibleBracelet(stats, { grade: forced });
      if (!traitsBreakCap(fdec, forced)) return fdec;
    }
    for (i = 0; i < dec.lines.length; i++) if (!dec.lines[i].fixed) granted++;
    if (slotChoices(dec.grade).indexOf(granted) >= 0) return dec;
    var other = dec.grade === "relic" ? "ancient" : "relic";
    if (slotChoices(other).indexOf(granted) < 0) return dec;
    var alt = B.decodeBibleBracelet(stats, { grade: other });
    if (traitsBreakCap(alt, other)) return dec;
    if (unplaced(alt) > unplaced(dec)) return dec;
    return alt;
  }

  /**
   * score(rawStats) -> { grade, pct, linesPct, lines, traits, traitVals, unmapped, grade0to100 }
   * `pct` is the whole bracelet, `linesPct` the effect lines alone (the figure
   * comparable to lostark.bible's own "Bracelet Effects +X%").
   *
   * `grade0to100` is Subrank.braceletScore() on the SAME two terms — the effect
   * lines through setDamage() and the two fixed combat traits through
   * traitDamage(). setDamage() returns zero for a trait line by design, so the
   * trait term has to be added separately or every bracelet reads as junk.
   */
  function score(stats) {
    if (!B || !stats || !stats.length) return null;
    var dec = decodeWithGradeCheck(stats);
    var traits = { crit: 0, spec: 0, swift: 0 }, traitLines = [], lines = [], i, l, k;
    for (i = 0; i < dec.lines.length; i++) {
      l = dec.lines[i];
      k = TRAIT_TO_APP[l.family];
      if (l.fixed && l.cat === "trait" && k) {
        traits[k] = l.value;
        traitLines.push({ trait: l.family, value: l.value });
        continue;
      }
      lines.push(l);
    }
    var traitD = B.traitDamage(traits, DEFAULT_PROFILE);
    var linesD = B.setDamage(lines, dec.grade, DEFAULT_PROFILE);
    return {
      grade: dec.grade,
      traits: traitLines,
      traitVals: traits,
      lines: lines,
      pct: B.damagePercent(traitD + linesD),
      linesPct: B.damagePercent(linesD),
      unmapped: (dec.unknown || []).length,
      // No Subrank on the page (a stale index.html, a failed script) is not a
      // reason to lose the board: the column simply goes blank.
      grade0to100: SR ? SR.braceletScore({ lines: lines, traits: traits, grade: dec.grade }) : null
    };
  }

  /**
   * One effect line's subrank: its damage on the canonical default character as
   * a share of the STRONGEST SINGLE ROLL on that grade — the Tier List's by-roll
   * yardstick, so an S+ pill here and an S+ row there mean the same thing.
   * A line worth nothing is pinned to the bottom band whatever the arithmetic.
   */
  function lineSubrank(line, grade) {
    if (!SR) return null;
    var d = 0;
    try { d = B.lineDamage(line, grade, DEFAULT_PROFILE) || 0; } catch (e) { d = 0; }
    var best = SR.bestRoll(grade);
    var pct = (best > 0 && d > 0) ? 100 * d / best : 0;
    return { d: d, pct: pct, band: d > 0 ? SR.of(pct) : SR.BOTTOM };
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
  function linePill(line, grade) {
    var sr = lineSubrank(line, grade);
    var what, worth, tier = line.tier || "";
    if (line.cat === "basic") {
      what = (line.family === "mainStat" ? "Str / Dex / Int" : "Vitality") + " +" + nf(line.value);
      worth = line.family === "mainStat"
        ? "A flat main-stat line — real damage, but a fraction of what an effect line is worth."
        : "Vitality is dead weight on a damage dealer: the model scores it zero.";
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
      fx(B.damagePercent(sr ? sr.d : 0), 2) + "% damage on the default character, " +
      (pct > 0 ? fx(pct, 1) + "% of the strongest single roll an " +
        (grade === "relic" ? "Relic" : "Ancient") + " can carry." : "which is nothing at all.") +
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
   * One loaded row, whatever it came from:
   *   { name, region, class, itemLevel, pulledAt, loadouts:[{label, rawStats,
   *     rollsRemaining, storedPct}], chosenLoadout, storedPct }
   * Scoring happens afterwards, in scoreChars(), so both sources take one path.
   */
  function fromSeed(data) {
    var entries = (data && data.entries) || [];
    var stamp = toTime(data && data._scoredAt);
    return entries.map(function (e) {
      var loadouts = (e.loadouts && e.loadouts.length ? e.loadouts : [e]).map(function (l, i) {
        return {
          label: l.label || ("Loadout " + (i + 1)),
          rawStats: l.rawStats || e.rawStats || [],
          rollsRemaining: l.rollsRemaining || e.rollsRemaining || null,
          itemLevel: l.itemLevel != null ? Math.round(l.itemLevel) : e.itemLevel,
          storedPct: typeof l.damagePct === "number" ? l.damagePct : null
        };
      });
      return {
        name: e.name,
        region: normRegion(e.region),
        "class": e["class"] || null,
        itemLevel: e.itemLevel != null ? Math.round(e.itemLevel) : null,
        pulledAt: toTime(e.scoredAt) || stamp,
        loadouts: loadouts,
        chosenLoadout: e.chosenLoadout || 0,
        storedPct: typeof e.damagePct === "number" ? e.damagePct : null,
        biblePct: typeof e.biblePct === "number" ? e.biblePct : null
      };
    });
  }

  /**
   * The Worker's snapshot. Two shapes are accepted so a snapshot format still being
   * written cannot break this tab: the seed's own {entries:[…]} envelope, or the
   * packed {classes:[…], characters:[[region,name,itemLevel,classIdx,pulledAt,
   * grade,statsPacked]]} of ARCHITECTURE §1.2. Anything else reads as empty.
   */
  function fromWorker(data) {
    if (!data) return [];
    if (data.entries) return fromSeed(data);
    var chars = data.characters || [];
    if (!chars.length) return [];
    if (!Array.isArray(chars[0])) {
      // Already object-shaped: trust the field names, invent nothing.
      return chars.map(function (c) {
        var los = (c.loadouts && c.loadouts.length ? c.loadouts : [c]).map(function (l, i) {
          return {
            label: l.label || ("Loadout " + (i + 1)),
            rawStats: l.stats || l.rawStats || [],
            rollsRemaining: l.rollsRemaining || null,
            itemLevel: l.itemLevel != null ? Math.round(l.itemLevel) : null,
            storedPct: null
          };
        });
        return {
          name: c.name, region: normRegion(c.region), "class": c["class"] || null,
          itemLevel: c.itemLevel != null ? Math.round(c.itemLevel) : null,
          pulledAt: toTime(c.pulledAt), loadouts: los,
          chosenLoadout: c.chosenLoadout || 0, storedPct: null, biblePct: null
        };
      });
    }
    var classes = data.classes || [];
    return chars.map(function (a) {
      var packed = a[6] || [], stats = [], i;
      for (i = 0; i + 3 < packed.length; i += 4) {
        stats.push({ type: packed[i], index: packed[i + 1], value: packed[i + 2], fixed: !!packed[i + 3] });
      }
      return {
        name: a[1], region: normRegion(a[0]),
        itemLevel: a[2] != null ? Math.round(a[2]) : null,
        "class": (a[3] != null && a[3] >= 0) ? (classes[a[3]] || null) : null,
        pulledAt: toTime(a[4]),
        loadouts: [{ label: "Bracelet", rawStats: stats, rollsRemaining: null, itemLevel: a[2], storedPct: null }],
        chosenLoadout: 0, storedPct: null, biblePct: null
      };
    });
  }

  /**
   * Score every loadout, then pick the one the board ranks: the highest RECOMPUTED
   * score. The file's own chosenLoadout only breaks a tie — recomputing is the
   * point, so a model change may legitimately promote a different loadout.
   */
  function scoreChars(chars) {
    chars.forEach(function (c) {
      var best = -Infinity, bestI = -1, i, s, seen = {}, distinct = 0;
      for (i = 0; i < c.loadouts.length; i++) {
        var lo = c.loadouts[i];
        s = null;
        try { s = score(lo.rawStats); } catch (e) { s = null; }
        lo.score = s;
        lo.pct = s ? s.pct : (lo.storedPct != null ? lo.storedPct : null);
        // A row whose numbers do not come out finite is a row we cannot rank. Say
        // nothing rather than print "Infinity%": a broken payload must not look
        // like the best bracelet in the game.
        if (typeof lo.pct !== "number" || !isFinite(lo.pct)) lo.pct = null;
        var sig = JSON.stringify((lo.rawStats || []).map(function (st) {
          return [st.type, st.index, st.value, st.fixed ? 1 : 0];
        }));
        if (!seen[sig]) { seen[sig] = 1; distinct++; }
        if (lo.pct != null && (lo.pct > best + 1e-9 ||
            (Math.abs(lo.pct - best) < 1e-9 && i === c.chosenLoadout))) {
          best = lo.pct; bestI = i;
        }
      }
      c.distinctBrackets = distinct;
      c.best = bestI >= 0 ? bestI : (c.chosenLoadout || 0);
      var b = c.loadouts[c.best] || null;
      c._s = b ? b.score : null;
      c._pct = b ? b.pct : (c.storedPct != null ? c.storedPct : null);
      c._grade = c._s ? c._s.grade : null;
      if (b && b.itemLevel != null && c.itemLevel == null) c.itemLevel = Math.round(b.itemLevel);
    });
    return chars;
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
'  #tab-leaderboard td.lb-char{white-space:nowrap}' +
'  #tab-leaderboard .lb-charwrap{display:flex;align-items:center;min-width:0}' +
'  #tab-leaderboard .lb-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
     'font-weight:700;color:var(--text);text-decoration:none;border-bottom:1px dotted transparent}' +
'  #tab-leaderboard .lb-name:hover{color:var(--accent);border-bottom-color:var(--accent)}' +
'  #tab-leaderboard .lb-region{color:var(--dim);font-weight:600;font-size:11px;margin-left:6px;flex:0 0 auto}' +
'  #tab-leaderboard .lb-rank{font-variant-numeric:tabular-nums;color:var(--dim);font-weight:700}' +
'  #tab-leaderboard .lb-ilvl{color:var(--text);font-weight:700;font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-dmg{color:var(--accent);font-weight:800;font-variant-numeric:tabular-nums}' +
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
'  #tab-leaderboard .lb-mainhdr{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:0 0 8px;font-weight:700}' +
// controls
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
'  #tab-leaderboard .lb-search:focus,#tab-leaderboard .lb-classsel:focus{border-color:var(--accent)}' +
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
'    #tab-leaderboard .lb-dmgmini{display:block;color:var(--accent);font-weight:700;font-size:10.5px;' +
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
'  <p><b>The arithmetic.</b> The two combat traits the bracelet came with score through the trait model; ' +
     'every effect line, granted or locked, scores through the line model; the two add in log space and convert once to a percentage. ' +
     'It is the same code the Calculator runs, called with different settings. The score is recomputed in your browser from each ' +
     'character&rsquo;s raw stat lines every time this tab loads, so a change to the model shows up here immediately &mdash; the ' +
     'numbers stored in the data file are only a fallback.</p>' +
'  <p><b>Why your rank is not your Calculator number.</b> The Calculator scores your bracelet on <i>your</i> character: your crit, ' +
     'your gear, your fight. This board deliberately does not. If it used each player&rsquo;s own settings it would be ranking gear ' +
     'and fight profiles, not bracelets, and nobody&rsquo;s rank would mean anything.</p>' +
'  <p><b>The 0&ndash;100 grade.</b> The Damage % column answers &ldquo;how much&rdquo;; the Grade column answers ' +
     '&ldquo;how close to the ceiling&rdquo;. It is a straight line between two fixed points: <b>0</b> is an empty bracelet &mdash; ' +
     'two combat traits at 40 and three effect lines worth nothing &mdash; and <b>100</b> is the three best distinct effect ' +
     'families at their best roll with both traits at the grade&rsquo;s cap. On an Ancient that ceiling is ' +
     '<b>22.87% damage</b> and that floor is <b>2.00%</b>. Each effect line gets its own letter on the same ladder, ' +
     'scored against the strongest single roll its grade can carry &mdash; the Tier List&rsquo;s by-roll yardstick, so a letter ' +
     'means one thing across both tabs.</p>' +
'  <p><b>Loadouts.</b> A lostark.bible character page carries one loadout per tab &mdash; Raid, Chaos Dungeon, sometimes an ' +
     'estimated raid one &mdash; and each has its own bracelet. Every loadout is scored and the board ranks the highest. ' +
'     The <span class="lb-lo">2</span> marker beside a name means that character wears more than one distinct bracelet; hover it for the others.</p>' +
'  <p><b>What is left out.</b> Support scoring is not built, so support characters are ranked on their damage like everyone else. ' +
     'A line whose stat index the model does not map yet scores zero and is flagged rather than hidden. The default profile leaves ' +
     'the Demon/Archdemon share at zero, which costs the one family that depends on it &mdash; the Method tab has the working.</p>' +
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

  function footHtml() {
    return '<p>' + (sourceNote ? esc(sourceNote) + " " : "") +
      'Every bracelet here is scored on the <b>canonical default character</b> ' +
      '(<span class="gloss" data-gloss="Bracelet.normalizeProfile({}) — the calculator with every setting left at its default. ' +
      'Your own settings never touch this board.">the calculator&rsquo;s untouched defaults</span>), not on your settings.</p>' +
      '<p>The data is <b>self-reported</b>: it is collected from public lostark.bible character pages and shows whatever the ' +
      'owner&rsquo;s roster last synced there, which can be weeks behind what they are wearing today. It is not a verified snapshot ' +
      'and it is not a complete list of anything.</p>' +
      '<p>Not affiliated with Smilegate, Amazon Games or lostark.bible.</p>';
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
    return '<span class="lb-lo" data-gloss="' + esc(c.distinctBrackets + " different bracelets across this character's " +
      c.loadouts.length + " lostark.bible loadouts. The board ranks the highest. " + parts.join(" · ")) +
      '">' + c.distinctBrackets + '</span>';
  }

  /**
   * The whole bracelet as one big subrank badge plus its 0–100 number — the
   * headline verdict, in the shape astrogem uses for a rank. The damage figure
   * rides along in a second line that only phones show, where the Damage %
   * column has been collapsed to make room for the name.
   */
  function gradeCell(c) {
    var g = c._s && c._s.grade0to100;
    if (!g) return '<span class="lb-dash">&mdash;</span>';
    var b = g.band;
    var gloss = "Bracelet grade " + fx(g.score, 1) + " out of 100, subrank " + b.key + ". " +
      "0 is an empty " + (c._grade === "relic" ? "Relic" : "Ancient") +
      " — two 40 combat traits and three lines worth nothing; 100 is the three best distinct " +
      "effect families at their best roll with both traits at the cap. This bracelet is worth " +
      fx(c._pct == null ? 0 : c._pct, 2) + "% damage on the default character, against " +
      fx(B.damagePercent(g.perfect), 2) + "% for that perfect one.";
    // A flat 100 — and only a flat 100 — wears the animated rainbow. astrogem
    // gates it on the config being perfect rather than on the band, for the same
    // reason: an S+ is not a ceiling, and the rainbow has to mean the ceiling.
    var col = SR.colorOf(b.key, g.isPerfect);
    return '<span class="lb-badge' + (b.top ? " top" : "") + (col.cls ? " " + col.cls : "") +
      '" style="background:' + col.bg + ';color:' + col.fg +
      '" data-gloss="' + esc(gloss) + '">' + esc(b.key) + '</span>' +
      '<span class="lb-score">' + fx(g.score, 1) + '</span>' +
      '<span class="lb-dmgmini">' + (c._pct == null ? "&mdash;" : fx(c._pct, 2) + "%") + '</span>';
  }

  function linesCell(c) {
    if (!c._s || !c._s.lines.length) return '<span class="lb-dash">&mdash;</span>';
    var h = '<div class="lb-lines">', i;
    for (i = 0; i < c._s.lines.length; i++) h += linePill(c._s.lines[i], c._s.grade);
    return h + '</div>';
  }

  /**
   * One row. `i` indexes allChars for the delegated handlers; `rankNum` is the
   * OVERALL rank, so a favourite that is #3 still reads #3 in the pinned section.
   */
  function charRow(c, i, rankNum) {
    var warn = (c._s && c._s.unmapped)
      ? '<span class="lb-warn" data-gloss="' + esc(c._s.unmapped + " line" + (c._s.unmapped === 1 ? " uses a stat index" : "s use stat indices") +
          " the model does not map yet, so " + (c._s.unmapped === 1 ? "it scores" : "they score") + " zero. The real bracelet is worth more than this row says.") + '">&#9888;</span>'
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
      '<td class="lb-dmg">' + (c._pct == null ? '<span class="lb-dash">&mdash;</span>' : fx(c._pct, 2) + "%") + '</td>' +
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
    return '<thead><tr>' +
      (Favs ? '<th class="lb-star" aria-label="Favorite"></th>' : '') +
      '<th>Rank</th>' +
      '<th><span class="gloss" data-gloss="Item level, as the character page reported it.">iLvl</span></th>' +
      '<th>Character</th>' +
      '<th><span class="gloss" data-gloss="The whole bracelet on one 0–100 scale, and its subrank. 0 is an empty bracelet: two 40 combat traits and three lines worth nothing. 100 is the three best distinct effect families at their best roll with both traits at the cap.">Grade</span></th>' +
      '<th><span class="gloss" data-gloss="What the whole bracelet — both combat traits and every effect line — is worth in % damage on the canonical default character.">Damage %</span></th>' +
      '<th><span class="gloss" data-gloss="One subrank per effect line: that line as a share of the strongest single roll its grade can carry, on the same ladder the Tier List uses. Hover a letter for the full effect, its roll and what it is worth. A dashed letter is locked.">Effects</span></th>' +
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
    var hdr = searching ? (allChars.length + ' match' + (allChars.length === 1 ? '' : 'es')) : 'All characters';
    return '<div class="lb-mainhdr">' + hdr + '</div>' +
      '<div class="lb-tw"><table>' + colGroup() + headRow() +
      '<tbody id="lb-rows">' + rows + '</tbody></table></div>' +
      pagerHtml() +
      '<div class="lb-hint">Click a row to load that bracelet into the Calculator' +
      (Favs ? '; tap the &#9733; to pin it above.' : '.') + '</div>';
  }

  // ------------------------------------------------------------------
  // click -> load into the Calculator
  // ------------------------------------------------------------------

  /**
   * Hand the clicked bracelet to app.js's own import hook — the same one
   * bible-import.js uses, so a row click and an import land in identical state.
   * No refetch: everything the panel needs is already in the row.
   */
  function openInCalculator(c) {
    var app = window.BraceletApp, imp = window.BraceletImport;
    if (!app || !app.applyImport || !imp || !imp.buildPatch) {
      if (typeof window.selectTab === "function") window.selectTab("calculator");
      setStatus("The Calculator panel is not ready yet.", "err");
      return;
    }
    var lo = c.loadouts[c.best] || c.loadouts[0];
    if (!lo || !lo.rawStats || !lo.rawStats.length) { setStatus("That row carries no bracelet to load.", "err"); return; }
    var rolls = lo.rollsRemaining || { base: 0, ticket: 0 };
    var built;
    try {
      built = imp.buildPatch({
        stats: lo.rawStats,
        // The panel counts rolls LEFT; the payload's numRerolls are the counts USED,
        // so the seed's own rollsRemaining is what goes in here.
        numRerolls: rolls.base || 0,
        numTicketRerolls: rolls.ticket || 0
      });
    } catch (e) { setStatus("That bracelet could not be decoded.", "err"); return; }
    built.patch.character = {
      name: c.name, region: c.region, "class": c["class"] || null,
      itemLevel: c.itemLevel == null ? null : c.itemLevel,
      source: "leaderboard", cached: null, pulledAt: c.pulledAt || null
    };
    app.applyImport(built.patch);
    if (typeof window.selectTab === "function") window.selectTab("calculator");
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
      if (ch) openInCalculator(ch);
    });
  }

  // ------------------------------------------------------------------
  // rank, filter, paint
  // ------------------------------------------------------------------

  function byPctDesc(a, b) {
    var av = a._pct == null ? -Infinity : a._pct;
    var bv = b._pct == null ? -Infinity : b._pct;
    return bv - av;
  }

  /**
   * Build the display list from rawChars and paint.
   *
   * Ranking happens BEFORE the name search filters anything, so a searched
   * character keeps its true overall rank.
   */
  function rebuild() {
    var base = rawChars.filter(function (c) { return regions[c.region]; });
    if (classFilter) base = base.filter(function (c) { return c["class"] === classFilter; });
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
    for (i = 0; i < rawChars.length; i++) if (rawChars[i]["class"]) set[rawChars[i]["class"]] = true;
    if (classFilter) set[classFilter] = true;      // keep a saved choice selectable
    var classes = Object.keys(set).sort();
    var html = '<option value="">All classes</option>';
    for (i = 0; i < classes.length; i++) html += '<option value="' + esc(classes[i]) + '">' + esc(classes[i]) + '</option>';
    sel.innerHTML = html;
    sel.value = classFilter;
  }

  function renderTable(chars) {
    rawChars = scoreChars(chars);
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

  /** The seed file — the board's default source while the Worker is undeployed. */
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
      var chars = fromSeed(r.data);
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
   * The Worker first when one is configured, the seed otherwise — and the seed
   * again, quietly, whenever the Worker cannot answer with rows. A 429 is NOT an
   * error: the board throttles refreshes on purpose, so keep whatever is on screen
   * and say so in a neutral voice.
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
      var chars = r.ok ? fromWorker(r.data) : [];
      if (chars.length) {
        sourceNote = "Live board data from our Worker.";
        setStatus(chars.length + " character" + (chars.length === 1 ? "" : "s") + " on the board.", "");
        renderTable(chars);
        return null;
      }
      // The Worker is up but has no snapshot yet (it answers 501 until one is
      // built). That is not a failure the reader needs shouting at them.
      return loadSeed(fresh, "The Worker has no snapshot yet, so this is the baked copy. ");
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
