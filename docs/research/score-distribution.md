# What a rolled bracelet scores

> **Model-version note, 2026-08-14 (late).** Every table below was computed at
> model 0.3.0, before scoring pooled the whole bracelet (0.4.0–0.4.1) and crit
> was uncapped (0.4.2). The RANK CUTS those tables informed were then hand-chosen
> by Shizu and live in `subrank.js` — they stand by ruling and do not move with
> the distribution. The "1 in N" figures beside them have drifted a few percent.
> For current figures rerun the tools in §5; do not hand-correct these tables.


How often each score comes up, on both axes, and what that says about where the
rank bands belong. Written 2026-08-14.

**The scale.** 0 is the worst bracelet the game can hand you — both combat traits
at the bottom of the band (61 Ancient, 41 Relic) and three lines worth nothing.
100 is both traits at 110 and the three best distinct families at Epic. Neither
end is clamped, so a bracelet can and does score past 100.

**The population.** A fresh bracelet rolled out over seven attempts — four rolls
plus three reconversion tickets — under optimal keep-or-replace. So these are
*luck* rarities: how good a bracelet you rolled, not how good a player is.
Bought bracelets skew far above this, because people sell the ones that came out
well.

---

## 1. How the numbers were got, and how they were checked

Three independent routes, which is the point.

**The exact one.** `model/bracelet.js`'s DP returns the whole distribution of
finished line scores — every reachable total with its probability. The two combat
traits are an independent draw from Stove's weighted bands, so the finished
bracelet is one convolved with the other. Exact, and it runs in about a second:
`tools/score-percentiles.mjs`.

**A hundred million rolls, sampled from that distribution.** Agrees to 0.00% at
every cut down to 1 in 141. Confirms the convolution and the scoring, not the DP
itself.

**An independent simulator**, `tools/roll-sim.mjs`, sharing nothing with the DP
but the per-line damage numbers. It draws granted slots straight from the
official weights and plays the seven attempts with a sampled lock threshold.
Being a heuristic it must score *below* the DP's optimal play, and it does — mean
39.6 against 45.5.

### The bug that made all three necessary

The first run of this had `tools/score-percentiles.mjs` calling `solve()` with
invented key names — `lines` and `traits` rather than `fixedLines`,
`grantedLines`, `traitValues` and `slots`. Every one fell through to a default,
so it solved **two** granted slots rather than three, with the combat-trait
category still live in the draw pool. That put a 35% chance of a dead trait line
on every slot of every roll. The whole distribution came out about eighteen score
points low and the reachable set capped at 9.86 line damage against a true
14.69.

Nothing warned. The Monte Carlo did not catch it either, because it sampled from
the same broken distribution. What caught it was the independent simulator
scoring *above* the DP — which an optimal solver cannot allow.

Keep `roll-sim.mjs`. It is the only check that can fail this way.

---

## 2. Ancient, three granted slots

Median 45.4, mean 45.5. The best a fresh roll ever reaches is 115.1.

| score | DPS at or above | odds | support at or above | odds |
|---:|---:|---:|---:|---:|
| 0 | 100% | — | 100% | — |
| 10 | 99.81% | 1 in 1.0 | 88.41% | 1 in 1.1 |
| 20 | 97.25% | 1 in 1.0 | 62.15% | 1 in 1.6 |
| 30 | 85.37% | 1 in 1.2 | 34.76% | 1 in 2.9 |
| 40 | 64.75% | 1 in 1.5 | 17.08% | 1 in 5.9 |
| 45 | 51.04% | 1 in 2.0 | 11.10% | 1 in 9.0 |
| 50 | 37.34% | 1 in 2.7 | 6.68% | 1 in 15 |
| 55 | 25.08% | 1 in 4.0 | 3.79% | 1 in 26 |
| 60 | 15.46% | 1 in 6.5 | 2.04% | 1 in 49 |
| 65 | 8.71% | 1 in 11 | 1.05% | 1 in 95 |
| 70 | 4.37% | 1 in 23 | 0.513% | 1 in 195 |
| 75 | 1.91% | 1 in 52 | 0.233% | 1 in 430 |
| 80 | 0.709% | 1 in 141 | 0.096% | 1 in 1,039 |
| 85 | 0.216% | 1 in 464 | 0.036% | 1 in 2,760 |
| 90 | 0.052% | 1 in 1,915 | 0.012% | 1 in 8,127 |
| 95 | 0.0098% | 1 in 10,182 | 0.0036% | 1 in 27,455 |
| 100 | 0.0013% | 1 in 74,854 | 0.00089% | 1 in 111,845 |
| 105 | — | 1 in 882,283 | — | 1 in 612,265 |
| 110 | — | 1 in 23,634,044 | — | 1 in 5,060,264 |

