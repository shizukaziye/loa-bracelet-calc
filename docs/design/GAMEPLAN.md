# Gameplan — catch the bracelet calculator up to astrogem

Written 2026-08-11 (Fable) for an overnight autonomous run. Shizu is asleep; no
questions possible, so every open choice is decided here and recorded.

## What "complete" can mean tonight

Two things need Shizu and cannot be done:

- **No character fetching.** The authorization token is not on disk (`.bible-token`
  absent) and every request must carry it. So: **zero requests to lostark.bible tonight**,
  for any reason, by any agent. The 29-page corpus already on disk is the working set;
  the remaining 28 names wait for him.
- **No worker deploy.** KV namespaces and secrets live on his Cloudflare account.

So the target is: **everything built, verified, deployed to GitHub Pages, and working
end-to-end without the worker** — with the worker one `wrangler deploy` away.

The enabling decision: **the leaderboard reads baked seed data by default and switches
to the worker when `WORKER_URL` answers.** Same pattern as `loa-deal-finder`, which bakes
its data into the page. He wakes up to a live board, not a placeholder.

## Order of work

Serialised where files collide, parallel where they don't. `app.js` and `index.html` are
the contention points, so exactly one agent owns them at a time.

**Phase 0 — finish in flight.** The multi-loadout re-parse (offline, saved pages only).
Its output rewrites `data/leaderboard-seed.json` with all loadouts per character and a
`chosenLoadout` = highest score. Everything downstream depends on that shape.

**Phase 1 — shell and spine.** One agent owns `app.js` + `index.html`.
- Port `favorites.js` and `tip.js` verbatim from astrogem; copy the 29 class icons.
- Extract the character/bracelet customizer out of `app.js` into **`profile.js`**
  (`get/set/mount/onChange/reset`, one localStorage key) so every tab drives one state.
- Wire the tab bar for Calculator · Tier List · Leaderboard · Method · Feedback, with the
  lazy-loader and `?v=` discipline.
- Port the profile header: class icon, name link, cache pill, chips.

**Phase 2 — three tabs in parallel** (each owns one new file; I add script tags).
- **Leaderboard** (`leaderboard.js`): astrogem's structure, our columns — rank, name,
  class icon, grade, damage %, gap to #1, lines, last pulled. Region/class filters
  persisted in localStorage, name search, `PAGE_SIZE` 100, pinned ★ favourites section
  with true ranks, four degradation messages, a real Refresh button, self-reported
  footer. Data source: baked seed → worker when available.
- **Tier List** (`tierlist.js`): all 33 families and all 99 rolls ranked, live on every
  slider drag (pure scoring, no worker), loa-tierlist banding (S ≥98 … F <80 of the best
  line), hover cards, click-to-try.
- **Worker** (`worker/`): fork astrogem's worker as the literal starting point; strip gem
  parsing; keep queue/drain/breaker/snapshot/rate-limits/CORS/admin; swap in the bracelet
  parser and the raw-payload record; apply the audit fix list — timeout on every fetch,
  CE→EU normalised once at the router, drop the dead premium lane, name/region length
  caps, real paths instead of overloaded query params.

**Phase 3 — integration.** Script tags, cache-bust bumps, browser verification at desktop
and 375px, both verify batteries green, then push to GitHub Pages and confirm live.

## Standing rules for every agent

1. **No network requests to lostark.bible.** Not one. No token, no fetching.
2. **Raid statistics are banned** — never referenced, never fetched, never served.
3. The client talks only to our worker; only the worker may talk to lostark.bible, and
   only with the token.
4. `node verify.js` and `python verify.py` must both end green (1601+).
5. Plain ES5-flavoured IIFEs, zero dependencies, no build step, dark-only house style.
6. Bump `?v=` on every touched file — the loseii zone edge-caches JS for four hours.
7. Commit at the end of each phase; do not push (I handle the deploy).
8. Never invent data. A missing character is missing.

## Decisions made on Shizu's behalf (flag at wake-up)

- **Demon toggle stays OFF by default.** The evidence says bible counts it and turning it
  on aligns us with their numbers, but it changes every leaderboard score and he has been
  asked twice without answering. Not a call to make while he sleeps. The tier list makes
  the consequence visible, which is the better way to settle it.
- **Seed data ships.** He confirmed scraping is permitted with the token, and told
  molenzwiebel about the project. The board carries the self-reported disclosure.
- **Support scoring stays a stub.** DPS-only, as speced.
