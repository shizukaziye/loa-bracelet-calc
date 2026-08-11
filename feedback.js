/**
 * feedback.js — the Feedback tab. One small form: what kind of note, the note
 * itself, an optional way to reach you back. Loaded lazily on first visit to the
 * tab (see LAZY_TABS in index.html); renders once into #tab-feedback.
 *
 * SHAPE, copied from the astrogem calculator and its guards (ARCHITECTURE §3.6):
 *   POST <worker>/feedback  {type, message, contact, hp}
 *   - `hp` is a honeypot: off-screen, empty for a human, filled by a form-filling
 *     bot. The Worker accepts those and drops them silently, so a bot gets no
 *     signal it was caught. Nothing here validates it — the client must not know.
 *   - The caps below MIRROR the Worker's (message 2000, contact 80, type 40) and
 *     TRUNCATE rather than reject. A note that is one character too long should
 *     lose the character, not the note.
 *
 * FOUR STATES, all answered in place. Never a modal, never a page move:
 *   unconfigured  no WORKER_URL — the honest sentence plus the GitHub fallback
 *   sending       the button is out, the status line says so
 *   sent          the panel becomes a thank-you with "send another"
 *   error         the button comes back, the status line says what to do
 *
 * NETWORK RULE, ABSOLUTE. This file talks to ONE host: the bracelet Worker. It
 * never touches lostark.bible, and it never reads or reports raid statistics.
 */
