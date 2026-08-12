# Why our `linesPct` sits above lostark.bible's "Bracelet Effects +X%"

Written 2026-08-11 against the 59-page corpus in `.corpus/` (every page fetched with the
authorization token, in one pass). Every number below comes from the loadout bible itself
renders on each page — the one its "Bracelet Effects" figure describes — scored on
`Bracelet.normalizeProfile({})`.

**Headline: the offset is not constant, and it is not one bug.** Bible's whole formula has
been recovered exactly, and the difference splits into six separate disagreements about
what a line is worth. The largest by far is that bible does not score families 11, 12, 14
and 15 at all — it hands each a flat number that depends only on the tier.

## 1. The shape of the gap

`ours − bible`, over the loadout bible renders:

| set | n | mean | sd | min | median | max |
|---|---|---|---|---|---|---|
| all | 59 | +0.326 | 1.185 | −2.41 | +0.49 | +2.54 |
| carries family 14 | 15 | −1.342 | 0.721 | −2.41 | −1.52 | +0.33 |
| no family 14 | 44 | **+0.895** | **0.658** | −0.26 | +0.81 | +2.54 |

The +0.9pp is a mean, not a constant: the spread runs from −0.26 to +2.54, and the standard
deviation is three quarters of the mean itself. Anything that only shifts the mean is not an
explanation.

Where the residual does show structure:

| cut | result |
|---|---|
| item level | r = −0.26 — no real signal, and none is possible: the model scores every character on the same default profile |
| class | no signal, same reason; the per-class spread is family composition, nothing else |
| number of scored lines | r = −0.17 |
| number of lines from families 11 / 12 / 15 | r = +0.32; mean gap 0.37 (0 such lines) → 0.80 (1) → 1.17 (2) → 1.18 (3) |
| main-stat line present | +1.447 with (n=8) vs +0.772 without (n=36) |

Those last two are the tell.

## 2. Bible's formula, recovered

Regress `log(1 + bible%/100)` on one dummy per (family, tier) across all 59 pages. The
design matrix has 40 columns, 59 rows and full column rank, so the fit is unique.

| link function | residual mean | residual sd | worst |
|---|---|---|---|
| bible% = **sum** of per-line % | +0.0007 | 0.0178 | 0.068 |
| bible% = 100·(**prod**(1+w)−1) | −0.0001 | **0.0019** | **0.004** |

Bible prints two decimals, so pure rounding noise would give sd ≈ 0.0029. The
multiplicative fit is already below that floor; the additive fit is six times above it.

**So hypothesis 1 from the brief is dead: bible compounds its lines exactly the way we do.**
Feeding bible's own recovered weights back through a plain sum instead of a product costs
mean −0.281 / sd 0.099 — visibly worse. The two models share their combination rule. They
disagree only about what each line is worth.

Reading the fitted weights against the numbers bible itself renders:

