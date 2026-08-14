# The support model (ported 2026-08-14)

`model/bracelet.js` now scores a support with the house model, taken from the accessory
calculator (`loastuff/lost-ark-accessories`) by way of `loa-gpd/model/support.js`. The
research behind it is `loa-gpd/docs/research/bracelet.md`, which is the source of truth
for what a support bracelet is worth. This doc says what our copy does, names every
constant it carries, says what we left behind, and checks our numbers line by line
against loa-gpd's.

It replaces a stub. The stub priced buff lines with flat per-percent constants —
`allyApBuffDamagePerPct: 0.45`, `allyDamageBuffDamagePerPct: 0.30` — and ran about double
the truth: a legendary Relic family-30 line came out at 2.25 points where the house model
says 1.01.

**What a support score means.** What its buffs add to **one** damage dealer, above a
support wearing nothing:

```
Q = 100 · ln( ap · brand · identity )
```

The support's own damage is not counted anywhere, at all, ever. That single rule decides
most of the table in section 3.

---

## 1. The three channels

### `ap` — the ally attack-power buff

The support hands each ally `0.22 × (1 + allyAtkEnh)` of its own **base** attack power.
That lands on the dealer inside the dealer's own attack-power percentage bucket, so:

```
supAtk = sqrt(MS · WP / 6) · (1 + baseApPct)                 the support's base attack
dpsAtk = sqrt(dpsMS · dpsWP / 6)                             the dealer's
apMult = ((dpsAtk + supAtk·0.22·(1 + atkEnh))·(1 + dpsAtkPct) + dpsFlatAtk)
       / ( dpsAtk                            ·(1 + dpsAtkPct) + dpsFlatAtk)
ap     = 1 + 0.95 · (apMult − 1)                             95% uptime
```

This is the only channel the support's own gear reaches. It is why a weapon-power line and
a main-stat line are not dead weight on a support, and why honing shows up at all.

### `brand` — 10% damage, scaled by brand power

```
brand = 1 + 1.00 · 0.1 · (1 + brandPower)
```

No T4 bracelet line touches brand power, so this factor is the same with the line and
without it and **cancels out of every bracelet score**. It is in the product to keep our
copy the same shape as the house model's, and so that a future line that does feed brand
has somewhere to land.

### `identity` — Serenade, Major Chord, the T-skill, and the dilution

All three raise the dealer's **Additional Damage**. Additional damage is one additive pool
that multiplies total damage as `(1 + pool)`, so a buff that adds to that pool is worth
less to a dealer who already carries a lot of it. That is the dilution, and it is the
`/(1 + baseAdd)` at the bottom:

```
seren    = 0.15 · (1 + allyDmg)  · (1 + spec·classCoeff)
chord    = 0.02 · (1 + allyDmg)  · (1 + spec·classCoeff)
tsk      = 0.10 · (1 + allyDmgT)
identity = 1 + (0.70·seren + 0.70·chord + 0.40·tsk) / (1 + baseAdd)
```

Two things follow. A support's identity buff is worth less to a well-geared dealer than to
a poor one, because the well-geared one already has the pool. And Specialization pays here
and nowhere else: it enters only as `spec × classCoeff`, which multiplies Serenade and
Major Chord.

---

## 2. Why the party debuffs are scored outside the support model

Families 16 to 19 each carry two halves: a party-wide **debuff** on the boss, and an
**ally attack-power rider** that scales the buff a support hands out.

The rider is a support thing and goes through `ap`. The debuff does not, and must not.

**`support.js` has no channel for enemy shred**, and giving it one would be wrong anyway. A
defence shred sits on the boss. Its size does not depend on who applied it — support,
dealer, anybody. So it goes through the same functions the DPS side already uses:

```
crit resist  −A%   →  every dealer's crit rate  +A pp   ·  allyCritFactor()
crit dmg res −A%   →  every dealer's crit dmg   +A pp   ·  allyCritFactor()
defence      −A%   →  (D + K) / (D(1 − A) + K)          ·  defShredGain()
family 18          →  +A% party-wide at 60% shield uptime
```

`damage-model-spec.md`, "Party debuff lines scored for DPS", is the spec for all four, and
it is the same spec for both roles. That is the point. One code path means the tool cannot
disagree with itself about what a shred line does depending on who is wearing it, and a
support and a dealer pricing the same family get answers that differ only where the game
makes them differ — on the rider.

