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
- ~~**Support scoring stays a stub.** DPS-only, as speced.~~ **SUPERSEDED 2026-08-14.**
  Supports are real now — the house ap / brand / identity model, a role toggle in the
  deck and on the Tier List, and a rank ladder cut at the DPS ladder's own rarities.
  See `docs/research/support-model.md`.

- **Rule 6 above is now enforced, not remembered.** `npm run check` runs the two
  parity batteries, the worker battery, and `tools/check-cache-versions.mjs`, which
  fails the moment a changed script still carries its old `?v=`. That rule had already
  been missed twice — two of the three commits before the tool exists are manual
  "bump cache-busters" fixups — and the failure mode is silent wrong numbers rather
  than an error, because the browser happily runs a new `subrank.js` against an old
  `model/bracelet.js`.

## Open for Shizu — 2026-08-14

**1. The rank breakpoints.** `docs/research/score-distribution.md` has the exact
distribution on both axes, every 5 points and one point at a time through the top.
The damage dealer's ladder turns out to be a clean geometric rarity ladder already;
the only defect is the bottom, where F, F+ and F- hold 3.5% between them. Moving F to
20 and F+ to 25 fixes that and costs nothing else. Not done — his call. If it is
taken, rerun `tools/rank-match.mjs` and paste the support ladder it prints, because
the support cuts are derived from the DPS rarities.

**2. Supports on the leaderboard. LIVE, not hypothetical.** The seed carries no
supports, which is what I first checked and reported — but the live KV snapshot has
62 characters against the seed's 59, and two of them are Bards: **Limerent** and
**Na**, both NA. Both are ranked as damage dealers right now. The board scores
everyone on `normalizeProfile({})`, which is role "dps". It does not break loudly, which is
the problem. A near-perfect support bracelet (families 17, 19 and 30 at Legendary,
110/110 traits) reads:

| scored as | score | band | damage |
|---|---|---|---|
| a damage dealer, which is what the board does | 80.2 | A | 16.40% |
| a support | 106.3 | S+ | 6.85% |

The 16.40% is the tell: it counts the party-debuff halves of families 17 and 19 as
damage the support itself deals, which a support does not do. Fixing it needs two
decisions — map class to role (Bard, Paladin, Artist are the three), and then either
rank supports on their own board or interleave them on the support ladder so a
letter still means one thing. Neither is a call to make while he sleeps.

**3. A support's gold.** The damage side is right; the gold side still prices a
support like a solo damage dealer. A support's 1% lands on every dealer in the party,
so gold per damage should divide by party size — the astrogem calculator already does
this with `SUPPORT_GPD_MULTIPLIER`. Left alone because it triples every support Worth
figure, which is a product decision rather than a bug fix. Named in the Method tab so
nobody reads the number as finished.

**4. The Worker still needs a redeploy.** The model went to 0.3.0 and stored records
will not re-score until it ships. The seed on disk is already rescored (59/59).