| family | tier | rendered numbers | ours % | bible % |
|---|---|---|---|---|
| main stat (Str/Dex/Int) | – | the rolled stat | 0.86 | **0.00** |
| 1 atkMoveSpeed | high | 6 | 0.600 | **0.001** |
| 9 moveSkillCd | mid | 10 | 0.000 | −0.000 |
| 11 critRateOnCrit | low | 3.4 | 3.833 | **3.501** |
| 11 critRateOnCrit | mid | 4.2 | 4.396 | **3.999** |
| 11 critRateOnCrit | high | 5 | 4.958 | **4.501** |
| 12 critDmgOnCrit | low | 6.8 | 3.814 | **3.500** |
| 12 critDmgOnCrit | mid | 8.4 | 4.372 | **3.998** |
| 12 critDmgOnCrit | high | 10 | 4.929 | **4.499** |
| 13 dmgStagger | low | 2, 4 | 2.408 | 2.799 |
| 13 dmgStagger | mid | 2.5, 4.5 | 2.961 | 3.407 |
| 14 addDmgDemon | low | 2.5, 2.5 | 1.806 | **3.500** |
| 14 addDmgDemon | mid | 3, 2.5 | 2.167 | **3.999** |
| 14 addDmgDemon | high | 3.5, 2.5 | 2.528 | **4.497** |
| 15 cdUpDmgUp | low | 4.5 | 3.885 | **3.502** |
| 15 cdUpDmgUp | mid | 5 | 4.382 | **3.998** |
| 15 cdUpDmgUp | high | 5.5 | 4.879 | **4.500** |
| 20 wpStackHit | low | 1160 | 2.021 | 1.881 |
| 20 wpStackHit | mid | 1320 | 2.216 | 2.142 |
| 21 wpHpHigh | low | 7200, 2000 | 1.875 | 0.543 |
| 21 wpHpHigh | mid | 8100, 2200 | 2.099 | 0.590 |
| 21 wpHpHigh | high | 9000, 2400 | 2.322 | 0.651 |
| 22 wpStack30s | low | 6900, 130 | 2.206 | 1.044 |
| 23 damage | low / mid / high | 2 / 2.5 / 3 | 2.000 / 2.500 / 3.000 | 2.000 / 2.501 / 2.999 |
| 24 addDamage | low / mid / high | 3 / 3.5 / 4 | 2.167 / 2.528 / 2.889 | 2.305 / 2.694 / 3.080 |
| 25 backAttack | low | 2.5 | 2.500 | 1.749 |
| 26 frontAttack | high | 3.5 | 3.500 | 2.449 |
| 27 nonDirectional | low / mid / high | 2.5 / 3 / 3.5 | 2.500 / 3.000 / 3.500 | 2.498 / 2.996 / 3.500 |
| 31 critRate | low / mid / high | 3.4 / 4.2 / 5 | 2.336 / 2.885 / 3.435 | 2.375 / 2.943 / 3.504 |
| 32 critDamage | low / mid / high | 6.8 / 8.4 / 10 | 2.336 / 2.885 / 3.435 | 2.265 / 2.800 / 3.328 |

Every rule bible follows can be read straight off that table:

1. **Families 11, 12, 14 and 15 get a flat 3.5 / 4.0 / 4.5 by tier.** Four different
   families, four different sets of printed numbers, one shared answer, and the worst
   deviation across the twelve cells is 0.003 — bible's own rounding. Bible is not valuing
   these lines; it is labelling their tier. It gives "Crit Damage +10%, Crit Hit Damage
   +1.5%", "Crit Rate +5%, Crit Hit Damage +1.5%" and "Skill cooldown +2%, Outgoing Damage
   +5.5%" the same 4.5, which no damage model can do.
2. **Face value where the line is plain damage.** Families 23 and 27 return the printed
   percentage unchanged, to three decimals.
3. **Additional damage over a 30% pool.** Family 24: 3 → 2.305, 3.5 → 2.694, 4 → 3.080; the
   ratio is 0.7692 = 1/1.30 every time, i.e. (1+0.33)/(1+0.30). We divide by 1.3844 instead
   (weapon quality 0.30 + pet 0.01 + astrogem 0.0484 + neck 0.026), so bible sits *above* us
   here.
4. **70% uptime on directional damage.** Family 25 → 0.6996×, family 26 → 0.6997×, while
   non-directional (27) keeps its full value. We run all three shares at 1.0.
5. **Crit conversions of its own.** Crit rate is worth 0.700× the printed points (we say
   0.687×); crit damage is worth exactly a third (we say 0.3435×). Both agree with us to
   about 3%.
6. **Damage-to-staggered valued at a 20% share.** Family 13 = A + 0.2·B on both tiers seen.
   Our profile uses `staggeredShare = 0.1`.
