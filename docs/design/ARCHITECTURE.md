# Bracelet calculator — full system architecture

Written 2026-08-11 after a detailed reading of the astrogem calculator (worker + client)
and the bracelet research in `docs/research/`. This is the plan of record: grader
profile, leaderboard, repull, caching, queueing, and everything around them.

Companion docs — read before changing anything here:
- `docs/research/official-probabilities.md` — roll data, authoritative.
- `docs/research/damage-model-spec.md`, `baseline-derivation.md` — Shizu's model rulings.
- `docs/research/mechanics-bible-leaderboard.md` — payload decode + API facts.
- `docs/design/ui-overhaul.md` — the input UI as built.

---

## 0. The five decisions everything else follows from

1. **The worker ranks nothing.** It stores and ships raw bracelet payloads; the browser
   decodes and scores. Astrogem does this and it is why changing the damage model there
   never needs a re-scrape. Our model is young and will change often — this is worth
   more to us than it is to them.
2. **The leaderboard scores on the canonical default profile; the calculator scores on
   yours.** Two explicit code paths, labelled in the UI. Otherwise the board ranks gear,
   not bracelets.
3. **Every request to lostark.bible carries the authorization token. No exceptions.**
   That is the standing condition of Shizu's access (confirmed with molenzwiebel
   2026-08-11). An unauthenticated request is the violation — and is what earns a 429.
   Raid statistics remain banned outright.

   **Anyone may look up anyone, by name — decided 2026-08-11.** Character-page
   scraping is permitted at Shizu's discretion, and that permission is not limited to
   the caller's own characters. The Worker fetches with the CALLER's own token when
   they are signed in (better attribution, and the load spreads over many sign-ins)
   and with the `BIBLE_TOKEN` secret when they are not.

   The roster-ownership gate we shipped first — fetch only what a signed-in user owns
   — was **stricter than the permission we actually hold**. It was a default, picked
   because molenzwiebel means to make roster-only the only path *later*. It is off
   until he changes the API. The code that implements it is still there, wired to
   `POST /forget` only, because deleting somebody's row is not reading a public page.

   **This is a policy, not a bug.** A later session that finds `/character` open must
   not "restore" the gate as a fix. It reverts when molenzwiebel changes the API, and
   that call is Shizu's. Sign-in stays optional and must never become a wall on a
   lookup.

   With the gate off, the abuse controls are the only protection left, so they are
   load-bearing: per-IP lookup throttle, site-wide enqueue gate, hard cap, global
   gate, the ≥3s spacing floor, the monthly budget, the fail-streak breaker, the
   `nf:` markers and the 7-day cache.
4. **Favorites is the spine.** One sign-in → roster fetch → `Favorites.add` per
   character → every tab populates through `onChange`. No tab knows about OAuth.
5. **Politeness is a hard constraint, not a setting.** ≥3s between character-page
   fetches, globally serialized, enforced in the drain loop.

---

## 1. Data model

### 1.1 Character record (KV `CHARS`, key `<region>:<name>` lowercased)

