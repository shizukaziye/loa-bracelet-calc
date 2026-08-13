/**
 * char-picker.js — "which character am I looking at?", in one box, for any tab.
 *
 * The Calculator has always been able to answer that: type a name, press Grade,
 * or click a saved ★. No other tab could — you had to go to the Calculator, load
 * someone there, and come back. This is that control, small enough to sit on any
 * tab, and it exists ONCE so no two copies can drift.
 *
 * The Advisor is the only tab mounting it today (the Tier List dropped its copy
 * on 2026-08-12 along with the deck, and is scored on the default character
 * instead). Nothing here assumes that: mount() still takes any number of hosts
 * and every one of them repaints on the same state.
 *
 * It is a port of the astrogem calculator's advisor-setup.js character row, whose
 * two-path design this keeps exactly:
 *
 *   TYPE-AHEAD  over the board snapshot (BraceletImport.seed) — prefix matches
 *               first, region · class · item level on every hit, arrows + enter +
 *               escape, closes on an outside click.
 *   ★ STRIP     the saved characters, one click each. A favourite need not be on
 *               the board — a name with no snapshot row is still selectable and
 *               goes straight to the lookup. It is a GRID of identical chips that
 *               WRAPS, never a scroller: twenty favourites are twenty boxes on as
 *               many lines as that takes, and Shizu does not want a scrollbar over
 *               them ever (2026-08-12). Long names are cut to fit — see fitNames()
 *               for why the cut is done in the DOM and not left to the CSS.
 *
 * IT LOADS NOTHING ITSELF. bible-import.js owns fetching, decoding, loadout
 * choice and applying a character; BraceletImport.loadCharacter(region, name) is
 * the one entry point its own chips and console already use, and this calls that
 * and nothing else. The browser never touches lostark.bible — only the Worker
 * may, and bible-import.js is what talks to it. Nothing here opens a connection.
 *
 * ONE SHARED STATE, SO A PICK LANDS EVERYWHERE. There is one bracelet and one
 * character in profile.js, so choosing someone here loads them on every tab. That
 * is the point, not a leak. Profile notifies, each tab re-renders, and every
 * mounted picker repaints its own selected line.
 *
 * IT DOES NOT TOUCH THE DECK. Loading a character brings their BRACELET and
 * their banner; the settings stay the calculator's defaults until the user
 * presses "Import Character Stats". A host that wants to point at that button
 * passes `note`.
 *
 * WHAT IT TALKS TO
 *   window.BraceletImport   bible-import.js — seed() and loadCharacter()
 *   window.Profile          profile.js — the loaded character, and change notices
 *   window.Favorites        favorites.js — the saved-character spine
 *   window.BraceletApp      app.js — setCharacter(null) for the clear control
 * Every one is optional: a missing module costs the picker one capability and
 * says which, rather than throwing.
 *
 * API (window.CharPicker):
 *   mount(hostEl, opts) -> { refresh, status, host }   | null if hostEl is falsy
 *     opts.layout  "block" (default) | "row"   — "row" is the one-line variant
 *     opts.title   heading text, or "" for none          (default "Character")
 *     opts.note    function () -> string | ""  — one line under the box, repainted
 *                  on every profile change. Keep it to a line.
 *     opts.onSelect function (region, name)    — fired after the load is asked for
 */
