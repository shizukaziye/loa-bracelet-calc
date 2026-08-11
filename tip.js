/**
 * tip.js — one instant, styled tooltip for any [data-gloss] element (abbreviations etc.).
 * Replaces the native title= tooltip's hover delay. A single floating #gm-tip node is
 * positioned on hover via delegated events, so it works across tabs and inside scroll
 * containers without being clipped. Touch screens have no hover, so a TAP toggles the
 * same tooltip (tapping elsewhere hides) — deliberately no title= fallback, which would
 * double-tooltip on desktop. Distinct from the pipeline's data-tip / .pl-pop popup.
 */
(function () {
  "use strict";
  var tip = null, cur = null;   // cur = the element the tooltip is currently shown for
  var lastTouch = 0;            // a tap also fires synthetic mouseover/mouseout/click — suppress them
  function node() {
    if (!tip) { tip = document.createElement("div"); tip.id = "gm-tip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip); }
    return tip;
  }
  function show(el) {
    var txt = el.getAttribute("data-gloss");
    if (!txt) return;
    var t = node();
    t.textContent = txt;                       // visibility:hidden still lays out, so we can measure
    t.style.left = "0px";                      // reset BEFORE measuring — parked at the previous spot,
    t.style.top = "0px";                       // the viewport edge would clamp the shrink-to-fit width
    var r = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
    var top = r.top - tr.height - 8;
    if (top < 4) top = r.bottom + 8;           // flip below if it would clip the top
    var left = Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 6));
    t.style.top = top + "px";
    t.style.left = left + "px";
    t.classList.add("on");
    cur = el;
  }
  function hide() { if (tip) tip.classList.remove("on"); cur = null; }
  function touched() { return Date.now() - lastTouch < 700; }
  document.addEventListener("mouseover", function (e) { if (touched()) return; var el = e.target.closest ? e.target.closest("[data-gloss]") : null; if (el) show(el); });
  document.addEventListener("mouseout", function (e) { if (touched()) return; var el = e.target.closest ? e.target.closest("[data-gloss]") : null; if (el) hide(); });
  // Touch: tap a [data-gloss] to show its tooltip, tap it again — or anywhere else — to
  // hide. lastTouch keeps the tap's synthetic mouse/click events from undoing the toggle.
  document.addEventListener("touchend", function (e) {
    lastTouch = Date.now();
    var el = e.target.closest ? e.target.closest("[data-gloss]") : null;
    if (el && el !== cur) show(el); else hide();
  });
  document.addEventListener("click", function () { if (!touched()) hide(); }, true);
  window.addEventListener("scroll", hide, true);
})();
