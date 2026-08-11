/**
 * bible-import.js — "Sign in with lostark.bible" and pull a bracelet off one of
 * your own characters.
 *
 * Sits in the Bracelet panel, above the slot rows. Signed out it is one button.
 * Signed in it is a list of the characters the token can see; click one and the
 * panel below fills in — grade, the two combat traits, every granted slot with
 * its family and tier, and the rolls left.
 *
 * WHAT IT TALKS TO
 *   window.BibleOAuth      bible-oauth.js — PKCE sign-in, GET /api/oauth/rosters
 *   window.Bracelet        model/bracelet.js — decodeBibleBracelet(stats)
 *   window.BraceletApp     app.js — applyImport(patch), the one hook into the UI
 *   WORKER_URL             worker/bracelet.js — the bracelet fallback fetch
 * The raid statistics endpoints are never touched: the site owner banned that,
 * and everything here reads the signed-in user's OWN roster through OAuth.
 *
 * THE SHAPE PROBLEM. lostark.bible does not document what /api/oauth/rosters
 * returns, and as of 2026-08-11 nobody has run it with a live token — the probe
 * needs a Discord sign-in nobody but Shizu can complete. So NOTHING here keys off
 * a field name it hasn't seen. `findCharacters` and `findBracelet` walk whatever
 * JSON arrives looking for shapes rather than paths:
 *   - a character is any object with a string `name` plus a class or item level;
 *   - a bracelet is any object carrying a `stats` array whose entries have the
 *     numeric type/index/value triple the decoder eats.
 * `BraceletImport.dumpShape()` in the console prints the real key paths, and
 * docs/research/oauth-rosters-shape.md is where the answer gets written down.
 *
 * WHERE THE BRACELET COMES FROM. Two sources, tried in order:
 *   1. the roster payload itself, if it turns out to carry the bracelet;
 *   2. OUR OWN Worker (worker/bracelet.js), which fetches the character PAGE
 *      server-side — the browser cannot, there is no CORS on the page routes.
 * The Worker re-checks ownership with the same token before it fetches anything:
 * it calls /api/oauth/rosters itself and refuses any name that is not on the
 * caller's own roster. So the click is gated twice, on purpose. Design:
 * docs/design/bible-import-fallback.md; deploy: docs/deploy-worker.md.
 *
 * ONE CHARACTER, SEVERAL BRACELETS. lostark.bible keeps a separate loadout per
 * tab — "Raid Loadout", "Current Loadout (Chaos Dungeon)", sometimes "Estimated
 * Raid Loadout" — and each carries its OWN equipment, so each can hold a
 * different bracelet. Nine of the thirty characters in data/leaderboard-seed.json
 * do, by up to 3.4 percentage points of damage. The Worker sends them all; the
 * pill row under the character list offers them all; the highest loads first
 * and is the one the board ranks. The calculator is for asking "what if", so
 * every bracelet the character actually owns stays one click away.
 *
 * TWO SCORES, AND THEY DIFFER. The Worker answers with `defaultScore` — the
 * bracelet's damage on the CANONICAL DEFAULT profile, which is the only number
 * the leaderboard ever ranks on. The calculator below scores the same bracelet
 * on whatever character settings the user has entered. Both are reported, and
 * the note under the list says which is which; an imported profile must never
 * be allowed to move a leaderboard number.
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
   * Empty is a supported state, not a bug: signing in and listing characters
   * still works, and a click lands on a message that says the page fetch is not
   * wired up yet rather than on a broken request.
   */
  var WORKER_URL = "";

  // One silent re-auth per page load. A dead token sends the user straight back
  // through /oauth/authorize, which auto-approves while the grant lives — but if
  // that comes back dead too, a second bounce would loop the browser forever.
  var REAUTH_FLAG = "bc_bible_reauth";

  var MOUNT_ID = "bc-import";
  var state = {
    busy: false,
    error: null,       // {kind, detail}
    user: null,
    chars: null,       // [{name, cls, ilvl, region, node}]
    raw: null,         // the last rosters payload, for dumpShape()
    picked: null,      // name of the character last imported
    note: null,        // a one-line result under the list
    // A character wears one bracelet PER LOADOUT on lostark.bible — a raid one,
    // a chaos-dungeon one, sometimes an estimated-raid one — and nine of the
    // thirty characters read so far wear a DIFFERENT bracelet in each. So the
    // panel offers them all instead of deciding for the user.
    loadouts: null,    // [{classification, label, bracelet, defaultScore, isRendered}]
    loadoutIdx: 0,     // which one is in the calculator right now
    bestLoadout: 0     // the highest, which is what the board ranks
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
   * ("devil_hunter_female"), not the English name a player recognises. Confirmed
   * 2026-08-11 by joining the live payload against the character pages —
   * docs/research/oauth-rosters-shape.md has the table and the working.
   *
   * The Worker keeps its own copy (ROSTER_CLASS in worker/bracelet.js) for the
   * board. Two copies of a nine-row lookup is a fair price for not inventing a
   * shared data file that the model tables would then have to live beside; if it
   * ever grows past this, give it one home in data/.
   *
   * An unknown code is title-cased, never dropped: "Devil Hunter Male" on screen
   * is a bug report, a blank is a shrug.
   */
  var CLASS_NAME = {
    arcana: "Arcanist", berserker: "Berserker", blade: "Deathblade",
    devil_hunter_female: "Gunslinger", dragon_knight: "Guardianknight",
    alchemist: "Wildsoul", reaper: "Reaper", soul_eater: "Souleater", bard: "Bard"
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
   * decodeBibleBracelet's lines -> the state patch app.js merges.
   * Fixed lines split two ways: a Crit / Spec / Swiftness trait is one of the two
   * combat traits the panel shows at the top, anything else is a fixed line in
   * the Advanced fold. Unlocked lines are the granted slots.
   */
  /**
   * The decoder guesses Relic or Ancient by matching special-effect values
   * against both tables, and the two tables overlap enough that it can land on
   * the wrong one. The slot count is a second, independent witness: Ancient
   * grants 2–3 lines, Relic 1–2. When the guess cannot hold the lines it just
   * decoded and the other grade can, re-decode against that table — the tiers
   * have to come from the right value table, so this is a re-run, not a relabel.
   */
  function decodeWithGradeCheck(stats) {
    var dec = B.decodeBibleBracelet(stats);
    var granted = 0, i;
    for (i = 0; i < dec.lines.length; i++) if (!dec.lines[i].fixed) granted++;
    if (slotChoices(dec.grade).indexOf(granted) >= 0) return dec;
    var other = dec.grade === "relic" ? "ancient" : "relic";
    if (slotChoices(other).indexOf(granted) < 0) return dec;   // fits neither; leave the guess alone
    return B.decodeBibleBracelet(stats, { grade: other });
  }

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
  // rendering
  // ------------------------------------------------------------------

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function nf(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function styleBlock() {
    return "<style>" +
      "#bc-import{margin:2px 0 4px}" +
      "#bc-import .bi-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
      "#bc-import .bi-msg{color:var(--dim);font-size:11px;margin-top:6px;max-width:70ch}" +
      "#bc-import .bi-msg.bad{color:var(--bad)}" +
      "#bc-import .bi-msg.good{color:var(--good)}" +
      "#bc-import .bi-who{color:var(--dim);font-size:11px}" +
      "#bc-import .bi-who b{color:var(--text);font-weight:700}" +
      "#bc-import .bi-chars{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}" +
      "#bc-import .bi-char{background:var(--panel2);border:1px solid var(--border);border-radius:6px;" +
        "padding:6px 10px;font:inherit;font-size:12px;color:var(--text);cursor:pointer;text-align:left;line-height:1.3}" +
      "#bc-import .bi-char:hover{border-color:var(--accent)}" +
      "#bc-import .bi-char.on{border-color:var(--accent);color:var(--accent)}" +
      "#bc-import .bi-char small{display:block;color:var(--dim);font-size:10px}" +
      "#bc-import .bi-lds{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}" +
      "#bc-import .bi-lds .bi-ldcap{color:var(--dim);font-size:11px;margin-right:2px}" +
      "#bc-import .mbtn.bi-ld{padding:3px 9px;font-size:11px;font-weight:700}" +
      "#bc-import .mbtn.bi-ld.on{color:var(--accent);border-color:var(--accent)}" +
      "#bc-import .mbtn.bi-ld b{font-weight:700;color:inherit}" +
      "#bc-import .mbtn.bi-ld i{font-style:normal;color:var(--good);margin-left:3px}" +
      "</style>";
  }

  /**
   * The mount. app.js may provide `#bc-import` itself; if it doesn't, make one
   * at the top of the Bracelet panel. Building it here keeps the footprint in
   * app.js — a file two people edit at once — down to the applyImport hook.
   */
  function mount() {
    var box = document.getElementById(MOUNT_ID);
    if (box) return box;
    var panel = document.getElementById("bc-braceletpanel");
    if (!panel) return null;
    box = document.createElement("div");
    box.id = MOUNT_ID;
    // After the panel's header row, before the "Combat traits" heading.
    panel.insertBefore(box, panel.children.length > 1 ? panel.children[1] : null);
    return box;
  }

  function render() {
    var box = mount();
    if (!box) return;
    var h = styleBlock();

    if (!OA.configured()) {
      // Only reachable if someone blanks the client id — worth saying plainly
      // rather than showing a button that dead-ends on the consent screen.
      box.innerHTML = h + '<div class="bi-msg bad">Import is switched off: no lostark.bible app is configured for this build.</div>';
      return;
    }

    if (!OA.signedIn()) {
      h += '<div class="bi-row"><button class="mbtn" id="bi-login" type="button">Sign in with lostark.bible</button>' +
        '<span class="bi-who">to read a bracelet off one of your own characters</span></div>' +
        '<div class="bi-msg">You grant this page read access to YOUR linked rosters, nothing else. ' +
        'The pass lasts 90 days and Sign out takes it back.</div>';
      if (state.error) h += msgHtml();
      box.innerHTML = h;
      bind();
      return;
    }

    var who = state.user && (state.user.username || state.user.name || state.user.globalName || state.user.id);
    h += '<div class="bi-row">' +
      '<button class="mbtn" id="bi-refresh" type="button"' + (state.busy ? " disabled" : "") + '>' +
        (state.busy ? "Loading…" : "Reload characters") + "</button>" +
      '<button class="mbtn" id="bi-logout" type="button">Sign out</button>' +
      (who ? '<span class="bi-who">signed in as <b>' + esc(who) + "</b></span>" : "") +
      "</div>";

    if (state.chars && state.chars.length) {
      h += '<div class="bi-chars">';
      for (var i = 0; i < state.chars.length; i++) {
        var c = state.chars[i];
        var sub = [classLabel(c.cls), c.ilvl !== null ? nf(c.ilvl) : "", c.region].filter(Boolean).join(" · ");
        // While a fetch is in flight the whole list goes inert: the Worker paces
        // itself anyway, and a second click would only earn a rate-limit message.
        if (state.busy && state.picked === c.name) sub = "reading…";
        h += '<button type="button" class="bi-char' + (state.picked === c.name ? " on" : "") + '"' +
          (state.busy ? " disabled" : "") + ' data-idx="' + i + '">' +
          esc(c.name) + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</button>";
      }
      h += "</div>";
    } else if (state.chars && !state.chars.length && !state.busy && !state.error) {
      h += '<div class="bi-msg">Signed in, but this lostark.bible account has no characters we can read. ' +
        'Link a roster on lostark.bible — and un-hide the characters you want here, since hidden ones never leave the site.</div>';
    }

    h += loadoutsHtml();
    h += msgHtml();
    box.innerHTML = h;
    bind();
  }

  /**
   * The loadout pills.
   *
   * A lostark.bible character page carries one loadout per tab — "Raid Loadout",
   * "Current Loadout (Chaos Dungeon)", sometimes "Estimated Raid Loadout" — and
   * each has its own equipment, so each can hold a DIFFERENT bracelet. Nine of
   * the thirty characters in the seed do. This row shows every bracelet the
   * character actually has, scored on the canonical default profile so the
   * numbers are comparable to each other and to the board.
   *
   * The highest carries the caret and is what loads first, because that is the
   * one the board ranks. Clicking any other fills the calculator with it — the
   * calculator is for asking "what if", and refusing to show the chaos bracelet
   * would be deciding for the user which of their own brackets is real.
   *
   * Nothing here appears unless there is a choice to make: one loadout, no row.
   */
  function loadoutsHtml() {
    var lds = state.loadouts;
    if (!lds || lds.length < 2) return "";
    var h = '<div class="bi-lds"><span class="bi-ldcap">Loadout:</span>', i, l, pct;
    for (i = 0; i < lds.length; i++) {
      l = lds[i];
      pct = l.defaultScore && typeof l.defaultScore.pct === "number" ? l.defaultScore.pct.toFixed(1) + "%" : "—";
      h += '<button type="button" class="mbtn bi-ld' + (i === state.loadoutIdx ? " on" : "") + '"' +
        (state.busy ? " disabled" : "") + ' data-ld="' + i + '"' +
        ' title="' + esc(loadoutTitle(l, i)) + '">' +
        esc(l.label || l.classification) + " <b>" + pct + "</b>" +
        (i === state.bestLoadout ? '<i title="highest — this is the one the leaderboard ranks">&#9650;</i>' : "") +
        "</button>";
    }
    h += "</div>";
    return h;
  }

  function loadoutTitle(l, i) {
    var bits = [];
    if (l.itemLevel) bits.push("item level " + l.itemLevel);
    if (l.isRendered) bits.push("the one lostark.bible's own page draws");
    if (i === state.bestLoadout) bits.push("highest — the figure the board ranks");
    return (l.classification || "loadout") + (bits.length ? " — " + bits.join("; ") : "");
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
        t = "The roster endpoint is an index, not a full loadout, and the character-page fetch that fills the gap " +
          "has not been deployed for this build yet. Fill the slots by hand for now — see docs/deploy-worker.md.";
      } else if (e.kind === "notyours") {
        // The Worker refused because the name is not on the caller's own roster.
        // Almost always a hidden character or an unlinked roster, so say that.
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
          ". Your bracelet is fine — try again in a minute, or fill the slots by hand.";
      } else if (e.kind === "nobracelet") {
        t = "We can see " + esc(e.who || e.detail || "that character") + ", but there is no bracelet on them. " +
          "If they are wearing one, it may not have synced to lostark.bible yet — open the character there once, " +
          "then try again.";
      } else if (e.kind === "undecodable") {
        t = "A bracelet came back for " + esc(e.detail || "that character") + ", but none of its lines decoded. " +
          "That usually means a new stat index — worth reporting with the payload from BraceletImport.dumpShape().";
      } else {
        t = "lostark.bible answered with an error" + (e.detail ? " (" + esc(e.detail) + ")" : "") +
          ". Nothing is wrong with your bracelet — try Reload characters in a minute.";
      }
      return '<div class="bi-msg bad">' + t + "</div>";
    }
    if (state.note) return '<div class="bi-msg good">' + esc(state.note) + "</div>";
    return "";
  }

  function bind() {
    var box = mount();
    if (!box) return;
    var b;
    if ((b = document.getElementById("bi-login"))) b.onclick = function () { OA.login(); };
    if ((b = document.getElementById("bi-refresh"))) b.onclick = function () { loadRosters(true); };
    if ((b = document.getElementById("bi-logout"))) b.onclick = function () {
      state.chars = null; state.user = null; state.raw = null; state.picked = null;
      state.note = null; state.error = null;
      OA.logout().then(render);      // logout() forgets locally first, so render is already correct
      render();
    };
    var list = box.querySelectorAll(".bi-char");
    for (var i = 0; i < list.length; i++) {
      list[i].onclick = (function (idx) {
        return function () { pick(state.chars[idx]); };
      })(Number(list[i].getAttribute("data-idx")));
    }
    var pills = box.querySelectorAll(".bi-ld");
    for (var j = 0; j < pills.length; j++) {
      pills[j].onclick = (function (idx) {
        return function () { pickLoadout(idx); };
      })(Number(pills[j].getAttribute("data-ld")));
    }
  }

  // ------------------------------------------------------------------
  // flow
  // ------------------------------------------------------------------

  function loadRosters(force) {
    if (!OA.signedIn()) { render(); return; }
    if (state.busy) return;
    if (state.chars && !force) { render(); return; }
    state.busy = true; state.error = null; state.note = null;
    render();

    Promise.all([
      OA.user().catch(function () { return null; }),
      OA.rosters()
    ]).then(function (r) {
      state.busy = false;
      state.user = r[0];
      state.raw = r[1];
      state.chars = findCharacters(r[1]);
      // Deterministic order: heaviest character first, then by name.
      state.chars.sort(function (a, b) {
        return (b.ilvl || 0) - (a.ilvl || 0) || (a.name < b.name ? -1 : 1);
      });
      render();
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
      render();
    });
  }

  // ------------------------------------------------------------------
  // the Worker: character PAGE fetch, server-side, behind the consent gate
  // ------------------------------------------------------------------

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
   * GET <worker>/character?name=&region= with the caller's own bearer token.
   * Resolves to the parsed JSON, or rejects with { kind, detail } already shaped
   * for msgHtml().
   *
   * The token goes to OUR OWN Worker and nowhere else. The Worker uses it twice:
   * once to re-check the roster (so it never fetches a page for a character the
   * caller does not own), and once as the credential on the page fetch itself,
   * so the request to lostark.bible is attributable to a consenting human.
   */
  function workerFetch(name, region) {
    var tok = OA.accessToken();
    if (!tok) return Promise.reject({ kind: "expired" });
    var url = WORKER_URL.replace(/\/+$/, "") + "/character?name=" + encodeURIComponent(name) +
      "&region=" + encodeURIComponent(region);
    return fetch(url, { headers: { Authorization: "Bearer " + tok } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return j;
        throw { status: r.status, kind: workerErrorKind(r.status, j.error), detail: j.message || j.error || ("HTTP " + r.status), error: j.error };
      });
    }, function () {
      throw { kind: "worker", detail: "the import service did not answer" };
    });
  }

  /** Worker error codes -> the message kinds msgHtml() knows how to word. */
  function workerErrorKind(status, code) {
    if (code === "not_yours") return "notyours";
    if (code === "no_bracelet") return "nobracelet";
    if (code === "no_such_character") return "nopage";
    if (code === "slow_down" || status === 429) return "slowdown";
    if (code === "not_signed_in" || code === "bad_token" || status === 401) return "expired";
    return "worker";
  }

  /**
   * Ask the Worker for one character's bracelet.
   *
   * Region handling: rosters may not name one. When it is unknown we try NA and,
   * if the page simply is not there, CE — two requests at worst, only for a
   * character we already know the caller owns. Anything else propagates.
   */
  function workerBracelet(c) {
    var known = bibleRegion(c.region);
    var order = known ? [known] : ["NA", "CE"];
    function attempt(i) {
      return workerFetch(c.name, order[i]).catch(function (e) {
        var retryable = (e.kind === "nopage" || e.kind === "notyours");
        if (i + 1 < order.length && retryable) return attempt(i + 1);
        throw e;
      });
    }
    return attempt(0);
  }

  /**
   * Click a character. Two sources for the bracelet, in order: the roster payload
   * itself (free, if it ever carries one), then the Worker's page fetch.
   */
  function pick(c) {
    if (!c) return;
    state.error = null; state.note = null; state.picked = c.name;
    // A new character means the old character's pills are stale. Drop them
    // before anything can fail, so a failed fetch never leaves someone else's
    // loadouts sitting under the list.
    state.loadouts = null; state.loadoutIdx = 0; state.bestLoadout = 0;

    var inline = findBracelet(c.node);
    if (inline) { applyBracelet(c, inline, null); return; }

    if (!WORKER_URL) {
      // The honest version of "not built yet": the roster is an index, and the
      // page fetch that would fill the gap has no address to call.
      state.error = { kind: "noworker", detail: c.name };
      render();
      return;
    }

    state.busy = true;
    render();
    workerBracelet(c).then(function (data) {
      state.busy = false;
      if (!data || !data.bracelet || !data.bracelet.stats || !data.bracelet.stats.length) {
        state.error = { kind: "nobracelet", detail: c.name };
        render();
        return;
      }
      takeLoadouts(c, data);
      applyBracelet(c, data.bracelet, data);
    }).catch(function (e) {
      state.busy = false;
      state.error = { kind: (e && e.kind) || "worker", detail: (e && e.detail) || c.name, who: c.name };
      render();
      if (e && e.kind === "expired") OA.login();
    });
  }

  /**
   * Keep the loadouts the Worker sent, if it sent any.
   *
   * Shape-tolerant on purpose, the same way findCharacters is: a Worker deployed
   * before this change answers without `loadouts` and the panel simply shows no
   * pills, which is exactly what it did before. Only loadouts that actually
   * carry a bracelet are kept — an empty slot is not a choice.
   */
  function takeLoadouts(c, data) {
    // `loadouts` used to be a COUNT on this endpoint, so check for an array and
    // not merely for truthiness.
    var raw = data && data.loadouts;
    if (!raw || Object.prototype.toString.call(raw) !== "[object Array]" || raw.length < 2) return;
    var keep = [], i, l, br;
    for (i = 0; i < raw.length; i++) {
      l = raw[i];
      br = l && (l.bracelet || l);
      if (!br || !br.stats || !br.stats.length) continue;
      keep.push({
        classification: l.classification || "loadout",
        label: l.label || l.classification || "Loadout " + (keep.length + 1),
        itemLevel: l.itemLevel || null,
        isRendered: !!l.isRendered,
        defaultScore: l.defaultScore || null,
        bracelet: br
      });
    }
    if (keep.length < 2) return;           // nothing to choose between
    state.loadouts = keep;
    // The Worker already ranked them; trust its index when it points at a
    // loadout we kept, and re-derive it from the scores when it does not.
    var best = typeof data.chosenLoadout === "number" && data.chosenLoadout < keep.length ? data.chosenLoadout : 0;
    if (!(typeof data.chosenLoadout === "number" && data.chosenLoadout < keep.length)) {
      for (i = 1; i < keep.length; i++) {
        var a = keep[best].defaultScore, b = keep[i].defaultScore;
        if (b && (!a || b.pct > a.pct)) best = i;
      }
    }
    state.bestLoadout = best;
    state.loadoutIdx = best;               // default selection = highest
  }

  /** How many DIFFERENT brackets sit behind the pills. Usually fewer than pills. */
  function distinctBracelets() {
    if (!state.loadouts) return 0;
    var seen = [], i, sig;
    for (i = 0; i < state.loadouts.length; i++) {
      sig = statsSig(state.loadouts[i].bracelet.stats);
      if (seen.indexOf(sig) < 0) seen.push(sig);
    }
    return seen.length;
  }
  function statsSig(stats) {
    var out = [], i, s;
    for (i = 0; i < stats.length; i++) {
      s = stats[i];
      out.push(s.type + ":" + s.index + ":" + s.value + ":" + (s.fixed ? 1 : 0));
    }
    return out.join("|");
  }

  /** Click a loadout pill: fill the calculator with that loadout's bracelet. */
  function pickLoadout(i) {
    if (!state.loadouts || !state.loadouts[i] || state.busy) return;
    state.loadoutIdx = i;
    state.error = null;
    var l = state.loadouts[i];
    applyBracelet({ name: state.picked || "that character" }, l.bracelet,
      { defaultScore: l.defaultScore, loadoutLabel: l.label });
  }

  /** Decode one bracelet payload and hand it to the calculator. */
  function applyBracelet(c, data, meta) {
    var built;
    try { built = buildPatch(data); }
    catch (e) { state.error = { kind: "undecodable", detail: c.name }; render(); return; }

    if (!built.patch.rows.length && !built.patch.fixedRows.length &&
        !built.decoded.lines.length) {
      state.error = { kind: "undecodable", detail: c.name };
      render();
      return;
    }

    var app = root.BraceletApp;
    if (!app || !app.applyImport) {
      state.error = { kind: "api", detail: "the calculator panel is not ready" };
      render();
      return;
    }
    app.applyImport(built.patch);

    var n = built.patch.rows.length;
    var which = (meta && meta.loadoutLabel) ||
      (state.loadouts && state.loadouts[state.loadoutIdx] && state.loadouts[state.loadoutIdx].label) || null;
    var note = "Loaded " + c.name + (which && state.loadouts && state.loadouts.length > 1 ? " (" + which + " loadout)" : "") +
      " — " + (built.patch.grade === "relic" ? "Relic" : "Ancient") + ", " +
      n + " granted slot" + (n === 1 ? "" : "s") + ".";
    // Say it once, plainly: they have more than one loadout and the buttons above
    // switch between them. Without this the pills read as a filter. Two loadouts
    // usually hold the SAME bracelet, so count the distinct ones and say which
    // case this is rather than implying a choice that isn't there.
    if (state.loadouts && state.loadouts.length > 1) {
      var d = distinctBracelets();
      note += " " + state.loadouts.length + " loadouts on lostark.bible" +
        (d > 1
          ? ", holding " + d + " different bracelets — the buttons above swap between them" +
            (state.loadoutIdx === state.bestLoadout ? ", and this is the highest" : "")
          : ", all holding this same bracelet") + ".";
    }
    // The two scores, side by side. The Worker's figure is the bracelet on the
    // CANONICAL DEFAULT profile — the only one the leaderboard ever uses. The
    // panel's own figure, just below, is this bracelet on YOUR settings. Saying
    // both is how a user learns why their rank is not their calculator number.
    if (meta && meta.defaultScore && typeof meta.defaultScore.pct === "number") {
      // The board ranks a character's BEST bracelet. Saying "the figure the
      // leaderboard ranks on" while a lower loadout is loaded would be a lie, so
      // only the best one gets that clause.
      var isBest = !state.loadouts || state.loadouts.length < 2 || state.loadoutIdx === state.bestLoadout;
      note += " On default settings it is worth +" + meta.defaultScore.pct.toFixed(2) + "% damage — " +
        (isBest
          ? "that is the figure the leaderboard ranks on"
          : "the board ranks your highest loadout, not this one") +
        "; the panel below scores it on YOUR character.";
      // The Worker sends the full unmapped list for the loaded bracelet and just
      // a count for the other loadouts, so read either shape.
      var um = meta.defaultScore.unmapped;
      var nUm = typeof um === "number" ? um : (um && um.length) || 0;
      if (nUm) {
        built.warn.push(nUm + " line" + (nUm > 1 ? "s use stat indices" : " uses a stat index") +
          " the model does not map yet, so " + (nUm > 1 ? "they score" : "it scores") + " zero");
      }
    }
    if (meta && meta.stale) {
      built.warn.push("lostark.bible could not be reached, so this is a copy from about " +
        (meta.staleHours || 0) + "h ago");
    }
    if (built.warn.length) note += " Note: " + built.warn.join("; ") + ".";
    state.note = note;
    render();
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
    OA.onChange(render);
    render();
    // A redirect back from the consent screen carries ?code=…; swap it for a
    // token, scrub the address bar, then load the roster straight away so the
    // round trip feels like one click.
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
      else render();
    });
    return true;
  }

  // app.js builds the panel this mounts into, so wait for the hook rather than
  // racing it: script order already puts app.js first, but a lazy load or a
  // slow parse must not lose the panel.
  function waitForPanel(tries) {
    if (boot()) return;
    if (tries <= 0) return;
    setTimeout(function () { waitForPanel(tries - 1); }, 60);
  }

  // Console shorthand for the probe. Signed in, `__probeRosters()` prints the
  // real shape of /api/oauth/rosters — the one fact this whole module had to be
  // written blind around. See docs/research/oauth-rosters-shape.md.
  root.__probeRosters = dumpShape;

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
    // Console handles for checking a fresh deploy without clicking:
    //   BraceletImport.workerUrl()
    //   BraceletImport.fetchCharacter("Paroxysmal", "NA").then(console.log)
    workerUrl: function () { return WORKER_URL; },
    fetchCharacter: function (name, region) { return workerFetch(name, bibleRegion(region) || "NA"); }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForPanel(50); });
  } else {
    waitForPanel(50);
  }
})(window);
