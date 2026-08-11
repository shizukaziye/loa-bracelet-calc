/**
 * favorites.js — a tiny localStorage-backed "saved characters" store, shared by every
 * tab. Loaded BEFORE the tab modules so all of them can call window.Favorites at init
 * time. Ported from the astrogem calculator (loa-astrogem-calc/favorites.js), which has
 * carried this store since 2026-07; the only changes here are the key name and the
 * removal of its one-off cookie migration, which has no counterpart in this tool.
 *
 * Persistence: one localStorage key, `bc_favs`, whose value is
 *   JSON.stringify(list)
 * where `list` is an array of { region, name } (region upper-cased, name kept as
 * the user entered it). The list is UNLIMITED — there is no cap.
 *
 * localStorage, NOT a cookie: astrogem's cookie version hit the ~4KB header cap at
 * around 60 characters (a whole roster is saved at once) and silently dropped writes
 * past it — and it rode along on every request to the origin for no reason.
 *
 * Identity match (has / add dedupe / remove / toggle): same region
 * (case-insensitive) AND same name (case-insensitive, trimmed).
 *
 * Public API (window.Favorites):
 *   list()                  -> [{region, name}, ...]  (a fresh copy)
 *   has(region, name)       -> bool
 *   add(region, name)       -> bool  (false only if already present or blank name)
 *   remove(region, name)    -> bool  (true if something was removed)
 *   toggle(region, name)    -> bool  (the NEW state: true = now favorited)
 *   onChange(cb)            -> unsubscribe fn; cb runs after every change
 *
 * node-safe: when there's no `document` / `localStorage` (e.g. Node import for a
 * sanity check) the store falls back to in-memory only. It's a browser module in
 * practice.
 */
(function () {
  "use strict";

  var KEY = "bc_favs";           // localStorage key

  // ---- localStorage I/O (try-wrapped: a blocked/absent store degrades to in-memory) ----
  function readStore() {
    try {
      return (typeof localStorage !== "undefined") ? localStorage.getItem(KEY) : null;
    } catch (e) { return null; }
  }
  function writeStore(list) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {}
  }

  // Parse a raw JSON list into a clean list of {region, name}. Tolerates malformed
  // input and stray entries (a hand-edited store, or one written by an older build).
  function parseList(raw) {
    if (!raw) return [];
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(parsed)) return [];
    var out = [];
    for (var i = 0; i < parsed.length; i++) {
      var it = parsed[i];
      if (!it || it.name == null) continue;
      var region = String(it.region == null ? "" : it.region).toUpperCase();
      if (region === "CE") region = "EU"; // heal stores written before the import mapped bible's CE code
      var name = String(it.name);
      // skip dupes that may have crept into a hand-edited store
      if (indexOf(out, region, name) === -1) out.push({ region: region, name: name });
    }
    return out;
  }

  function loadList() { return parseList(readStore()); }

  // ---- identity (region case-insensitive; name case-insensitive + trimmed) ----
  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  function indexOf(arr, region, name) {
    var r = norm(region), n = norm(name);
    for (var i = 0; i < arr.length; i++) {
      if (norm(arr[i].region) === r && norm(arr[i].name) === n) return i;
    }
    return -1;
  }

  // The single in-memory copy, hydrated from the store on load.
  var items = loadList();

  // ---- change notification ----
  var listeners = [];
  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a bad subscriber must not break others */ }
    }
  }

  // ---- public API ----
  var Favorites = {
    list: function () {
      // hand back a defensive copy so callers can't mutate internal state
      return items.map(function (it) { return { region: it.region, name: it.name }; });
    },
    has: function (region, name) {
      return indexOf(items, region, name) !== -1;
    },
    add: function (region, name) {
      if (name == null || norm(name) === "") return false;
      if (indexOf(items, region, name) !== -1) return false; // dup
      items.push({ region: String(region == null ? "" : region).toUpperCase(), name: String(name) });
      writeStore(items);
      notify();
      return true;
    },
    remove: function (region, name) {
      var i = indexOf(items, region, name);
      if (i === -1) return false;
      items.splice(i, 1);
      writeStore(items);
      notify();
      return true;
    },
    toggle: function (region, name) {
      if (indexOf(items, region, name) !== -1) {
        this.remove(region, name);
        return false; // now not favorited
      }
      return this.add(region, name); // true once added (only fails on dup/blank)
    },
    onChange: function (cb) {
      if (typeof cb !== "function") return function () {};
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    }
  };

  if (typeof window !== "undefined") window.Favorites = Favorites;
  // node-safe export for an isolated require() (not used in the browser).
  if (typeof module !== "undefined" && module.exports) module.exports = Favorites;
})();