7. **Weapon power at ~0.00027% per point — but only the conditional half of the line.**
   Family 20 counts all six stacks (1160×6 → 1.881, 1320×6 → 2.142). Family 21 returns
   0.543 / 0.590 / 0.651 for lines whose printed values are 7200+2000, 8100+2200,
   9000+2400: divide by the *second* number and you get 2.72 / 2.68 / 2.71 × 10⁻⁴ — the same
   conversion, applied to the on-hit buff alone. Family 22 does the same (130×30 stacks,
   0.00027 → 1.054 against bible's 1.044) and drops the flat +6,900. Bible silently throws
   away the unconditional weapon power on those two families.
8. **Main stat and every utility family score zero.** Str/Dex/Int +13,760 is worth exactly
   nothing to bible, as is Atk./Move Speed +6%.

### The emulation

Those eight rules, written out by hand with no further fitting, reproduce **all 59** printed
figures:

```
mean error +0.0013   sd 0.0032   worst |error| 0.006
```

Three characters land 0.01 off (Mirget, Jurassiq, Ashukel); the rest are exact to the
printed decimal. Bible's formula is fully recovered. The gap between us and it is therefore
completely accounted for, and there is nothing left over to attribute to a hidden constant.

## 3. Splitting the +0.9pp

Because both models multiply their lines, the difference is exactly additive in log space,
so each line's contribution can be attributed with no residue. Over the 44 characters
without family 14, the mean log-space gap of 0.815 breaks down as:

| what we do differently | contribution to the mean gap (pp) | share |
|---|---|---|
| families 11 / 12 / 15: we score them, bible flat-rates the tier | **+0.494** | 61% |
| weapon power 21 / 22: bible drops the unconditional half | +0.161 | 20% |
| main-stat line: bible scores it 0 | +0.154 | 19% |
| back / front attack: bible assumes 70% uptime | +0.040 | 5% |
| attack speed (family 1): bible scores it 0 | +0.014 | 2% |
| crit rate / crit damage conversion (families 31, 32) | +0.014 | 2% |
| weapon power 20: our stacked value runs slightly hot | +0.011 | 1% |
| additional damage: bible's smaller 1.30 denominator | −0.037 | −5% |
| damage-to-staggered: bible's 20% share vs our 10% | −0.037 | −5% |
| **total** | **+0.815** | |

Stepping our model towards bible's, one change at a time (mean and sd of `ours − bible`):

| model | all 59 | | no family 14 | |
|---|---|---|---|---|
| | mean | sd | mean | sd |
| our model, as shipped | +0.326 | 1.185 | +0.895 | 0.658 |
| + main-stat line → 0 | +0.170 | 1.129 | +0.728 | 0.616 |
| + utility families 1–10 → 0 | +0.159 | 1.125 | +0.713 | 0.618 |
| + families 11/12/15 → flat 3.5/4/4.5 | −0.324 | 1.011 | +0.168 | 0.547 |
| + family 14 → flat 3.5/4/4.5 | +0.170 | 0.550 | +0.168 | 0.547 |
| + back/front attack at 70% | +0.110 | 0.512 | +0.124 | 0.517 |
| + weapon power 21/22, on-hit half only | −0.051 | 0.172 | −0.050 | 0.172 |
| + bible's 13 / 24 / 31 / 32 constants | +0.001 | 0.003 | +0.001 | 0.003 |

Note the sd column. Only the last four steps buy real agreement; the first two move the mean
without tightening the spread, which is exactly the failure mode the brief warned about.

**Why it looked like a constant.** All but three of those 44 bracelets carry at least one of
families 11, 12 and 15, each such line is worth about +0.37pp more to us than
to bible, and most bracelets carry one or two of them. Add the family-21/22 lines (rare but
worth +1.3 to +1.6pp each) and the main-stat lines (worth +0.85pp, on 8 of 44) and the
average lands near +0.9 while no individual character is actually at +0.9.

## 4. Verdict on the hypotheses in the brief

| hypothesis | verdict |
|---|---|
| We compound where bible sums | **Rejected.** Bible compounds. Its own recovered weights, summed instead of multiplied, miss by mean −0.281 / sd 0.099; multiplied, they land at sd 0.0032, below bible's print rounding. |
| Bible drops the crit-hit-damage rider on families 11 / 12 | **Rejected as stated, but the family is the problem.** Bible does not compute the rider *or* the base — it flat-rates the family by tier. The implied value of the rider (bible's 11/12 figure minus its own 31/32 figure for the same points) runs 1.00–1.24pp, against our 1.49–1.51pp; ours applies at close to face value, bible's looks like face value weighted by crit rate. That is a genuine question about the model but it is not what makes the totals differ. |
| Bible drops the ally credit on party lines 16–19 | **Untestable here.** Not one of the 59 brackets carries a family in 16–19. It cannot be the cause of anything observed. |
| Our additional-damage denominator differs from theirs | **Confirmed, and it works the other way.** Bible uses 1.30, we use 1.3844, so bible scores family 24 *above* us. It shrinks the gap by 0.033pp. |
| Our weapon-power stack / uptime assumptions overshoot | **Rejected.** On family 20, where the line is nothing but stacks, we and bible both assume the full six and land within 0.14pp. The 21/22 disagreement is not about uptime: bible applies the *same* per-point conversion and simply ignores the flat "+9,000 Weapon Power" clause the tooltip prints. Our decode of that clause is validated word for word against the rendered tooltip on all five pages that carry it. |

## 5. Recommended model change

**None.** Do not chase this offset.

Bible's "Bracelet Effects +X%" is not a damage estimate. On the families that matter most it
is a tier label — 3.5 / 4.0 / 4.5 for low / mid / high, the same number whether the line
grants crit rate, crit damage or raw outgoing damage at the cost of cooldown — and on two
weapon-power families it silently discards half of what the line prints. Fitting our model to
it would replace theorycraft with a lookup table and would make family 14 worth more than
family 23 for reasons no player could act on.

Three smaller items are worth a separate look on their own merits, not because bible
disagrees:

1. **`backAttackShare` / `frontAttackShare` = 1.0.** A back-attacker landing every hit from
   behind is optimistic; bible's 0.70 is at least a defensible guess. This is a profile
   default, not a model bug, and it moves 0.04pp of the average.
2. **The "+1.5% on crit" rider on families 11 and 12.** We value it at about 1.5pp, bible at
   about 1.1pp. Worth checking `critFactorFull` against the in-game wording — but on its
   own it is a per-line question, decided by first principles, not by matching bible.
3. **`staggeredShare` = 0.1 vs bible's 0.2.** Two data points on their side; no reason to
   move without evidence of our own.

The one place bible is clearly wrong and we are clearly right is families 21 and 22: the
flat weapon power is printed on the item, our decode matches the rendered text exactly, and
bible drops it.

## 6. Reproducing this

The scoring pipeline lives in the 2026-08-11 session scratchpad
(`loadouts_score_v2.js` over `.corpus/`, then `gap1.js` … `gap4.js`). `gap2.js` fits bible's
weights, `gap3.js` checks that they are identified and attributes the gap, and `gap4.js`
holds the hand-written emulation and the step-by-step table above. Nothing in this document
touched the network.

---

# 7. The seed-versus-Worker gap: two bugs, both ours

Written 2026-08-11, after `node tools/test-worker.mjs` had reported 92 passed / 1 failed for
long enough that two sessions had written it off as "pre-existing, cause not written down".

Nothing above this line changes. Sections 1–6 are about us against lostark.bible. This one is
about us against ourselves — `data/leaderboard-seed.json` against the scorers that are
supposed to reproduce it.

Six of the fifty-nine seeded characters did not reproduce. All six came out **low**, by 1.2pp
to 3.2pp. There were **two** independent causes, not one, and the seed was right both times.

| character | seed | Worker | delta | cause |
|---|---|---|---|---|
| Hamoi | 15.541 | 14.370 | −1.171 | decoded as Relic |
| Guynamedcharlie | 13.629 | 12.413 | −1.216 | decoded as Relic |
| Linkuriboh | 15.080 | 11.902 | −3.178 | granted trait scored zero |
| Mylaela | 12.942 | 10.236 | −2.706 | granted trait scored zero |
| Kayamix | 12.258 | 9.461 | −2.797 | granted trait scored zero |
| Komyosanzo | 11.764 | 9.557 | −2.207 | granted trait scored zero |

## 7.1 Bug A — a combat trait in a granted slot scored nothing

Four bracelets carry a combat trait that rolled into a **granted** slot rather than arriving
as one of the two the drop hands over. Kayamix's, as bible renders it:

```
Dexterity +12352      locked
Specialization +78    locked
Outgoing Damage +2.5%
Crit +104                       <- a combat trait, in a granted slot
Crit Rate +3.4%. Crit Hit Damage +1.5%.
```

Every scorer built on this model splits the decoded lines in two and adds the halves: combat
traits through `traitDamage()`, effect lines through `setDamage()`. Three of the four copies
of that split — `worker/bracelet.js`, `leaderboard.js`, `bible-import.js` — wrote the test as

```js
if (l.fixed && l.cat === "trait" && key) { /* …traits… */ }
lines.push(l);
```

**`l.fixed` is bible's lock icon.** It is not the drop's fixed/granted split, and the seed's
own notes have said so since it was built: *"Players can lock granted lines, so the drop's
fixed/granted split cannot be read off this payload."* So the `l.fixed &&` clause sent
Kayamix's Crit +104 down to `setDamage()`, which scores a trait line **0**, and 104 points of
crit vanished. The seed pipeline, the fourth copy, split on `cat` alone and was right.

### The semantics, and why

> **Combat-trait lines score in `traitDamage()`. Effect lines score in `setDamage()`. The
> split is on `cat`, never on `fixed`.** A trait that rolled into a granted slot is still a
> combat-trait line, so it scores its rolled value — Crit +104 is 104 points of crit on the
> character whether the drop handed it over or a reroll did.
>
> It stays a **granted slot**: it keeps `fixed: false`, it counts toward the granted-slot
> total, and it is rerollable like any other granted line. Scoring it and locking it are
> different questions, and the answer to the second is still no.

The tempting alternative — make `lineDamage()` return a trait's value so `setDamage()` picks
it up and every caller is fixed for free without editing any of them — was measured and
rejected. It gets `pct` right and quietly corrupts `linesPct`:

| | linesPct, traits out | linesPct, traits through setDamage |
|---|---|---|
| Linkuriboh | 8.24 | 11.31 |
| Mylaela | 7.68 | 10.33 |
| Kayamix | 6.24 | 8.96 |
| Komyosanzo | 6.18 | 8.32 |

`linesPct` is the effect lines alone. It is the number section 2 above compares against
bible's "Bracelet Effects +X%" — and bible scores combat traits at zero, so folding a trait
into it makes that comparison meaningless for exactly the characters this section is about.
It is also what `pickBestLoadout()` ranks on: at those numbers **Komyosanzo's board row
switches to a different loadout**, and all four cross a benchmark band. On top of which
`app.js`'s own help text and family picker are built on `lineDamage()` answering zero for a
trait. So `setDamage()` stays the effect-line scorer and the callers do the routing.

### What the DP does with it

Nothing — a known gap rather than an oversight. `solve()` folds the whole trait term into
`fixedDamage`, a constant on every reachable state, and `buildAtoms()` still gives the six
trait draws `damage: 0`. So the reroll advisor will happily roll a granted trait away and
will never roll towards one.

Closing it means giving `lineDamage()` a non-zero answer for a trait line, which is the change
rejected just above, plus counting the bracelet's own traits against `CAPS.trait` inside
`solve()` — they live in `opts.traitValues`, outside `lines`, so the DP currently thinks a
two-trait bracelet has both trait slots free. That is a change to the **advisor**, worth doing
on its own merits, and it costs the **score** — which is what the board ranks on — nothing.
Left undone deliberately.

## 7.2 Bug B — Ancient bracelets decoding as Relic

Hamoi and Guynamedcharlie have no granted trait. They were decoding as **Relic**, and the two
value tables sit exactly one tier apart:

| family | tier | Relic | Ancient |
|---|---|---|---|
| 15 cdUpDmgUp | low | 4.0 | **4.5** |
| 12 critDmgOnCrit | low | 5.2 | **6.8** |
| 11 critRateOnCrit | mid | 3.4 | **4.2** |

so a Relic reading scores every special line one tier low. Bible's rendered text on both pages
— *"Skill cooldown +2%. Outgoing Damage +4.5%."* — says Ancient outright, and the seed
validated it word for word. The payload does not carry that text.

The root cause was three lines of `inferGrade()`:

```js
var best = "ancient", bestHits = -1;
for (var g = 0; g < grades.length; g++) {
  /* … */ if (hits > bestHits) { bestHits = hits; best = grades[g]; }
}
```

`bestHits` starts **below zero**, so the first grade always wins with zero evidence, and
`DATA.GRADES` starts at `"relic"`. The `best = "ancient"` initialiser was dead code. Worse,
the only evidence the loop counted came from **type:2** special lines, and **29 of the 59**
seeded bracelets carry none: their specials are type:3 / type:4, which take their tier from
the index and their value from whichever table they are handed, so they can never disagree
with a grade. Twenty-nine coin flips, all landing on Relic.

Most were rescued downstream, because the callers check the granted-slot count and Ancient
grants 2–3 where Relic grants 1–2. Hamoi and Guynamedcharlie had **locked four of their five
lines**, which reads as one granted slot, which fits Relic — so the rescue confirmed the error
instead of catching it. Both `unplaced()` guards were powerless for the same reason a type:3
line is no evidence: it always places.

### The fix

`inferGrade()` now weighs every witness the payload actually carries, and a grade the payload
**rules out** loses outright:

1. **Line count.** `LINE_COUNTS` gives 1–2 fixed lines plus 1–2 granted on Relic and 2–3 on
   Ancient, so Relic tops out at **four** lines and Ancient at five. A five-line bracelet
   cannot be Relic. This is the witness that beats the lock icon: a player can lock a granted
   line, but locking never changes how many lines an item has. It settles both characters.
2. **Trait bands.** Relic 41–100, Ancient 61–120. Either end rules a grade out; the callers
   only ever checked the top.
3. **Basic bands.** Relic main stat 6400–12800, Ancient 9600–16000; likewise Vitality.

Special *values* stay a preference rather than a ruling, because Relic mid = Ancient low on
every family, so a value fitting one usually fits the other. When the survivors tie — or when
there is no evidence at all — the answer is now **Ancient**, which is also the safe direction:
reading an Ancient bracelet as Relic loses damage, and every bracelet in the corpus is Ancient.

`decodeBibleBracelet()` also stops honouring an `opts.grade` the payload rules out, reporting
`gradeOverridden` instead. Callers force a grade in order to *test* it, and the honest answer
to "could this five-line bracelet be Relic?" is no — not a five-line Relic decode.

## 7.3 What moved

Only the six characters above; the other fifty-three were already exact. All six go **up**, to
the number the seed had stored all along, so `data/leaderboard-seed.json` needed no numeric
edit — only its notes. That is the strongest evidence that the seed pipeline had the semantics
right and the three client scorers had drifted away from it.

| character | before | after | delta |
|---|---|---|---|
| Linkuriboh | 11.902 | 15.080 | +3.178 |
| Kayamix | 9.461 | 12.258 | +2.797 |
| Mylaela | 10.236 | 12.942 | +2.706 |
| Komyosanzo | 9.557 | 11.764 | +2.207 |
| Guynamedcharlie | 12.413 | 13.629 | +1.216 |
| Hamoi | 14.370 | 15.541 | +1.171 |

`Bracelet.VERSION` goes **0.1.0 → 0.2.0**. That is not cosmetic: the Worker re-scores any
stored record whose `modelSig` (`MODEL_SIG@VERSION`) no longer matches, so without the bump
every row already in KV would have kept its old score forever.

## 7.4 Still open

- **The three copies of `decodeWithGradeCheck` are not identical.** `leaderboard.js` says
  `slotChoices("ancient") === [1,2,3]`; `worker/bracelet.js` and `bible-import.js` say
  `[2,3]`. `bible-import.js` has no `unplaced()` guard at all. All 59 characters agree across
  all three today, but only because the model now refuses the impossible re-decode underneath
  them. The duplication is deliberate; the drift is not.
- **`buildAtoms()` still values a trait draw at zero.** See 7.1.
- **`parseVersion` against `modelSig`.** They answer different questions and both are worth
  keeping: `modelSig` says which scoring model produced `score`, `parseVersion` says which
  parse generation produced `stats`. `MODEL_SIG` is *not* a substitute for `parseVersion`.
  The hole — a fresh pull carrying no `parseVersion`, because only `/admin/rescore` stamped it
  — was closed separately on the same day; every path that builds or re-scores stats now
  stamps both.

## 7.5 Reproducing this

`node tools/test-worker.mjs` § 1 now asserts **exact** parity on all 59 characters with no
tolerated exceptions, plus that a granted trait scores in `pct` and not in `linesPct`, that it
is still reported as rerollable, and that no seeded bracelet decodes as Relic. `verify.js` and
`verify.py` carry a matching *grade inference* block of first-principles checks — line count,
trait band, basic band, the Ancient default, and the forced-grade refusal. Both batteries run
1629 checks.