```js
{
  region, name,            // region normalized ONCE at the router: CE -> EU (astrogem
                           // splits its cache on this and gets duplicate rows; we won't)
  class, itemLevel,
  bracelet: {              // null when the character has no bracelet equipped
    grade: "ancient"|"relic",
    stats: [ {type, index, value, fixed} ],   // RAW, exactly as the page gave it
    numRerolls, numTicketRerolls              // counts USED, not left (4/3 = fully rolled)
  },
  loadouts: [              // ONE PER lostark.bible TAB, each with its OWN bracelet
    { classification,      // "most_recent_raid" | "most_recent_chaos_dungeon" |
                           // "raid_merged" | whatever else turns up — an OPEN list
      label,               // bible's own button wording: "Raid" | "Chaos" | "Est. Raid"
      itemLevel, lastUpdated,
      isRendered,          // the page draws the NEWEST lastUpdated, not the raid one
      stats: [ … ], numRerolls, numTicketRerolls,
      score: { grade, pct, linesPct, granted, unmapped } }   // canonical default profile
  ],
  chosenLoadout: N,        // index of the HIGHEST — what the board ranks, and what
                           // `bracelet` above mirrors. 9 of 30 seeded characters carry
                           // different brackets per loadout, by up to 5.76pp.

  profile: {               // for grader auto-fill; EVERY FIELD OPTIONAL, and a field
                           // the page did not carry is absent rather than guessed
    itemLevel, classId, combatPower, apPoints,
    honing: {…}, advancedHoning: {…},          // six pieces; advanced is reported, not used
    neckAddDmg, earring1Wp, earring2Wp,        // accessory percentage lines
    gemLevel, gemLevels: [], gemCounts: [],    // modal level, every level, counts per level
    stone97, master,
    karmaWp,                 // % weapon power = karma.enlightenment ÷ 10
    apPct,                   // % attack power = battlePoint.parts[type 1].attackPowerMultiplier
    accessoryMainStat,       // the five accessories' base main stat, summed
    accessoryFlatAP,         // their "Attack Power +80/195/390" rolls, summed
    accessoryFlatWP,         // their "Weapon Power +195/480/960" rolls, summed
    raw: {…}                 // the unsnapped readings, the karma triple, the ark-grid
                             // cores, and what the gems alone make of apPct
  },
  source: "bible"|"seed"|"import",
  parseVersion: N,         // bump when the decoder changes; lets a rescore find stale rows
  warnings: [],
  pulledAt
}
```

Raw `stats` is the point. Decoding is a client concern and decoder bugs are then fixable
without refetching 60 characters.

The `profile` block is CARRIED, never applied. Loading a character fills the bracelet and
the banner, and seeds the economy (gold per 1% from combat power, baseline from the
bracelet they already wear). Everything else waits for "Import Character Stats" on the
character board. The calculator opens on its own defaults and returns to them on "Reset to
Default", so the number on screen is the number the board shows, until the user asks
otherwise.

NOT ON THE PAGE, and therefore never in this block: what the ark-grid CORES give in flat
attack or weapon power. The page names each core and totals the points its gems carry and
stops there, so `accessoryFlatAP` / `accessoryFlatWP` are the ACCESSORY halves only and the
deck keeps its own figure for the cores — with the import note saying which half is which.

### 1.2 Snapshot (leaderboard payload)

Compact, self-describing, gzipped, same shape discipline as astrogem's v2:

```js
{ v:1, builtAt,
  classes:[...],                                  // string table
  characters:[ [region, name, itemLevel, classIdx, pulledAt, grade, statsPacked] ] }
```

`statsPacked` = the raw stat tuples flattened to numbers (`type,index,value,fixed` × N).
A bracelet is ≤5 lines, so a row is ~25 numbers — an order of magnitude smaller than an
astrogem row. **We will not approach KV's 25 MiB value cap** (their plain JSON hit
26.1 MB at 5k characters and was 65 KB from silently failing), but gzip anyway: the
serving path is `encodeBody:"manual"` with `Content-Encoding: gzip`, and skipping that
flag double-gzips.

Ship the string tables *inside* the payload so client and worker can never drift.

---

## 2. Worker

`worker/bracelet.js`, `worker/wrangler.toml`, name `bracelet-bible`.
Bindings — **declare every one in the toml**; a CLI deploy replaces the whole binding
set and a dashboard-only namespace vanishes silently (astrogem lost one this way).

| Binding | Use |
|---|---|
| `CHARS` (KV) | character records, queue, snapshot, markers |
| `OAUTH` (KV) | anything token-bearing — kept separate so a prefix-less `list()` over CHARS can never read a session key into the public snapshot |
| rate limits | `HARD_CAP` 60/60s per IP · `LOOKUP_THROTTLE` 3/60s per IP · `LB` 3/60s per IP · `GLOBAL_GATE` 1000/60s fixed key · `IMPORT_GATE` (enqueue) 10/60s fixed key |
| cron | `* * * * *` — drain + snapshot rebuild |