(function (root) {
  "use strict";

  var MAX_HITS = 12;
  var DEBOUNCE = 150;

  // ---- module-wide state: one board snapshot and one status mirror for all ----
  var boardRows = null;              // [{region, name, class, itemLevel, …}]
  var boardState = "idle";           // "idle" | "loading" | "ready" | "gone"
  var boardLoad = null;
  var instances = [];
  var statusObs = null;
  var wiredGlobals = false;

  function imp() { return root.BraceletImport || null; }
  function prof() { return root.Profile || null; }
  function favs() { return root.Favorites || null; }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function nf(v) { return Math.round(v).toLocaleString("en-US"); }
  function character() {
    var P = prof();
    var c = P && P.get && P.get().char;
    return (c && c.name) ? c : null;
  }

  // ------------------------------------------------------------------
  // the board snapshot — bible-import.js's own session-cached fetch
  // ------------------------------------------------------------------

  /**
   * An empty or failed snapshot is a state, not an error: a lookup by name still
   * works without it, and the placeholder says so instead of pretending the box
   * is broken.
   */
  function ensureBoard() {
    if (boardState === "ready" || boardState === "gone") return Promise.resolve(boardRows);
    if (boardState === "loading") return boardLoad;
    var BI = imp();
    if (!BI || typeof BI.seed !== "function") {
      boardRows = []; boardState = "gone"; eachInstance(paintPlaceholder);
      return Promise.resolve(boardRows);
    }
    boardState = "loading";
    eachInstance(paintPlaceholder);
    boardLoad = BI.seed().then(function (idx) {
      boardRows = (idx && idx.list) || [];
      boardState = boardRows.length ? "ready" : "gone";
      eachInstance(paintPlaceholder);
      return boardRows;
    }, function () {
      boardRows = []; boardState = "gone"; eachInstance(paintPlaceholder);
      return boardRows;
    });
    return boardLoad;
  }

  /** Prefix matches first, then anywhere in the name; ties alphabetical. */
  function search(q) {
    var lq = String(q).toLowerCase(), pre = [], mid = [], i, n, at;
    if (!boardRows) return { hits: [], total: 0 };
    for (i = 0; i < boardRows.length; i++) {
      n = (boardRows[i].name || "").toLowerCase();
      at = n.indexOf(lq);
      if (at === 0) pre.push(boardRows[i]);
      else if (at > 0) mid.push(boardRows[i]);
    }
    function byName(a, b) { return (a.name || "").localeCompare(b.name || ""); }
    pre.sort(byName); mid.sort(byName);
    var all = pre.concat(mid);
    return { hits: all.slice(0, MAX_HITS), total: all.length };
  }

  // ------------------------------------------------------------------
  // style — injected once, scoped to .cp so it rides on any tab
  // ------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById("cp-style")) return;
    var css = "" +
      ".cp{min-width:0}" +
      ".cp-hd{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);font-weight:700;margin-bottom:7px}" +
      // the one-line variant: label, box, who, ★s on a single row
      ".cp-inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
      ".cp-inline .cp-hd{margin:0}" +
      ".cp-inline .cp-wrap{width:210px;flex:0 1 210px}" +
      ".cp-inline .cp-sel{margin-top:0}" +
      // The ★ strip takes the whole width on its own line and WRAPS. It never
      // scrolls: a roster of twenty is twenty chips on as many lines as that
      // needs, all of them on screen without a gesture.
      ".cp-inline .cp-favs{flex:1 0 100%;margin-top:2px;min-width:0}" +
      ".cp-inline .cp-status,.cp-inline .cp-note{flex:1 0 100%;margin-top:0}" +
      ".cp-inline .cp-status:empty,.cp-inline .cp-note:empty{display:none}" +
      ".cp-wrap{position:relative;display:block}" +
      ".cp-search{width:100%;box-sizing:border-box;background:var(--panel2);color:var(--text);" +
        "border:1px solid var(--border);border-radius:7px;padding:7px 10px;font-size:13px;font-family:inherit}" +
      ".cp-search:focus{outline:1px solid var(--accent)}" +
      ".cp-results{display:none;position:absolute;z-index:60;left:0;right:0;min-width:230px;top:calc(100% + 4px);" +
        "background:var(--panel2);border:1px solid var(--border);border-radius:8px;max-height:264px;overflow:auto;" +
        "box-shadow:0 8px 22px rgba(0,0,0,.45)}" +
      ".cp-row{display:flex;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:0;" +
        "border-bottom:1px solid var(--border);color:var(--text);padding:7px 10px;cursor:pointer;font-size:13px;font-family:inherit}" +
      ".cp-row:hover,.cp-row.on{background:rgba(102,199,255,.10)}" +
      ".cp-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cp-row .rg{font-size:10px;font-weight:700;letter-spacing:.05em;background:var(--panel);" +
        "border:1px solid var(--border);border-radius:5px;padding:1px 5px;color:var(--dim);flex:0 0 auto}" +
      ".cp-row .cl{color:var(--dim);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cp-row .il{margin-left:auto;color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums;flex:0 0 auto}" +
      ".cp-more{padding:6px 10px;color:var(--dim);font-size:11px;line-height:1.5}" +
      ".cp-look{padding:7px 10px;border-top:1px solid var(--border);color:var(--dim);font-size:11px;line-height:2}" +
      ".cp-look .mbtn{padding:2px 9px;font-size:11px;margin-left:5px}" +
      ".cp-sel{font-size:12.5px;margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;min-width:0}" +
      ".cp-sel .star{color:var(--high)}" +
      ".cp-sel .meta{color:var(--dim);font-size:11.5px}" +
      ".cp-sel .none{color:var(--dim)}" +
      ".cp-clear{background:none;border:1px solid var(--border);border-radius:99px;color:var(--dim);" +
        "font-family:inherit;font-size:10.5px;font-weight:700;padding:1px 9px;cursor:pointer}" +
      ".cp-clear:hover{color:var(--text);border-color:var(--accent)}" +
      // EVERY CHIP IS THE SAME BOX. A grid of fixed tracks, not a flex flow: a
      // one-letter name and a twenty-letter one get the identical rectangle, so
      // the strip reads as a grid instead of a ragged edge. The name is cut with
      // an ellipsis and the whole name stays in the chip’s title.
      // minmax(0,…), not a bare track: below one chip’s width the column shrinks
      // with the page rather than pushing it sideways.
      ".cp{--cp-chip-w:150px;--cp-chip-h:26px}" +
      ".cp-favs{display:grid;grid-template-columns:repeat(auto-fill,minmax(0,var(--cp-chip-w)));" +
        "gap:6px;margin-top:8px;min-width:0}" +
      ".cp-fav{display:flex;gap:5px;align-items:center;box-sizing:border-box;width:100%;min-width:0;" +
        "height:var(--cp-chip-h);overflow:hidden;background:var(--panel2);border:1px solid var(--border);" +
        "border-radius:99px;padding:0 9px;color:var(--text);cursor:pointer;font-size:12px;font-family:inherit;" +
        // line-height BELOW the font's own line box would make each span's content
        // taller than its box — nothing a reader would see, but it is overflow,
        // and the rule here is that nothing in this strip overflows anything.
        "line-height:1.35;text-align:left}" +
      ".cp-fav:hover{border-color:var(--accent)}" +
      ".cp-fav .st{color:var(--high);flex:0 0 auto;font-size:11px}" +
      ".cp-fav .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cp-fav .rg{color:var(--dim);font-size:10px;flex:0 0 auto}" +
      ".cp-favnone{grid-column:1/-1;color:var(--dim);font-size:11px;line-height:1.5}" +
      ".cp-status{font-size:11.5px;color:var(--dim);margin-top:7px;line-height:1.5}" +
      ".cp-status.working{color:var(--accent)}" +
      ".cp-status.err{color:var(--bad)}" +
      ".cp-status.ok{color:var(--good)}" +
      ".cp-note{font-size:11.5px;color:var(--dim);margin-top:5px;line-height:1.5}" +
      "@media(max-width:520px){.cp-inline .cp-wrap{flex:1 1 100%;width:auto}}";
    var st = document.createElement("style");
    st.id = "cp-style";
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------
  // one mounted picker
  // ------------------------------------------------------------------

  function markup(opts) {
    var title = opts.title === undefined ? "Character" : opts.title;
    return (title ? '<div class="cp-hd">' + esc(title) + "</div>" : "") +
      '<div class="cp-wrap">' +
      '<input class="cp-search" type="text" autocomplete="off" spellcheck="false" role="combobox"' +
      ' aria-expanded="false" aria-autocomplete="list" aria-label="Search characters" placeholder="Search characters…">' +
      '<div class="cp-results" role="listbox" aria-label="Character matches"></div>' +
      "</div>" +
      '<div class="cp-sel"></div>' +
      '<div class="cp-favs"></div>' +
      '<div class="cp-status" role="status"></div>' +
      '<div class="cp-note"></div>';
  }

  function eachInstance(fn) {
    for (var i = 0; i < instances.length; i++) {
      // A tab can be rebuilt under us; drop the picker with it rather than
      // painting into an element nobody can see.
      if (!instances[i].host || !instances[i].host.isConnected) { instances.splice(i--, 1); continue; }
      try { fn(instances[i]); } catch (e) { /* one bad instance must not stop the rest */ }
    }
  }

  function paintPlaceholder(inst) {
    var inp = inst.search;
    if (!inp) return;
    if (boardState === "ready") inp.placeholder = "Search " + boardRows.length.toLocaleString("en-US") + " characters…";
    else if (boardState === "loading") inp.placeholder = "Loading the character board…";
    else if (!imp()) inp.placeholder = "Character lookup is not loaded";
    else inp.placeholder = "Type a name to look it up";
  }

  function paintSel(inst) {
    var c = character();
    if (!c) {
      inst.sel.innerHTML = '<span class="none">' + esc(inst.opts.emptyText ||
        "No character loaded — search a name or pick a saved one.") + "</span>";
      return;
    }
    var bits = [];
    if (c.region) bits.push(esc(c.region));
    if (c["class"]) bits.push(esc(c["class"]));
    if (c.itemLevel != null) bits.push("ilvl " + nf(c.itemLevel));
    inst.sel.innerHTML = '<span><span class="star">&#9733;</span> <b>' + esc(c.name) + "</b>" +
      (bits.length ? ' <span class="meta">' + bits.join(" · ") + "</span>" : "") + "</span>" +
      '<button type="button" class="cp-clear">clear</button>';
  }

  function paintFavs(inst) {
    var F = favs();
    var list = (F && F.list()) || [];
    if (!list.length) {
      inst.favs.innerHTML = '<span class="cp-favnone">&#9733; Saved characters land here — star one in the ' +
        "Calculator's character panel.</span>";
      return;
    }
    inst.favs.innerHTML = list.map(function (f, i) {
      return '<button type="button" class="cp-fav" data-cpf="' + i + '" title="Load ' + esc(f.name) +
        " (" + esc(f.region) + ')"><span class="st">&#9733;</span><span class="nm">' + esc(f.name) +
        '</span><span class="rg">' + esc(f.region) + "</span></button>";
    }).join("");
    fitNames(inst);
  }

  /**
   * Cut each chip's name to what its box actually holds, and put the ellipsis in
   * ourselves.
   *
   * The CSS rule draws the same picture on its own, but text-overflow leaves the
   * whole string inside a clipped box: the span's scrollWidth stays wider than
   * its clientWidth, which is the signature of a thing that scrolls. Nothing in
   * this strip may even look like it scrolls, so the DOM carries the short name
   * and the CSS rule stays behind it as the backstop.
   *
   * Binary search over the real layout rather than a canvas measurement: no
   * guess about which font arrived, and it costs about five reflows per chip
   * that is too long, only when the strip is redrawn.
   *
   * A HIDDEN TAB measures every box at zero. Leave the names whole there and fit
   * them when the tab is shown — until then the CSS is drawing the ellipsis
   * anyway, so the worst case is exactly the old behaviour.
   */
  function fitNames(inst) {
    if (!inst.favs || !inst.favs.clientWidth) return;
    var spans = inst.favs.querySelectorAll(".cp-fav .nm"), i;
    for (i = 0; i < spans.length; i++) fitOne(spans[i]);
  }

  function fitOne(sp) {
    var full = sp.getAttribute("data-nm");
    if (full === null) { full = sp.textContent; sp.setAttribute("data-nm", full); }
    else if (sp.textContent !== full) sp.textContent = full;
    if (sp.scrollWidth <= sp.clientWidth) return;
    // The longest prefix that fits, with the ellipsis counted in.
    var lo = 0, hi = full.length, mid;
    while (lo < hi) {
      mid = (lo + hi + 1) >> 1;
      sp.textContent = full.slice(0, mid) + "\u2026";
      if (sp.scrollWidth <= sp.clientWidth) lo = mid; else hi = mid - 1;
    }
    sp.textContent = lo ? full.slice(0, lo) + "\u2026" : "\u2026";
  }

  /** One line, from the host. Repainted on every profile change. */
  function paintNote(inst) {
    var txt = "";
    if (typeof inst.opts.note === "function") {
      try { txt = inst.opts.note() || ""; } catch (e) { txt = ""; }
    }
    inst.note.innerHTML = txt;
  }

  function setStatus(inst, text, kind) {
    inst.status.className = "cp-status" + (kind ? " " + kind : "");
    inst.status.textContent = text || "";
  }

  function rowHtml(c, i) {
    return '<button type="button" class="cp-row" role="option" data-cpi="' + i + '">' +
      '<span class="nm">' + esc(c.name) + "</span>" +
      '<span class="rg">' + esc(c.region) + "</span>" +
      (c["class"] ? '<span class="cl">' + esc(c["class"]) + "</span>" : "") +
      (c.itemLevel != null ? '<span class="il">' + nf(c.itemLevel) + "</span>" : "") +
      "</button>";
  }

  function runSearch(inst, q) {
    q = String(q == null ? "" : q).trim();
    if (!q) { close(inst); return; }
    var r = search(q);
    inst.hits = r.hits;
    inst.active = r.hits.length ? 0 : -1;

    var h = r.hits.map(rowHtml).join("");
    if (boardState === "loading") {
      h += '<div class="cp-more">Loading the character board…</div>';
    } else if (r.total > r.hits.length) {
      h += '<div class="cp-more">…and ' + (r.total - r.hits.length) + " more — keep typing</div>";
    } else if (!r.hits.length) {
      h += '<div class="cp-more">' + (boardState === "gone"
        ? "The character board did not load, so there is nothing to search — a lookup by name still works."
        : "Nobody on the board matches &ldquo;" + esc(q) + "&rdquo;.") + "</div>";
    }
    // The fetch-only path, always offered: the board is a cache, not the game.
    h += '<div class="cp-look">Not on the board? Look &ldquo;' + esc(q) + '&rdquo; up on' +
      '<button type="button" class="mbtn" data-cpr="NA">NA</button>' +
      '<button type="button" class="mbtn" data-cpr="EU">EU</button></div>';

    inst.results.innerHTML = h;
    inst.results.style.display = "block";
    inst.open = true;
    inst.search.setAttribute("aria-expanded", "true");
    paintActive(inst);
  }

  function close(inst) {
    inst.results.style.display = "none";
    inst.results.innerHTML = "";
    inst.open = false;
    inst.hits = [];
    inst.active = -1;
    inst.search.setAttribute("aria-expanded", "false");
  }

  function paintActive(inst) {
    var rows = inst.results.getElementsByClassName("cp-row"), i;
    for (i = 0; i < rows.length; i++) {
      var on = i === inst.active;
      rows[i].className = on ? "cp-row on" : "cp-row";
      rows[i].setAttribute("aria-selected", on ? "true" : "false");
      if (on && rows[i].scrollIntoView) {
        try { rows[i].scrollIntoView({ block: "nearest" }); } catch (e) { /* older browser */ }
      }
    }
  }

  function move(inst, d) {
    if (!inst.open || !inst.hits.length) return;
    inst.active = (inst.active + d + inst.hits.length) % inst.hits.length;
    paintActive(inst);
  }

  /** The region a free-typed name goes to when the user does not say. */
  function defaultRegion() {
    var sel = document.getElementById("bi-region");
    if (sel && sel.value) return String(sel.value).toUpperCase();
    var c = character();
    return (c && c.region) ? String(c.region).toUpperCase() : "NA";
  }

  // ------------------------------------------------------------------
  // selection — hand the name to bible-import.js and get out of the way
  // ------------------------------------------------------------------

  /**
   * Every failure below is one this file can see for itself. Everything the
   * LOOKUP can fail at — no such character, no bracelet, queued, worker
   * unreachable — is bible-import.js's own sentence, mirrored by mirrorStatus()
   * rather than reworded here. Two wordings of one outcome is how they drift.
   */
  function select(inst, region, name) {
    name = String(name == null ? "" : name).trim();
    if (!name) { setStatus(inst, "Type a character name first.", "err"); return; }
    close(inst);
    inst.search.value = "";

    var BI = imp();
    if (!BI || typeof BI.loadCharacter !== "function") {
      broadcast("The character loader (bible-import.js) is not on this page, so nothing can be looked up. " +
        "The Calculator's Bracelet panel still takes a bracelet typed by hand.", "err");
      return;
    }
    if (!document.getElementById("bi-name") || !document.getElementById("bi-region")) {
      broadcast("The Calculator's character panel has not been built yet. Open the Calculator tab once, then come back.", "err");
      return;
    }

    broadcast("Looking up " + name + " (" + region + ")…", "working");
    startMirror();
    try {
      BI.loadCharacter(region, name);
    } catch (e) {
      broadcast("The lookup failed before it started: " + ((e && e.message) || "unknown error"), "err");
      return;
    }
    if (typeof inst.opts.onSelect === "function") {
      try { inst.opts.onSelect(region, name); } catch (e) { /* the host's problem */ }
    }
  }

  function clear(inst) {
    var app = root.BraceletApp, P = prof();
    if (app && typeof app.setCharacter === "function") app.setCharacter(null);
    else if (P && typeof P.setCharacter === "function") P.setCharacter(null);
    close(inst);
    inst.search.value = "";
    eachInstance(paintSel);
    broadcast("Cleared. The bracelet stays exactly as it is — it is simply no longer tied to a character.", "");
  }

  function broadcast(text, kind) {
    eachInstance(function (inst) { setStatus(inst, text, kind); });
  }

  /**
   * One status line, several places. bible-import.js writes the whole story of a
   * pull — board hit, queue position, no bracelet, worker unreachable — into
   * #bi-pull-status. Repeating that reasoning here would be a second load path in
   * prose, so this mirrors the sentence it already wrote.
   *
   * A BraceletImport.onStatus(cb) hook would retire this observer; until then the
   * DOM is the only place that sentence exists.
   */
  function startMirror() {
    if (statusObs) return;
    var el = document.getElementById("bi-pull-status");
    if (!el || typeof MutationObserver !== "function") return;
    statusObs = new MutationObserver(mirrorStatus);
    statusObs.observe(el, { childList: true, characterData: true, subtree: true });
  }

  function mirrorStatus() {
    var el = document.getElementById("bi-pull-status");
    if (!el) return;
    var txt = (el.textContent || "").trim();
    if (!txt) return;
    var cls = " " + (el.className || "") + " ";
    var kind = cls.indexOf(" err ") !== -1 ? "err"
      : cls.indexOf(" working ") !== -1 ? "working"
      : cls.indexOf(" ok ") !== -1 ? "ok" : "";
    // The long form lives in the Calculator's message host; point at it rather
    // than copying a paragraph into a one-line status.
    var host = document.getElementById("bi-msg-host");
    if (kind === "err" && host && (host.textContent || "").trim()) {
      txt += " The Calculator tab spells this one out in full.";
    }
    broadcast(txt, kind);
  }

  // ------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------

  function bind(inst) {
    var host = inst.host;

    host.addEventListener("input", function (e) {
      if (e.target !== inst.search) return;
      var v = inst.search.value;
      clearTimeout(inst.t);
      inst.t = setTimeout(function () { ensureBoard().then(function () { runSearch(inst, v); }); }, DEBOUNCE);
    });

    // focus does not bubble; focusin does. Warm the board on the first focus so
    // the first keystroke has something to search.
    host.addEventListener("focusin", function (e) {
      if (e.target === inst.search) ensureBoard();
    });

    host.addEventListener("keydown", function (e) {
      if (e.target !== inst.search) return;
      var k = e.key;
      if (k === "ArrowDown" || k === "Down") { e.preventDefault(); move(inst, 1); }
      else if (k === "ArrowUp" || k === "Up") { e.preventDefault(); move(inst, -1); }
      else if (k === "Escape" || k === "Esc") { e.preventDefault(); close(inst); }
      else if (k === "Enter") {
        e.preventDefault();
        if (inst.open && inst.active >= 0 && inst.hits[inst.active]) {
          select(inst, inst.hits[inst.active].region, inst.hits[inst.active].name);
        } else {
          // No highlighted match: take the typed name at its word and look it up.
          select(inst, defaultRegion(), inst.search.value);
        }
      }
    });

    host.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest && t.closest(".cp-clear")) { clear(inst); return; }

      var row = t.closest && t.closest(".cp-row");
      if (row) {
        var hit = inst.hits[parseInt(row.getAttribute("data-cpi"), 10)];
        if (hit) select(inst, hit.region, hit.name);
        return;
      }

      var fav = t.closest && t.closest(".cp-fav");
      if (fav) {
        var F = favs();
        var f = ((F && F.list()) || [])[parseInt(fav.getAttribute("data-cpf"), 10)];
        // A favourite need not be on the board — the lookup takes it either way.
        if (f) select(inst, f.region, f.name);
        return;
      }

      var r = t.getAttribute && t.getAttribute("data-cpr");
      if (r) { select(inst, r, inst.search.value); }
    });
  }

  /** Subscriptions that belong to the module, not to any one mounted picker. */
  function wireGlobals() {
    if (wiredGlobals) return;
    wiredGlobals = true;

    // A click outside a picker's box closes its list. mousedown, so it lands
    // before the click — hence the guard: a click ON a row must not remove the
    // row before the click reaches it.
    document.addEventListener("mousedown", function (e) {
      eachInstance(function (inst) {
        if (!inst.open) return;
        if (e.target && e.target.closest && e.target.closest(".cp-wrap") === inst.wrap) return;
        close(inst);
      });
    });

    // A picker mounted in a hidden tab measured its chips at zero width, so the
    // names it could not fit are still whole. Both of these are the moment that
    // stops being true.
    document.addEventListener("tabselected", function () { eachInstance(fitNames); });
    var rt = null;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () { eachInstance(fitNames); }, 120);
    });

    var P = prof();
    if (P && P.onChange) {
      P.onChange(function () { eachInstance(paintSel); eachInstance(paintNote); });
    }
    var F = favs();
    if (F && F.onChange) F.onChange(function () { eachInstance(paintFavs); });
  }

  // ------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------

  function mount(hostEl, opts) {
    if (!hostEl) return null;
    opts = opts || {};
    injectStyle();
    wireGlobals();

    hostEl.className = "cp" + (opts.layout === "row" ? " cp-inline" : "") +
      (opts.className ? " " + opts.className : "");
    hostEl.innerHTML = markup(opts);

    var inst = {
      host: hostEl,
      opts: opts,
      wrap: hostEl.querySelector(".cp-wrap"),
      search: hostEl.querySelector(".cp-search"),
      results: hostEl.querySelector(".cp-results"),
      sel: hostEl.querySelector(".cp-sel"),
      favs: hostEl.querySelector(".cp-favs"),
      status: hostEl.querySelector(".cp-status"),
      note: hostEl.querySelector(".cp-note"),
      hits: [], active: -1, open: false, t: null
    };
    // Re-mounting the same host replaces its instance rather than stacking one.
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].host === hostEl) { instances.splice(i, 1); break; }
    }
    instances.push(inst);

    bind(inst);
    paintPlaceholder(inst);
    paintSel(inst);
    paintFavs(inst);
    paintNote(inst);

    return {
      host: hostEl,
      /** Repaint everything the shared state feeds. */
      refresh: function () { paintPlaceholder(inst); paintSel(inst); paintFavs(inst); paintNote(inst); },
      /** Put a sentence on this picker's own status line. */
      status: function (text, kind) { setStatus(inst, text, kind); }
    };
  }

  root.CharPicker = {
    mount: mount,
    /** The board snapshot, shared with every picker. Resolves [] when there is none. */
    board: ensureBoard,
    /** Repaint every mounted picker — for a host that changed the state directly. */
    refresh: function () { eachInstance(paintSel); eachInstance(paintFavs); eachInstance(paintNote); }
  };
})(window);