(function (root) {
  "use strict";

  /**
   * The deployed bracelet-bible Worker (worker/bracelet.js). EMPTY until it is
   * deployed and the printed URL is pasted here — see docs/deploy-worker.md.
   * Kept in sync BY HAND with bible-import.js and leaderboard.js, which hold the
   * same constant. Empty is a supported state, not a bug: the tab then says so
   * and points at GitHub issues, which needs no server at all.
   */
  var WORKER_URL = "";

  /** Where a note goes when there is no Worker to take it. */
  var ISSUES_URL = "https://github.com/shizukaziye/loa-bracelet-calc/issues";

  /** Caps mirroring the Worker's. Over the cap TRUNCATES; nothing is refused. */
  var MSG_MAX = 2000, CONTACT_MAX = 80, TYPE_MAX = 40;

  /* The four kinds of note, in the order people actually send them. `value` is
     what the Worker stores; the label is what the tab shows. */
  var TYPES = [
    { value: "bug", label: "Bug — something is broken" },
    { value: "wrong-number", label: "Wrong number — the model is off" },
    { value: "feature", label: "Feature — something is missing" },
    { value: "other", label: "Other" }
  ];

  var state = "";        // "" | unconfigured | idle | sending | sent | error
  var draft = null;      // {type, message, contact} kept across a re-render

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function pane() { return document.getElementById("tab-feedback"); }
  function cap(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }

  var CSS =
    "<style>" +
    "#tab-feedback .fbwrap{max-width:620px}" +
    "#tab-feedback .fbwrap p{font-size:13.5px;line-height:1.6;color:var(--dim)}" +
    "#tab-feedback label.fbl{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin-bottom:4px}" +
    "#tab-feedback .fbfield{margin-bottom:12px}" +
    "#tab-feedback textarea,#tab-feedback input.fbi,#tab-feedback select.fbi{" +
    "background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;" +
    "padding:7px 9px;font-size:13px;font-family:inherit;width:100%;max-width:100%}" +
    "#tab-feedback textarea{resize:vertical;min-height:120px;line-height:1.55}" +
    "#tab-feedback textarea:focus,#tab-feedback input.fbi:focus,#tab-feedback select.fbi:focus{outline:1px solid var(--accent)}" +
    "#tab-feedback .fbleft{text-align:right;font-size:11px;color:var(--dim);margin-top:3px;font-variant-numeric:tabular-nums}" +
    "#tab-feedback .fbleft.low{color:var(--high)}" +
    "#tab-feedback .fbrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}" +
    "#tab-feedback .fbstatus{font-size:13px;min-height:19px}" +
    "#tab-feedback .fbnote{background:var(--panel2);border:1px solid var(--border);border-radius:8px;" +
    "padding:11px 13px;margin:0 0 14px}" +
    "#tab-feedback .fbnote p{margin:0;color:var(--text)}" +
    "#tab-feedback a.fblink{color:var(--accent)}" +
    /* The honeypot. Off-screen rather than display:none — some bots skip hidden
       fields but happily fill one that is merely parked outside the viewport. */
    "#tab-feedback .fbhp{position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none}" +
    "</style>";

  /** Read whatever is on screen, so a re-render does not eat someone's typing. */
  function readDraft() {
    if (!$("fb-msg")) return draft;
    draft = {
      type: $("fb-type") ? $("fb-type").value : TYPES[0].value,
      message: $("fb-msg").value,
      contact: $("fb-contact") ? $("fb-contact").value : ""
    };
    return draft;
  }

  function typeOptions(sel) {
    return TYPES.map(function (t) {
      return '<option value="' + esc(t.value) + '"' + (t.value === sel ? " selected" : "") + ">" + esc(t.label) + "</option>";
    }).join("");
  }

  /** The form. Rendered for every state except "sent" and "unconfigured". */
  function renderForm() {
    var p = pane(); if (!p) return;
    var d = draft || { type: TYPES[0].value, message: "", contact: "" };
    p.innerHTML = CSS +
      '<div class="panel fbwrap">' +
      "  <h2>Leave feedback</h2>" +
      "  <p>A wrong number, a missing effect, a bug, or an idea — all of it lands here. " +
      "  Say which bracelet or which figure looked wrong and it is far easier to chase. " +
      "  Contact is optional; leave one if you want an answer.</p>" +
      '  <div class="fbfield">' +
      '    <label class="fbl" for="fb-type">Kind</label>' +
      '    <select class="fbi" id="fb-type">' + typeOptions(d.type) + "</select>" +
      "  </div>" +
      '  <div class="fbfield">' +
      '    <label class="fbl" for="fb-msg">Your note</label>' +
      '    <textarea id="fb-msg" rows="7" maxlength="' + MSG_MAX + '" ' +
      '      placeholder="What happened, and what did you expect instead?">' + esc(d.message) + "</textarea>" +
      '    <div class="fbleft"><span id="fb-left">' + (MSG_MAX - d.message.length) + "</span> characters left</div>" +
      "  </div>" +
      '  <div class="fbfield">' +
      '    <label class="fbl" for="fb-contact">Name or Discord <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
      '    <input class="fbi" id="fb-contact" type="text" maxlength="' + CONTACT_MAX + '" ' +
      '      placeholder="optional" autocomplete="off" value="' + esc(d.contact) + '">' +
      "  </div>" +
      // Honeypot. Humans never see it, so a value in it is a bot; the Worker
      // takes the note and drops it. aria-hidden + tabindex keep it off the
      // keyboard path and out of a screen reader.
      '  <input class="fbhp" id="fb-hp" name="hp" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '  <div class="fbrow">' +
      '    <button class="primary" id="fb-send">Send feedback</button>' +
      '    <span class="fbstatus" id="fb-status"></span>' +
      "  </div>" +
      "</div>";

    var msg = $("fb-msg"), left = $("fb-left");
    msg.addEventListener("input", function () {
      if (msg.value.length > MSG_MAX) msg.value = msg.value.slice(0, MSG_MAX);  // truncate, never refuse
      var rem = MSG_MAX - msg.value.length;
      left.textContent = rem;
      left.parentNode.className = "fbleft" + (rem <= 100 ? " low" : "");
    });
    $("fb-contact").addEventListener("input", function () {
      var c = $("fb-contact");
      if (c.value.length > CONTACT_MAX) c.value = c.value.slice(0, CONTACT_MAX);
    });
    $("fb-send").addEventListener("click", submit);
  }

  /** No Worker. Say it plainly and hand over the fallback that needs no server. */
  function renderUnconfigured() {
    var p = pane(); if (!p) return;
    p.innerHTML = CSS +
      '<div class="panel fbwrap">' +
      "  <h2>Leave feedback</h2>" +
      '  <div class="fbnote"><p>The form here needs the fetch service, which is not deployed yet, ' +
      "  so there is nothing to send a note to. Nothing is lost in the meantime — open an issue on " +
      "  GitHub and it goes to the same place.</p></div>" +
      "  <p>A wrong number, a missing effect, a bug or an idea are all welcome. " +
      "  Saying which bracelet or which figure looked wrong makes it far easier to chase.</p>" +
      '  <div class="fbrow">' +
      '    <a class="primary" id="fb-issues" href="' + ISSUES_URL + '" target="_blank" rel="noopener noreferrer" ' +
      '       style="text-decoration:none;display:inline-block">Open a GitHub issue</a>' +
      '    <span class="fbstatus"><a class="fblink" href="' + ISSUES_URL + '" target="_blank" rel="noopener noreferrer">' +
      esc(ISSUES_URL.replace(/^https:\/\//, "")) + "</a></span>" +
      "  </div>" +
      "</div>";
  }

  /** Sent. The panel answers in place and offers another go. */
  function renderSent() {
    var p = pane(); if (!p) return;
    p.innerHTML = CSS +
      '<div class="panel fbwrap">' +
      "  <h2>Thanks</h2>" +
      '  <p style="color:var(--text)">Your note went through. It is read, even when there is no reply — ' +
      "  and a wrong number gets chased first.</p>" +
      '  <div class="fbrow"><button class="primary" id="fb-again">Send another</button></div>' +
      "</div>";
    $("fb-again").addEventListener("click", function () {
      draft = null;
      setState("idle");
    });
  }

  /**
   * The one state switch. `sending` and `error` keep the form and its typing;
   * `sent` and `unconfigured` replace the panel. Nothing here opens a dialog.
   */
  function setState(next, message) {
    state = next;
    if (next === "unconfigured") { renderUnconfigured(); return; }
    if (next === "sent") { renderSent(); return; }
    if (!$("fb-msg")) renderForm();                 // idle, or a state that needs the form back
    var btn = $("fb-send"), st = $("fb-status");
    if (!btn || !st) return;
    if (next === "sending") {
      btn.disabled = true;
      st.style.color = "var(--dim)";
      st.textContent = message || "Sending…";
    } else if (next === "error") {
      btn.disabled = false;
      st.style.color = "var(--bad)";
      st.textContent = message || "Could not send — please try again in a moment.";
    } else {
      btn.disabled = false;
      st.style.color = "var(--dim)";
      st.textContent = message || "";
    }
  }

  function submit() {
    var d = readDraft();
    var message = cap(d.message, MSG_MAX).trim();
    if (!message) { setState("error", "Please write something first."); return; }
    if (!WORKER_URL) { setState("unconfigured"); return; }

    var payload = {
      type: cap(d.type, TYPE_MAX),
      message: message,
      contact: cap(d.contact, CONTACT_MAX).trim(),
      hp: $("fb-hp") ? $("fb-hp").value : ""       // honeypot rides along untouched
    };
    setState("sending");
    fetch(WORKER_URL.replace(/\/+$/, "") + "/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.status === 429) throw new Error("Too many notes just now — give it a minute and try again.");
      if (!r.ok) throw new Error("The service answered " + r.status + ". Please try again in a moment.");
      return r.json().catch(function () { return {}; });
    }).then(function () {
      draft = null;
      setState("sent");
    }).catch(function (e) {
      setState("error", (e && e.message) || "Could not send — please try again in a moment.");
    });
  }

  function render() {
    var p = pane();
    if (!p || p.getAttribute("data-init")) return;
    p.setAttribute("data-init", "1");
    setState(WORKER_URL ? "idle" : "unconfigured");
  }

  document.addEventListener("tabselected", function (e) {
    if (e && e.detail && e.detail.tab === "feedback") render();
  });
  if (document.querySelector("#tab-feedback.active")) render();

  /**
   * Small surface for the console and for checks: which Worker this points at,
   * which state the panel is in, and a way to drive it. `state()` with an
   * argument forces a state without a round trip — that is how the four states
   * get looked at with no Worker deployed.
   */
  root.BraceletFeedback = {
    workerUrl: function () { return WORKER_URL; },
    render: render,
    state: function (s, msg) {
      if (s == null) return state;
      var p = pane(); if (p) p.setAttribute("data-init", "1");
      setState(s, msg);
      return state;
    },
    LIMITS: { message: MSG_MAX, contact: CONTACT_MAX, type: TYPE_MAX }
  };
})(window);