Secrets (never in source): `BIBLE_TOKEN`, `ADMIN_TOKEN`.

### 2.1 Routes

Use real paths, not one overloaded `?param` namespace (astrogem's `?feedback=1` means
four different things depending on method and neighbouring params — a routing-mistake
factory).

| Method | Path | Auth | Does |
|---|---|---|---|
| OPTIONS | any | — | 204, before the hard cap so preflights are never throttled |
| GET | `/` | — | health |
| GET | `/character?region=&name=` | none (Bearer used if sent) | cached record, or enqueue. **Any name** — see §0.3 |
| POST | `/import` | none (Bearer used if sent) | enqueue each character; a signed-out batch is capped at 8 instead of 24 |
| POST | `/forget` | Bearer **+ ownership** | the one route that still proves the roster holds the name — it deletes |
| GET | `/list?fmt=1` | — | gzip snapshot bytes as-is |
| GET | `/wait?region=&name=&since=` | none | long-poll ≤25s; **pre-check before holding** — with the ownership check gone this pre-check is the whole defence (astrogem's version was a read amplifier: ~34 KV reads for any name) |
| POST | `/admin/seed` | `X-Admin-Token` | load `data/leaderboard-seed.json` |
| GET | `/admin/metrics` | `X-Admin-Token` | queue, drain log, budget, mode |
| POST | `/admin/control` | `X-Admin-Token` | drain mode/rate |
| POST | `/admin/dequeue` | `X-Admin-Token` | evict by key substring |

CORS: exact-match allowlist (`shizukaziye.github.io`, `www.loseii.com`, `loseii.com`,
localhost regex), stamped **once** in the exported `fetch` so no route can forget it.
Admin: `X-Admin-Token` header only, constant-time compare, **fail closed** when the
secret is unset. Never a client-shipped hash — astrogem's old `?k=` gate was the same
value `gate.js` shipped to every browser, so it gated nothing.

Validate `region.length<=8`, `name.length<=40` at the top. Astrogem doesn't, and several
of its `CHARS.get()` calls aren't try-wrapped, so an oversized key throws past the CORS
wrapper into a 500 with no CORS headers.

### 2.2 Fetch path

- URL `https://lostark.bible/character/{CE|NA}/{name}`, `encodeURIComponent` the name
  (our corpus has Astó, Phoënix, Lúo, Tîeria).
- `Authorization: Bearer` — the requester's own token, else `BIBLE_TOKEN`. **Never** to
  any other host, and **never absent**: with neither token the Worker makes no request
  at all rather than a naked one.
- Browser UA, `redirect: "follow"`.
- **`AbortSignal.timeout(10000)`.** Astrogem has no timeout anywhere; one hung
  connection eats the whole 50s drain budget.
- Classification: `404`/parse-failure → drop + `nf:` marker (1h) so a dead name can't
  re-enqueue forever. `401/403` → the fetch already retried a stale caller token on
  `BIBLE_TOKEN`, so this means BOTH were refused: drop the item (one bad sign-in must
  not freeze the queue) but count it toward the fail streak, so a dead secret trips the
  breaker in five instead of eating the queue silently. Other upstream 4xx → breaker.
  5xx/network → retry, max 5 attempts, preserving the stored token on requeue.

### 2.3 Cache policy

`CACHE_TTL = 7d` for freshness labelling. Serve cached at any age, tagged
`stale:true` past the TTL. **Do not auto-refetch stale records** — bracelets change
rarely and background churn is exactly the load we promised not to generate. The user
gets a Re-pull button; that is the refresh path.

Serve-stale-on-error is mandatory, not optional: lostark.bible **rate-limits Cloudflare
egress IPs specifically** — the worker sees 429 while a residential IP gets 200 for the
same page. An old record beats an error every time.

### 2.4 Queue and drain

One lane (`q:` — astrogem's premium lane is dead code that still costs a KV read on
every poll). Value holds the requester's token; metadata holds `{region,name,ts,attempts}`
— **metadata is read during `list()`, so it must stay token-free**.

Drain on the 1-minute cron:
- **Idle short-circuit** on a recently-empty `q:order` snapshot: one read instead of a
  lock write + two lists every idle minute (~130k writes/month saved at rest).
- `drain:lock` with `expirationTtl: 60` — **not 55**; KV's minimum is 60 and a smaller
  value makes the put throw into a silent catch, so the lock never engages.
- **Rate: ≤20/min hard ceiling, default 10/min** (≥3s spacing — Shizu's constraint).
- `DRAIN_BUDGET_MS = 50_000`, fail-streak breaker at 5 → `probe` mode with exponential
  re-probe, monthly budget guard.
- The **kick** (fetch one just-queued character directly, no `list()`) dodges KV list
  eventual consistency — without it a brand-new character is invisible to the drain that
  should pick it up. Keep it, and make it observe the same 3s spacing.

Every write path that stores a character calls `markDirty`.

### 2.5 Snapshot rebuild

- Throttle read **first** (one cheap `BUILTAT` get) before listing dirty markers — the
  outcome inside the window is "return" either way, and listing first costs ~43k
  lists/month for nothing.
- Incremental upsert from `lb:dirty:*`; full rebuild only when no snapshot exists, and
  **chunked** (≤750 records/tick, cursor parked in KV). Astrogem's unchunked version blew
  the 1,000-subrequest limit and left its board permanently empty.
- Clear only the markers you listed. A completed from-scratch build keeps all markers.
- Min interval 30 min from cron; 10 min when a user import triggers it.

---

## 3. Client

Shell stays as built: `index.html` with the tab bar, eager core + `LAZY_TABS`, `?v=`
bumps on every file (the loseii zone edge-caches JS for 4 hours — bumping is mandatory).

### 3.1 Favorites — the spine (`favorites.js`)

Port astrogem's almost verbatim; it is 170 lines and it is the whole cross-tab story.

```
list() has(r,n) add(r,n) remove(r,n) toggle(r,n) onChange(cb)->unsubscribe
```

One localStorage key `bc_favs`, `[{region,name}]`, identity case-insensitive on both
fields, `list()` returns a copy, subscribers wrapped in try/catch, CE→EU healed on parse.
**localStorage, not a cookie** — astrogem's cookie version silently dropped writes past
~60 characters at the 4KB header cap.

`favoriteRoster()` after sign-in is additive only, returns a count for the status line.

### 3.2 Calculator tab — the grader profile

Modes, mirroring the grader: **Manual** (what exists today) · **Pull** (region + name,
no sign-in needed) · saved-character chips.

Pull flow: `Econ.fetchCharacter` → cached hit renders instantly · `queued` shows position
and ETA → three concurrent mechanisms as astrogem does: a 1s local countdown (free), a
30s server re-sync, and a `/wait` long poll that clears the banner the instant the drain
lands. Completion gated on `pulledAt > since` so a stale hit can't masquerade as the
refresh.

**Profile auto-fill and provenance.** Adopt the Advisor's `unconfirmed` pattern rather
than the Grader's (the Grader has no provenance because its gems aren't editable — ours
are):
- Imported fields render with a marker class and a summary strip: *"Loaded from
  Paroxysmal — 4 values came from the character page."*
- Editing any field clears its marker for good; the strip's count drops.
- A "Reset to imported" and a "Reset to defaults" control.
- The gpd-note trick is the model for honest wording: astrogem says *"auto-set 2.5M from
  combat power"* until you touch it, then *"combat power suggests 2.5M"*. Copy that.

Imported: item level / honing, class, weapon power, main stat, crit rate, crit damage,
gem levels. Never imported: the fight shares, weights, and economy knobs (they are
judgment, not data).

### 3.3 Leaderboard tab

Lazy module, one fetch on first activation, plus **a real Refresh button** (astrogem's
`loadedOnce` is permanent for the page load, so a character you just pulled never
appears — a rough edge worth not inheriting).

- Rank by bracelet damage % **at the canonical default profile**, computed client-side
  from raw stats.
- Columns: rank · name (link) · class · grade · **damage %** · **gap to #1** · lines ·
  last pulled. The gap column is lostark.bible's own signature move and it reads well.
- Filters: region chips (persisted, with the never-persist-all-off guard), class select,
  name search (200ms debounce, searches the full region list and keeps true overall
  rank). Persist in **localStorage**, not cookies — astrogem's cookies ride on every
  request to the origin for no reason.
- `PAGE_SIZE = 100`, pager hidden below one page, page resets on any filter change.
- ★ Favorites section pinned above the table showing original ranks — this is also the
  "where am I" answer astrogem lacks.
- Row click loads that bracelet into the Calculator with **no refetch**.
- Four degradation messages: unconfigured · empty · HTTP error · network failure. A 429
  is **not** an error: show the note, keep the stale table.
- Footer disclosure: self-reported, opt-in, scored on default settings.

### 3.4 Explanation style

Keep both tooltip systems: `data-gloss`/`tip.js` for terms, a rich `data-tip` registry
popover for anything table-shaped. House rule from astrogem worth stating: **give the
verdict, show the arithmetic, then name what you left out** — and admit inconsistencies
in place (their method block says outright that per-gem numbers don't sum to the total,
*by design*). Ours has the same shape of admission to make about log-space scores.

---

## 3.5 Presentation — the polish inventory

Astrogem's finish is most of its perceived quality. Every item below is something it
does; the right column is our equivalent. Nothing here is optional decoration — the
loadout header alone is what makes a pulled character feel like *your* character.

| Astrogem | Bracelet equivalent |
|---|---|
| **Class icon** — `assets/class-icons/<Class>.svg`, 29 single-colour SVGs, `fill="currentColor"`, tinted `brightness(0) invert(.82)` | **Copy the folder verbatim.** Use in the profile header and as a leaderboard column. Unknown class → **no icon rather than a wrong one** (their `CLASS_SLUG` map marks only 8 of the API's slugs as verified) |
| **Profile panel** — favourite ★, class icon, 30px name linking to lostark.bible, cache pill, chips for region/class/ilvl | Same, plus chips for bracelet grade and rolls remaining |
| **Cache pill** — `Cached · pulled 2d ago` (dim) / `Freshly pulled` (green) / `Imported 3h ago` | Identical, and it doubles as the Re-pull affordance |
| **Three headline stats** — avg grade, avg rank badge, total % damage | Current % · expected final % · worth in gold (already built; restyle to their stat-row) |
| **Field rank** — "Top 8% of Bards (#4 of 51) · #37 of 6,214 tracked", conservative estimator, class line only when n≥5 | Same sentence off our own snapshot: "Top 12% of Reapers (#3 of 24) · #9 of 58 tracked" |
| **Weakest 3**, worst first, click to scroll + flash the card | **Weakest lines** — the rerollable ones ranked by what they cost you, click to focus that slot |
| **Rank badges + grade bands** (F−…S+, `SUBRANK_ORDINAL`) | We already grade families F→S; extend the same ladder to a whole-bracelet rank so a character gets one letter |
| **Raid vs Chaos preset toggle** | **There IS a 1:1 analogue after all**: lostark.bible keeps a raid loadout and a chaos loadout (and sometimes an estimated-raid one), each with its own bracelet, and 9 of 30 seeded characters wear different ones. The import panel shows them as pills; the board ranks the highest. **Compare mode** — your current bracelet vs a candidate you're pricing — is still the other axis. See below |
| **DPS / Support axis toggle**, auto-detected from the build | Deferred with support scoring; keep the toggle's slot in the layout so it can appear later without a redesign |
| **`gpd` auto-set from combat power**, with wording that downgrades from "auto-set" to "suggests" once you touch it | Same trick for every imported profile value (§3.2) |
| **Method `<details>` per tab**, verdict → arithmetic → what's left out, admitting inconsistencies in place | Already built; extend as features land |
| **Flash-on-focus** (`void el.offsetWidth` to restart the animation) | Same, for slot cards |
| **Mobile: zero `<col>` widths, never `display:none` on a middle cell** (it shifts the rest off their columns) | Copy exactly — same table shape |
| **`onclick =` not `addEventListener`** on re-rendered containers (theirs stacked handlers and made one click fire N times) | Copy the discipline; our result pane re-renders constantly |

### Compare mode — the preset analogue

Raid/Chaos exists because a character owns two gem sets — and, it turns out, two
bracelets, one per loadout; that axis is the loadout pills in the import panel. The
remaining axis is **the bracelet you have vs the one you're considering**:

- Slot A = imported/current, slot B = hand-entered candidate.
- Header shows both scores, the delta in % and gold, and the DP's verdict on B's
  remaining rolls.
- This is the feature the tool is actually *for* — pricing a purchase — and it reuses
  the whole existing panel. Same toggle affordance as their preset pills.

## 3.45 Tier List tab (Shizu, 2026-08-11)

"All the different effects with their damage percentage, and the character & bracelet
customizer carried over so people can adjust and watch the tier list change."

**Why it's easy:** ranking effects is pure scoring — no DP, no worker. 99 rows score in
well under a millisecond, so this tab recomputes **live on every slider drag**, unlike the
Calculator which must debounce into a worker. That immediacy is the whole appeal: drag
Back share to 0 and watch the positional lines fall through the table.

### Shared profile state — the prerequisite

The customizer currently lives inside `app.js`. Extract it to **`profile.js`**, a spine in
the same shape as `favorites.js` (which is the proven pattern here):

```
Profile.get() -> the normalized profile + bracelet state
Profile.set(patch)             // merge + persist + notify
Profile.mount(hostEl, opts)    // render the control deck into any tab
Profile.onChange(cb) -> unsubscribe
Profile.reset()
```

One localStorage key, one source of truth. Calculator and Tier List each `mount()` it and
subscribe; a slider moved on either tab moves it on both. This also sets up any later tab
for free — the same reason Favorites pays for itself.

### As built (Fable, phase 1)

```
Profile.get()        -> the LIVE state object; its identity never changes, not even
                        across reset(), so a module may hold the reference forever
Profile.profile()    -> Bracelet.normalizeProfile(...) over that state
Profile.set(patch)   // merge (one level deep for adv/gear/ov/econ/kit/fight/traits),
                     // fit, persist, re-render, notify
Profile.mount(host)  // MOVE the one deck into host
Profile.onChange(cb) -> unsubscribe; cb(detail) with {path, shape, immediate, reset}
Profile.reset()
```

Plus the maintenance and derived helpers every tab needs: `save` `fit` `render`
`blankRow` `ilvl` `baseStats` `wpPct` `baseApPct` `traitBand` `traitValues`
`traitWeights` `traitOnCount` `famGrades` `letterOf` `GRADE_COLOR` `JUNK`
`applyImported` `provCount` `character` `setCharacter` `onAdvancedRender`.

**One deck, re-parented — not two instances.** Every control's id is derived from its
state path (`bc-fld-gear-head`), and focus restoration, the mid-drag chip repaint and the
derived read-outs all find their element by that id. Two live decks would mean two
elements per id and `$()` repainting the wrong one; making that safe means prefixing every
id and re-rendering both decks on every keystroke — a large change to code that has to
behave exactly as it did before. So `mount(host)` **moves** the single deck element
(`appendChild` on a node already in the document re-parents it, listeners and all), and a
tab claims it on activation. `app.js` re-mounts on `tabselected` for `calculator`; the Tier
List does the same in its own pane. Only one tab is visible, so nothing is lost.

**Where the seam runs.** Profile owns the state, the deck and everything derived from the
character. `app.js` owns the bracelet — rows, fixed rows, locks, the rolled set, the
history — and mutates `Profile.get()` in place, then calls `Profile.save()`. The one place
they interleave is the Advanced fold's fixed-line editor, which is a deck control holding
bracelet rows: Profile renders the fold and calls `onAdvancedRender` hooks,
and `app.js`'s hook fills `#bc-fixedrows` with its own pickers.

### What it ranks

Two views, one toggle:

1. **By family** (33 rows, the default) — each family scored at its **odds-weighted
   average** (tiers 6:3:1 → 0.6/0.3/0.1), which answers *"is landing on this family
   good?"*. This is the same number `familyGrades()` already computes for the picker, so
   the picker letters and the tier list can never disagree.
2. **By roll** (99 rows) — every family×tier separately, answering *"what is this exact
   roll worth?"*. Rarity-coloured (Rare blue / Epic purple / Legendary gold).

Each row: tier letter · family name · the damage % · a bar · the roll values · and the
odds of getting it (from the official listed probabilities, renormalized). Showing
**value beside rarity** is the point — a Legendary junk line and a Rare crit line sit far
apart, and that's the lesson the table teaches.

### Banding — reuse the loa-tierlist house style

Shizu's tier-list site (`loastuff/loa-tierlist`) already fixes this: **bands as a % of
#1** — S ≥98 · A ≥95 · B ≥90 · C ≥85 · D ≥80 · F <80 — with empty bands rendered
explicitly rather than skipped. Study it and match: the S-tier rainbow slide, the dot
strip, the hover card popovers, the band pills. A user who knows that site should
recognise this tab instantly.

Note the bands here are relative to the best *family*, so they move as the profile
changes — that is the feature. Call it out in the copy: "bands are % of the best line
for **your** character."

### Interactions

- Row hover → popover: full effect text, all three tiers with values and odds, what it's
  worth to you, and why (the same `data-tip` registry pattern).
- Row click → drop that effect into a Calculator slot ("try this").
- A "compare to defaults" ghost marker showing where the line sits on the canonical
  profile, so a user can see *how their build differs from average* — cheap, since
  default scores are already computed for the leaderboard.
- Preset buttons for common builds (back-attack class, frontal, non-positional) that just
  set the shares — the fastest way to show the table is alive.

## 3.6 Feedback tab

A lazy tab (`feedback.js`), public, no sign-in. Copy astrogem's shape and its guards.

**Client** — type select (bug / wrong number / feature / other), message textarea,
optional contact field. Success and failure both answer in place; never a modal.

**Worker** — `POST /feedback`:
- **Honeypot field `hp`**: if filled, accept-and-drop silently.
- Its own throttle key in the shared per-IP namespace (`fb:<ip>`, 2/10s). Astrogem added
  this after noticing feedback was *the one write path with no limit beyond the hard cap*.
- Caps: message 2000 chars, type 40, contact 80, UA 160 — truncate, don't reject.
- Key `fb:<ts>-<rand6>`. The millisecond timestamp makes **lexicographic key order
  chronological**, so the tail of a `list()` is the newest and the admin read is bounded
  at ≤200 gets. An unbounded read-all was on a path to the 1,000-op limit.
- **TTL 90 days.** The field can hold contact PII and must not sit forever.

**Admin** — `GET /admin/feedback` returns newest ≤200 plus `total` and `unread` so the UI
can say "showing 200 of N"; `POST /admin/feedback` marks read or deletes.

## 3.7 Admin surface — queue and drain

Astrogem drives this with `curl` and an `X-Admin-Token` header. At our scale a tiny page
is worth the hour: one HTML file, **not linked from the nav**, asking for the token at load.

**The token rule, learned from their `gate.js` incident:** the admin credential is typed
at runtime and held in `sessionStorage` only. Never in the page source, never in a URL,
never in a query param — a hash shipped to every browser gates nothing, and a token in a
URL leaks through logs and `Referer`. Header only, constant-time compare, fail closed.

**`GET /admin/metrics`** — one call, renders:

| Panel | Contents |
|---|---|
| Queue | depth, and the waiting list (region · name · waited) capped at 500. A front-sentinel requeue (`ts:1`) shows waited as `—`, not a 57-year wait |
| Drain | mode (`run`/`off`/`probe`), rate per minute, last run, month's budget used vs cap |
| Log | the rolling 1-hour `drain:log`: per run `cached[]/dropped[]/failed[]`, stop reason (`full` `time` `budget` `blocked` `paused` `probe` `resumed`), duration. **Do-nothing runs are not logged** — liveness shows in queue depth |
| Health | last successful upstream pull, last snapshot build, whether the probe token is armed (**boolean only — never return the token**) |

**Controls** — all `POST`, never `GET`. A `GET` with side effects is a drive-by risk: any
`<img>` tag could freeze the queue.
- `POST /admin/control {mode, rate}` — `rate` clamped 1–20 (our ≥3s floor), `mode`
  validated against the enum. Switching out of `off` kicks a drain via `waitUntil`.
- `POST /admin/dequeue {match|all}` — evict by **key substring**, deliberately: some
  queued names are mojibake and their key can't be rebuilt from a clean string. Always
  delete the order snapshot afterwards.
- `POST /admin/seed` — load `data/leaderboard-seed.json`.
- `POST /admin/rescore` — bump `parseVersion` to mark rows for client rescoring. Cheap,
  because the worker stores raw stats; no refetch.

**Deliberately absent:** any bulk-backfill trigger. Enqueuing thousands of characters must
not be one button press away — that is a conversation with lostark.bible, not a button (§4).

---

## 4. Repull policy

| Trigger | Behaviour |
|---|---|
| User clicks Re-pull | `refresh=1`, bypasses cache, no sign-in needed (§0.3); pays the per-IP throttle like any fresh lookup |
| Record older than 7d | labelled `stale`, **not** auto-refetched |
| Decoder version bump | `parseVersion` mismatch → client rescoring is enough; refetch only if raw stats are insufficient |
| Bulk backfill | **not built.** 17.8k characters is a conversation, not a feature |

Astrogem's `?refresh=1` is silently a no-op when the character is already queued; ours
must either honour it or say "already queued, position N".

---

## 5. Build order

1. Worker skeleton + `/character` + `/import` + KV cache. *(built; the consent gate it
   originally carried came off 2026-08-11 — §0.3)*
2. `favorites.js` + sign-in → roster → star → saved-character chips.
3. Grader pull flow with queue/wait UI.
4. Snapshot + `/list` + Leaderboard tab (seed the 58 entries via `/admin/seed`).
5. Profile auto-fill with provenance markers.
6. Drain, breaker, metrics, admin controls.

Ship 1–4 before 5–6 if time is short: a board that fills and a calculator that imports
are the whole product; the drain machinery only matters once more than a handful of
people use it.

---

## 6. Inherited lessons — the short list

Cheap to honour now, expensive to discover later. All were real incidents in astrogem.

- KV `list()` is eventually consistent — never rely on it for a just-written key.
- KV minimum `expirationTtl` is 60s; below it the put throws.
- KV value cap 25 MiB; gzip and serve bytes with `encodeBody:"manual"`.
- ~1,000 subrequests per invocation; chunk any full rebuild.
- `wrangler deploy` replaces all bindings; declare them in the toml.
- lostark.bible rate-limits Cloudflare egress IPs; serve stale on error.
- Preserve the requester's token across a requeue or the retry 401s.
- A token in queue *metadata* leaks into `list()`; keep it in the value.
- Sessions in a separate namespace from characters.
- Admin: header-only, constant-time, fail-closed, POST for mutations.
- Normalize CE→EU once, at the router.
- Timeout every upstream fetch.
