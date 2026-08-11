# Lost Ark T4 bracelet calculator

Scores a T4 bracelet in percent damage for your character, and solves the reroll
decision exactly — which lines to lock, whether to keep or replace what you just
rolled, and what an unrolled bracelet is worth in gold.

Part of the loseii family of tools. Plain static files: no framework, no build
step, no dependencies.

## Where things are

| Path | What it holds |
|---|---|
| `data/bracelet-data.js` | The official Stove probability tables, transcribed. Both grades, 33 special families, basic and combat-trait bands, line counts, category weights, caps. |
| `data/gear-data.js` | The Serca honing table and the gear constants that turn an item level into weapon power and main stat. |
| `model/bracelet.js` | The pure core on `window.Bracelet`: scoring, pool builder, solver, payload decoder. No DOM, no I/O. |
| `model/bracelet.py` | Python mirror of the same, kept in lockstep by the parity battery. |
| `data/*.py` | Python mirrors of the two data files. |
| `refs.json` | Captured reference values, generated from the JS core. |
| `verify.js` / `verify.py` | The parity battery. Both must pass. |
| `index.html`, `styles.css`, `tip.js` | The app shell. Phase 1 ships the shell only; the panes are empty. |
| `docs/research/` | The research the model is built on. The official probability doc wins on any roll-value conflict. |

## Running it

```
npm run serve      # http://localhost:8080  (port 8080 is required — the
                   # lostark.bible OAuth dev redirect only whitelists that one)
npm run verify     # node verify.js
npm run verify-py  # python verify.py
npm run genrefs    # regenerate refs.json from the JS core
```

## How a bracelet is scored

Damage is multiplicative, so every line is scored in log space as
`D = 100 · ln(multiplier)` — roughly the percent damage it adds, and additive
across lines. The exact combined figure is `(e^(D/100) − 1) · 100`. Same
convention as the accessory and astrogem calculators, so the three agree.

Nothing is hardcoded per tier. Every number falls out of your character:

- **Attack power** is `sqrt(mainStat × weaponPower / 6) × (1 + baseApPct) + flatAP`,
  and damage is linear in it. A bracelet's flat stats join the raw pool and are
  then amplified by your percentage buckets, so the gain is a full attack-power
  ratio. With no flat attack power it collapses to the plain square-root ratio.
- **Crit** comes from a list of skills, each with a damage share, a crit rate and
  a crit damage. Crit damage 2.8 means a crit deals 2.8 times, not 3.8. The
  "+1.5% on crit" rider on families 11 and 12 is crit-hit damage, resolved in the
  same crit factor as the rest of that line.
- **Additional damage** is one additive pool — weapon quality, pet, astrogem grid,
  necklace — that multiplies your damage as `1 + pool`.
- **Outgoing damage, stagger, demon, positional and non-directional** are separate
  multiplicative buckets, each scaled by a share or uptime you set. Demon damage
  is diluted by what you already carry; outgoing damage is not.
- **Party lines** (families 16 to 19) count the whole party: your own gain plus two
  ally DPS, each assumed to deal what you do and fixed at 90% crit / 280% crit
  damage. Their ally attack-power rider is worth nothing to a DPS.
- **Vitality, combat traits and the defensive families score zero damage.** Their
  in-game values are still reported.

Baselines come from `deriveBaseline()`, which reads a gear setup — honing level
per piece, accessories, skins, karma, ranch — and returns the raw weapon power
and main stat. The reference build is weapon +25, gloves +23, everything else
+21, which is item level 1785.

## How the solver works

Each attempt rerolls every unlocked granted slot as one set; locked lines stay.
Afterwards you keep the old set or take the new one — the whole set, no
cherry-picking. Draws inside an attempt are sequential without replacement: no
family twice, capped categories dropped, everything renormalised by the surviving
mass, exactly as the disclosure page describes.

Rerolls are treated as free — the cost is the bracelet, not the attempt — so
rolling always beats stopping and the value of a state is simply the expected
final score under optimal play:

```
V(s, 0) = score(s)
V(s, n) = max over lock masks m of  E_T[ max( V(s, n−1), V(T, n−1) ) ]
```

Keep-or-replace compares those continuation values, never the immediate scores: a
weaker set can be worth more because of what its families clear out of the pool.
A state's gold value is `(V(s, n) − baseline) × goldPer1Pct`, and for an empty
granted set that is what an unrolled bracelet is worth to a buyer.

No Monte Carlo anywhere. Every roll outcome is enumerated. Two things keep a
three-slot solve tractable: families that score nothing for your profile collapse
into one junk label per category, and the expectation over outcomes is
precomputed per lock mask as a sorted array with prefix sums, so each state costs
a binary search instead of a scan over 40,000 outcomes.

## The verified-model pattern

`refs.json` is generated from the JS core. `verify.js` recomputes every entry
with that core, and `verify.py` recomputes the same entries with the Python
mirror, so the two implementations cannot drift apart in silence. Both scripts
also re-derive a set of cases from first principles — closed forms written out by
hand — and check the DP against a brute-force enumerator on small pools, so the
battery is not just the model agreeing with itself.

## What is not settled yet

The damage model rests on research that is still moving. Assumptions worth
knowing about, all adjustable inputs rather than buried constants:

- Master node is +7% additional damage. Arsonistic's sheet reads it as +7% crit
  rate and +8.5% additional damage; Shizu's call overrides that.
- Conditional weapon-power families assume 4.8 of 6 stacks (family 20), 90%
  uptime (21) and 4 steady-state stacks (22).
- Family 15 trades cooldown for damage; it is scored as the mean of burst and
  sustained play.
- Support scoring is a stub. The tool ships DPS-only.
- Reroll costs are never published and are not modelled, since rolls are free.