### Read the other way

| 1 in | DPS score | support score |
|---:|---:|---:|
| 2 | 45.4 | 23.7 |
| 5 | 57.4 | 38.1 |
| 10 | 63.9 | 46.1 |
| 50 | 74.7 | 60.1 |
| 100 | 78.4 | 65.3 |
| 1,000 | 87.8 | 79.8 |
| 10,000 | 95.0 | 90.9 |
| 100,000 | 100.7 | 99.6 |
| 1,000,000 | 105.2 | 106.3 |

---

## 3. Relic, three slots, and Ancient at two slots

**Relic is about half a band harder throughout.** Same cuts, roughly double the
rarity: A- is 1 in 91 against Ancient's 1 in 52, S- is 1 in 3,889 against 1 in
1,915. The shape is the same, so the shared ladder holds; a Relic bracelet simply
sits a band lower than the Ancient one it looks like.

**Two granted slots cannot reach the top four bands at all.** S+, S, S- and A+
are unreachable, and A is 1 in 936,285. This is not a defect: the anchor is three
lines, so a two-slot bracelet is being measured against a bracelet with more room
than it has. If two-slot brackets ever need their own ranking, they need their
own anchor.

---

## 4. Where the bands belong

### The damage dealer's ladder is already right

The cuts shipping today turn out to be a clean geometric rarity ladder on the
corrected distribution — each band roughly two to three times rarer than the one
below, from C- all the way to S+:

| band | cut | rarity | band | cut | rarity |
|---|---:|---:|---|---:|---:|
| S+ | 100.1 | 1 in 78,290 | C+ | 55 | 1 in 4.0 |
| S | 95 | 1 in 10,182 | C | 50 | 1 in 2.7 |
| S- | 90 | 1 in 1,915 | C- | 45 | 1 in 2.0 |
| A+ | 85 | 1 in 464 | D+ | 40 | 1 in 1.5 |
| A | 80 | 1 in 141 | D | 35 | 1 in 1.3 |
| A- | 75 | 1 in 52 | D- | 30 | 1 in 1.2 |
| B+ | 70 | 1 in 23 | F+ | 20 | 1 in 1.03 |
| B | 65 | 1 in 11 | F | 10 | 1 in 1.00 |
| B- | 60 | 1 in 6.5 | F- | — | — |

**One defect, at the bottom.** F, F+ and F- hold 3.5% between them, because seven
rolls of optimal play essentially guarantee a mediocre bracelet rather than a bad
one. Moving **F to 20 and F+ to 25** gives those three bands 2.75 / 3.5 / 8.4%
and costs nothing else. That is the only change worth making, and it is Shizu's
to make.

### The support ladder is matched, not shared

On identical cuts a support S+ would be 1 in 112,000 against a dealer's 1 in
75,000, and the drift runs the other way at the bottom: support F- would swallow
38% of all brackets against the dealer's 2.75%. A letter has to mean the same
rarity on both axes or it means nothing, so the support cuts are read off the
DPS band rarities — the approach the astrogem calculator took when it moved to
percentile-aware letters.

Matched to the ladder shipping today, and this is what `subrank.js` now carries:

```
S+ 98.8   S 91.0   S- 83.2   A+ 75.4   A 67.8   A- 60.5
B+ 53.8   B 47.5   B- 41.2   C+ 35.3   C 28.8   C- 23.3
D+ 19.2   D 15.4   D- 11.1   F+  7.2   F  5.5   F- the rest
```

If the DPS F / F+ move above is taken, rerun `tools/rank-match.mjs` and paste the
table it prints: the support cuts are derived from the DPS ones and have to move
with them.

---

## 5. Rerunning any of this

```
node tools/score-percentiles.mjs [ancient|relic] [slots] [--mc N]
node tools/roll-sim.mjs          [ancient|relic] [slots] [count] [dps|support]
node tools/ladder-options.mjs    [ancient|relic] [slots]
node tools/rank-match.mjs        [ancient|relic]
```

Every one of them depends on the per-line damage numbers, so **rerun them after
any change that moves a line's damage** — a new constant, a changed profile
default, a repriced family. The support ladder in `subrank.js` is a snapshot and
will drift silently otherwise.