The rider is where they differ, and it is worth a sentence to a user: **"Ally Atk. Power
Enhancement +B%" does nothing on a damage dealer.** So families 16-19 are strictly better
on the support than on a dealer, and that is the whole argument for the support being the
party's carrier of them.

**One per party.** The tooltip says so outright. On a DPS profile the `supportHasEffects`
switch says the party's support already brings the debuff, and a second copy is then worth
exactly nothing — not less, nothing. On a support profile the panel forces that switch off
and says why: it asks whether somebody *else* brings the debuffs, and as the support you
are that somebody.

**A gap in how our copy counts them — see section 8.** The buff channels are scored per one
dealer; the debuff halves are multiplied by `allyDpsCount`, which ships at 2. The two halves
of one line are therefore measured on different scales. loa-gpd counts one dealer
throughout and applies the party multiplier on the gold axis instead.

---

## 3. What a support line is worth, and what is worth nothing

Our model, our own shipped default profile, role Support, Ancient, low / mid / high, in
points of damage. Family 16-19 rows are given at both counts so the section-8 gap is
visible rather than hidden:

| # | line | as shipped | at one dealer |
|---|---|---|---|
| 17 | enemy Crit Resist −A%; ally AP buff +B% | 2.776 / 3.261 / 3.877 | 1.562 / 1.849 / 2.202 |
| 19 | enemy Crit DMG Resist −A%; ally AP buff +B% | 2.776 / 3.261 / 3.744 | 1.562 / 1.849 / 2.135 |
| 16 | enemy Defense −A%; ally AP buff +B% | 2.133 / 2.516 / 2.999 | 1.237 / 1.472 / 1.757 |
| 18 | shielded-target damage +A%; ally AP buff +B% | 1.407 / 1.727 / 2.047 | 0.872 / 1.074 / 1.276 |
| 30 | Ally Damage buff effect +X% | 0.795 / 0.993 / 1.190 | same |
| 29 | Ally Attack Power buff effect +X% | 0.665 / 0.831 / 0.996 | same |
| 22 | Weapon Power +A, +B per stack (30 stacks) | 0.624 / 0.693 / 0.761 | same |
| 21 | Weapon Power +A, +B while HP≥50% | 0.532 / 0.594 / 0.657 | same |
| 33 | Weapon Power +X | 0.415 / 0.467 / 0.518 | same |
| 20 | Weapon Power +A per stack (6 stacks) | 0.402 / 0.456 / 0.511 | same |
| 28 | Party shield / heal effects +X% | 0.250 / 0.300 / 0.349 | same |
| — | basic line, Str / Dex / Int | 0.241 (band-weighted mean) | same |
| — | combat trait, Spec or Swiftness, per 100 points | 0.498 | same |

Family 28 is our own departure and is not damage. It is `partyShieldHealValuePerPct` at
0.10 points per percent — a placeholder that pays a support for keeping people alive.
loa-gpd scores it zero and leaves it out. Ours puts a non-damage number in a damage
column; treat it as a flag, not as a measurement.

**Worth exactly nothing to a support**, and the reason is always the same one:

| family | why |
|---|---|
| 11, 12, 31, 32 — crit rate, crit damage, "+1.5% on crit" | the support's own crit; nobody counts its damage |
| 13, 14, 15, 23, 24, 25, 26, 27 — outgoing, additional, stagger, demon, back, front, non-directional, cooldown-for-damage | the support's own damage, same reason |
| 2 — damage to Seed-grade and lower | the support's own damage |
| 3, 4, 5, 6, 7, 8, 9, 10 — damage taken, defences, Max HP, recovery, movement cooldown, hit immunity | survival and comfort; real, not on this axis |
| 1 — attack and move speed | more casts for the support, whose damage nobody counts (but see section 5) |
| basic Vitality | dead weight for both roles |
| combat traits Crit, Domination, Endurance, Expertise | the support's own damage |

Which gives the sentence a user needs on the screen: **a support bracelet carrying three
fat DPS lines is a blank bracelet.** Family 11, legendary Ancient — the best personal-damage
line a dealer can roll, 4.84 points — scores zero on a Bard.

---

## 4. The combat traits

Specialization pays through the identity bracket and nowhere else, at `spec × classCoeff`,
so it is scored by running the bracelet's trait points through the model rather than by a
weight. At the reference character 100 points is 0.498 points of damage; ten points, which
is what one rung of the 80/80 ladder buys, is 0.0497.

**Swiftness is priced the same as Specialization (Shizu's call).** The model has no channel
for it, so its computed value is zero; the Spec figure is a stand-in for something real the
model cannot see. See the next section — that is a guess, not a measurement.

Crit, Domination, Endurance and Expertise score zero for a support, no caveat.

---

## 5. Two known under-counts

Neither of these means the thing is worthless. Both mean the model cannot see the channel
the value arrives through.

**Swiftness.** In game it shortens the buff cycle. A shorter cycle raises the share of the
fight the buffs are up for — and the four uptimes (`upAp` 95, `upSeren` 70, `upChord` 70,
`upTskill` 40) are fixed *inputs* to this model, not outputs. Swiftness would move them and
the model would never notice. loa-gpd scores it zero and says so; we substitute the Spec
number so it is not zero on the screen. Both are wrong, in opposite directions, by an
amount nobody has measured. Family 1 (attack and move speed) has the same problem.

**The support's own flat attack power.** `supportBaseAtk()` is
`sqrt(MS · WP / 6) × (1 + baseApPct)` and stops there. `flatAP` — the ark-grid attack core,
the accessories' "Attack Power +390" rolls — is deliberately left out, because the house
model reads the buff off the *base* figure rather than the total. Flat **weapon** power is
counted, because it sits inside the square root and so genuinely moves the base. This is
the accessory calculator's choice, inherited whole; nobody here has tested it against the
game.

---

## 6. Every constant in the `support:` block

All values copied field for field from `Support.DEFAULTS` in `loa-gpd/model/support.js`,
which took them from the accessory calculator's `P` / `DEFAULTS`. Marked ✱ where the number
also exists elsewhere in our own profile under a different value — see section 8.

**The damage dealer being buffed.** Frozen, not read from the user's own gear. The worth of
a buff should not swing because the support typed a new weapon-power number for itself.

| field | value | what it is |
|---|---|---|
| `dpsWP` | 260918 | 241,367 weapon × (1 + 6% earrings + 2.1% karma) ✱ |
| `dpsMS` | 767170 | 703,826 raw × (1 + 8% skins + 1% stronghold) |
| `dpsAtkPct` | 0.2948 | the dealer's whole attack-power percentage pool: accessories, ancient attack core, node 60, gems, stone, Adrenaline |
| `dpsFlatAtk` | 3600 | called "ancient attack core" upstream ✱ |
| `baseAdd` | 0.3585 | the dealer's own additional damage, the divisor that dilutes `identity` ✱ |

**The support's own buff bases**, in percent, at level-9 gems throughout.

| field | value | what it is |
|---|---|---|
| `brandPower` | 45.00 | brand power; a gem level is worth about a point |
| `allyAtkEnh` | 68.55 | ally attack-power enhancement, the multiplier on the 22% share |
| `allyDmg` | 38.26 | the identity bracket: ark grid + gems |
| `allyDmgT` | 9.26 | the T-skill's own separate bracket |
| `spec` | 1016 | Specialization **before** the bracelet's trait line. The reference Bard runs 1016 spec / 1484 swiftness — 1,484 is what holds the level-10 cooldowns at gem level 9 |
| `classCoeff` | 0.0005005722461 | Bard: spec → identity-buff efficiency, per point |

**Uptimes**, in percent. Fixed inputs. Section 5 explains why that matters.

| field | value |
|---|---|
| `upBrand` | 100 |
| `upAp` | 95 |
| `upSeren` | 70 |
| `upChord` | 70 |
| `upTskill` | 40 |

**One share.**

| field | value | what it is |
|---|---|---|
| `apBuffShare` | 0.22 | the share of its own base attack power a support hands to each ally. `AP_BUFF_SHARE` upstream, where it is a module constant rather than a profile field |

**Dropped on purpose.** `support.js` multiplies Serenade by `(1 + 0.5 · gaugeGain)` for
accessory identity-gain lines. No T4 bracelet family gives specialty-meter gain — the T3
"Enlightenment" effect has no T4 equivalent — so the term has nothing to read and is not
in our copy.

`classCoeff` is one number and it is the Bard's. A Paladin or an Artist has a different
one, and until somebody supplies them, a support score is a Bard score.

---

## 7. What we did not take: their frozen line table

`loa-gpd/model/bracelet.js` carries a hardcoded `SUPPORT_LINE` table — ten families, three
tiers each, written out as numbers. `tools/regen-support-lines.js` produces it; a human
pastes it in.

We do not have one and should not get one. Our `componentMultiplier()` recomputes every
line from the live profile, so when the user changes gear, gems or the dealer being buffed,
the numbers move with them.

Both choices are right for their own tool, and the difference is what the tool is for:

- **loa-gpd is a chart.** One reference character, published once. A frozen table is a
  feature: the ranking does not change between visits, and regenerating it is a deliberate
  act with a diff to review.
- **This is a calculator.** It answers "what is this line worth **to me**". A frozen table
  would give every user the reference Bard's answer and quietly ignore what they typed.

The cost of our choice is that we have to keep proving we agree with them. Section 8 is
that proof.

---

## 8. Cross-check against loa-gpd

Their reference character, as closely as our profile shape allows: `Support.DEFAULTS`
unchanged, plus `Gear.stats(honing-t4upper, {}, 25, 25)` — armour and weapon both +25.
Fed into our profile as

```
mainStatRaw  772,769   msPct 0.09     (skins 8% + stronghold 1%)
weaponPwrRaw 250,887   wpPct 0.1179   (earrings 6% + ark grid 3.69% + karma 2.1%)
baseApPct    0.203     (stone 1.5% + gems 9.8% + Adrenaline 9%)
```

which gives support base attack **238,708.9** on both sides, to the decimal. Script in the
session scratchpad (`xcheck.js`); it hardcodes nothing and loads both repos' live code.

Ancient, low / mid / high, points of damage:

| # | bracelet.md §2 | their frozen table | their script, today | **ours, one dealer** |
|---|---|---|---|---|
| 17 | 1.671 / 1.978 / 2.357 | 1.600 / 1.896 / 2.260 | 1.599 / 1.894 / 2.257 | **1.599 / 1.894 / 2.257** |
| 19 | 1.598 / 1.893 / 2.188 | 1.600 / 1.896 / 2.192 | 1.599 / 1.894 / 2.189 | **1.599 / 1.894 / 2.189** |
| 16 | 1.268 / 1.511 / 1.804 | 1.275 / 1.520 / 1.814 | 1.274 / 1.517 / 1.812 | **1.274 / 1.517 / 1.812** |
| 18 | 0.903 / 1.113 / 1.323 | 0.910 / 1.122 / 1.334 | 0.908 / 1.120 / 1.331 | **0.908 / 1.120 / 1.331** |
| 30 | 0.811 / 1.013 / 1.214 | 0.809 / 1.010 / 1.211 | 0.795 / 0.993 / 1.190 | **0.795 / 0.993 / 1.190** |
| 29 | 0.727 / 0.908 / 1.089 | 0.741 / 0.926 / 1.110 | 0.738 / 0.921 / 1.105 | **0.738 / 0.921 / 1.105** |
| 33 | 0.395 / 0.444 / 0.492 | 0.448 / 0.504 / 0.559 | 0.444 / 0.498 / 0.553 | **0.444 / 0.498 / 0.553** |

**Ours matches their script exactly, to three decimals, on all 21 cells.** Same formula,
same constants, same answer. The port is faithful.

Against the write-up's published table the gaps are:

| # | gap | why |
|---|---|---|
| 33 | **+12.3%** | their reference character moved. `gear.js` gained ark-grid and accessory weapon-power flats, feast, food and Adrenaline's 9% after the write-up went out: support base attack 225,664 → 238,709. Family 33 is pure `ap` and pure gear, so it moves most. Their own frozen table reads 0.448 — our number, not the write-up's |
| 17 | **−4.3%** | **the write-up is wrong here.** Working below |
| 30 | −2.0% | `support.js` DEFAULTS moved: `allyDmg` 37.13 → 38.26 and `allyDmgT` 7.13 → 9.26. Family 30 adds to those brackets, so a bigger base dilutes it |
| 29 | +1.5% | the same gear move as 33, through the same channel, a third the size because 29's rider is smaller |
| 16, 18, 19 | under +0.6% | the same gear move, reaching only the +2/2.5/3% rider half of each line |

Only one of these is a formula difference. The rest is a reference character that moved
between 2026-08-13 and today — and the fact that their own frozen table sits within 1.8% of
us on every cell, while the write-up is 12% out on family 33, says which figures are stale.

### The family-17 finding

**Families 17 and 19 must score the same at low and mid, at every reference character, in
both models.** An ally at 90% crit rate / 280% crit damage has expected factor
`1 + 0.9 × 1.8 = 2.62`. Then

```
crit resist  −A pp   →  factor 1 + (0.9 + A)·1.8       gain 1.8·A
crit dmg res −2A pp  →  factor 1 + 0.9·(1.8 + 2A)      gain 1.8·A
```

Identical. And family 19's roll is exactly twice family 17's at low and mid — 3.6 against
1.8, 4.2 against 2.1 — and both carry the same +2 / +2.5 / +3% rider. The pair only breaks
at the high tier, where 19 rolls 4.8 instead of 5.0 and comes out 0.068 points behind.

`bracelet.md` §2 publishes them 4.6% and 4.5% apart at low and mid. That cannot come out of
the code it cites. loa-gpd's own frozen table has them equal there, as the arithmetic
demands. So §2's family-17 row is stale, and the headline ladder in §3 — 1.759 / 3.111 /
4.364 / 5.085 — is line sums plus `spec × 0.00494`, three of whose four rungs are built on
that row. Their number, their doc; flagged here because we checked against it.

### Where we differ on purpose: the ladder

Their ladder, rebuilt on our model at their reference character, counting one dealer:

| rung | bracelet.md | ours |
|---|---|---|
| 80/80 Relic, one blue (17 low) | 1.759 | 1.701 |
| 90/90 Relic, two blue | 3.111 | 3.053 |
| 100/100 Ancient, two epic | 4.364 | 4.286 |
| 110/110 Ancient, two legendary | 5.085 | 4.993 |

Within 2% at every rung, and the whole of the gap is the stale family-17 row plus the
reference character. The step split comes out at 3.7% / 4.0% / 7.0% against their 4 / 4 /
7%.

### The party count — a real difference, and it needs a decision

`partyMult()` on a support returns `1 + allyDpsCount × allyGain`, and `allyDpsCount` ships
at 2. So the debuff halves of families 16-19 are counted for two dealers while the buff
channels — and the panel's own tooltip, which says a support is scored on "what your buffs
add to one damage dealer" — count one.

| # | ours, one dealer | ours as shipped | inflation |
|---|---|---|---|
| 17 | 1.599 / 1.894 / 2.257 | 2.813 / 3.306 / 3.931 | +76% / +75% / +74% |
| 19 | 1.599 / 1.894 / 2.189 | 2.813 / 3.306 / 3.798 | +76% / +75% / +74% |
| 16 | 1.274 / 1.517 / 1.812 | 2.170 / 2.562 / 3.054 | +70% / +69% / +69% |
| 18 | 0.908 / 1.120 / 1.331 | 1.444 / 1.773 / 2.102 | +59% / +58% / +58% |

Two answers are self-consistent and 2 is neither of them:

1. **One dealer throughout** (loa-gpd's), with the party multiplier applied on the gold
   axis — `goldPerDamage` there divides by `damagePct × partySize`, `partySize` 3.
2. **Party units throughout**, which means three dealers on the debuff halves *and* three
   on the buff channels, because a support's party holds three dealers and the support is
   not one of them.

Under either, `allyDpsCount = 2` is wrong for a support: the field means "how many *other*
damage dealers", which is right when you are a dealer and one short when you are not. The
effect is not cosmetic — it lifts the shred families by about 1.76× against families 29,
30 and 33, which reorders what the advisor tells a support to lock and reroll.

Our gold axis has no party multiplier at all today (`goldPer1Pct` is a plain multiply), so
reading 1 also needs the gold side settled before a support ever sees a price.

---

## 9. The number to put on the screen

From `bracelet.md` §3, and it reproduces on our model:

> Across the 80/80 → 110/110 ladder, the stat numbers carry **4 to 7% of each step**. The
> lines carry the rest.

Ten points of Specialization is 0.0497 points of damage, every rung, all the way up. The
lines are worth thirteen to twenty-six times that. People shop for bracelets by the trait
number and pay for the wrong thing, and the tool should say so out loud.

---

## 10. Open questions

- **The party count.** SETTLED, 2026-08-14. A support is scored on ONE damage dealer, the
  same unit `supportGain` measures. `partyMult` used to return `1 + allyDpsCount ×
  allyGain` for a support, so the party-debuff half of families 16-19 counted two dealers
  while the ally attack-power rider on the same line counted one — one line on two party
  sizes at once, inflating those four families about 1.65× against the clean buff lines.
  Party size belongs on the gold axis, not here.
## 10b. One dealer, and only one

**SETTLED, Shizu, 2026-08-14.** Every support figure this tool reports — score,
percentage, gold — is what ONE damage dealer gains. There is no party multiplier in
the model and none is wanted.

loa-gpd carries `partySize: 3` and divides by it on its gold axis, because its job
is the party's gold per damage. Ours is different: a support's number has to be
readable against a damage dealer's own bracelet, and multiplying one axis by three
would make that comparison meaningless.

Both halves of a party line follow the rule. The debuff half of families 16-19 goes
through the same crit and defence functions the damage-dealer side uses, counted
once; the ally attack-power rider goes through `supportGain`, also counted once.
Those two used to disagree — `partyMult` counted `allyDpsCount` dealers for the
debuff and one for the rider — which is the bug named in §10.

The party-wide figure is simply three times what is shown. Anyone who wants it can
multiply.

## 11. Base attack power % is not attack power %

**SETTLED, Shizu, 2026-08-14: base AP% and AP% are different stats. Do not merge them.**

`baseApPct` is BASE attack power %, and it has two sources and no others — the eleven
damage gems and the ability stone. That is why it ships at 0.125 and why an import
builds it from the gems and the stone alone.

The wider pool — accessory Attack Power % lines, the ark-grid attack core's percentage
thresholds, the level-60 side node, Adrenaline — is a SEPARATE bucket. It multiplies the
whole attack-power term, flats included. On the dealer's side of the support model that
bucket is `support.dpsAtkPct`, which is exactly where it belongs; on the support's own
side it does not appear, because the ally attack-power buff is a share of the support's
BASE attack power and the wider bucket never reaches it.

So the model is right as written, and the 4.5% gap against loa-gpd's figure is loa-gpd's
to close, not ours. `loa-gpd/docs/research/reference-character.md` lists our 0.125 as the
first of "three problems worth naming", on the grounds that it "omits the accessories, the
ark grid core and the side node — 8.0 percentage points of bucket". Those eight points are
AP%, not base AP%. Folding them into `baseApPct` would put them inside the square root,
where they do not belong, and would overstate every support buff that reads off the base
figure.

**Do not "fix" this.** It has been raised and ruled on twice.

## 12. Still open

- **Three constants that disagree with our own profile.** `support.baseAdd` 0.3585 against
  this profile's own additional-damage pool of 0.3844; `support.dpsWP` built on 2.1% karma
  against our `wpPct`'s 2.5%; `support.dpsFlatAtk` 3600 against an ancient attack core's
  2700 in `baseline-derivation.md`. All three are the accessory calculator's numbers,
  inherited whole. Each is small on its own. They should still be reconciled or the reason
  for each written down.
- **`classCoeff` is Bard-only.** No Paladin or Artist coefficient exists anywhere in the
  house model.
- **`supportBaseAtk`, `supportContribution` and `supportGain` are not exported.** Anything
  outside the module — `loa-gpd/tools/regen-support-lines.js` already reaches in for
  `allyCritFactor` and `defShredGain` — has to go round through `componentMultiplier`.
  (`verify.js` §4d re-derives the whole channel by hand instead, which for a verifier is
  the stronger move: it checks the model rather than calling it.)
- **The party count is not pinned by anything.** `verify.js` and `verify.py` §4d now cover
  the support channel — the contribution of a naked support, families 29/30 against a
  hand-derived gain, the zeroes, weapon power and main stat — but nothing tests what
  families 16-19 do with `allyDpsCount`, which is the one number in dispute.
- **A partial `support` block replaces the defaults** rather than merging with them, on both
  sides, on purpose and pinned by `verify`. It is still a real way for a caller to turn
  every support score into `NaN`; `profile.js` sends the whole block every time and says why.
- **Family 28 pays a support 0.1 points per percent of shield and heal**, which is not
  damage and is not in loa-gpd's model. Placeholder.

---

## Sources

- `loa-gpd/docs/research/bracelet.md` — the research, and the source of truth for what a
  support bracelet is worth.
- `loa-gpd/model/support.js`, `loa-gpd/model/gear.js`, `loa-gpd/data/honing-t4upper.json`,
  `loa-gpd/tools/regen-support-lines.js`, `loa-gpd/model/bracelet.js` (`SUPPORT_LINE`).
- `loastuff/lost-ark-accessories/METHODOLOGY.md` §3 — where the constants started.
- Local: `docs/research/damage-model-spec.md`, `docs/research/baseline-derivation.md`,
  `docs/research/official-probabilities.md`, `model/bracelet.js`, `model/bracelet.py`,
  `data/bracelet-data.js`.
