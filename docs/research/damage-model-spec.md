# Damage model spec (Shizu, 2026-08-11)

## Objective & flow (Shizu, revised 2026-08-11)

- **Rerolls are essentially free.** No per-attempt cost in the DP. The cost is the
  bracelet itself.
- Valuation: given **gpd** (gold per 1% damage, loa-theorycraft convention) and a
  **baseline** (damage % of the bracelet you'd otherwise use, default 0), any state is
  worth `(E[final % | optimal play] − baseline) × gpd`. An unrolled ("empty") bracelet's
  value = what a buyer should pay for it. Slot count (2 vs 3 granted) is a user input
  and moves this a lot.
- With free rolls + keep-or-replace, rolling weakly dominates stopping: always use all
  rolls. Real decisions: lock mask before each roll, keep vs replace after. Keep/replace
  must compare CONTINUATION values V(·, n−1), not immediate scores.
- Interactive flow like cutting an astrogem: player rolls in game, enters the result,
  tool answers keep or replace, what to lock next, and the bracelet's current value.
- **Both roles score** as of 2026-08-14. The support model is the house one, ported from
  `loa-gpd/model/support.js` — see the Support section below and
  `docs/research/support-model.md`. It replaced a stub whose flat per-percent constants ran
  about double the truth.
- Fresh bracelet = 4 rolls + 3 ticket rolls (default 7 attempts, user-adjustable).

Every effect tier's damage % must be computed from character inputs, not hardcoded.

## Attack power / weapon power / main stat

- Damage is linear in attack power; base attack power = sqrt(weapon_power × main_stat / 6).
  So damage scales with sqrt(WP) and sqrt(main stat).
- Bracelet WP line +ΔWP → multiplier sqrt((WP+ΔWP)/WP); main-stat line likewise.
- Baseline WP and main stat derive from gear, per **bebkok's calculator** (research pending):
  user sets ILVL, default **1785** = weapon +25, gloves +23, rest +21.
  Accessories: max stats per loseii's accessory information (lost-ark-accessories tool),
  **no flat-stat rolls**. **8% skin bonus** assumed.

## Crit

- Default one skill: **90% crit rate, 280% crit damage**. 280% means a crit deals 2.8×
  (NOT 1+2.8). Expected factor per skill: (1−cr) + cr·cd.
- User can add skills, each with damage share, crit rate, crit damage. Shares weight the
  per-skill multipliers: total mult = Σ share·mult_skill.
- Crit rate capped at 100% when adding bracelet lines.

## Additional damage

- Additive with itself, one pool, then multiplies total damage as (1 + pool).
- Baseline pool: weapon quality 100 = **30%** + pet **1%** + astrogem level-60
  additional damage (value from loseii astrogem methodology — research pending) + high
  addl-damage neck **2.6%**. Optional toggle: **Master +7%**.
- No other sources besides the bracelet (per Shizu).

## Party debuff lines scored for DPS (families 16, 17, 19)

The three enemy-shred lines have DPS value (one instance per party; assume wearer is the
only source). Shizu's model (2026-08-11):

- Crit resist −A% → +A pp crit rate for the whole party. Crit damage resist −A% →
  +A pp crit damage for the whole party. Defense −A% → damage gain for the whole party
  via the enemy damage-reduction model: gain = (D+K)/(D(1−A)+K) i.e. computed from an
  enemy base damage-reduction input (default 50%, adjustable; confirm vs the DPS sheet).
- Self: apply through your own skills model (crit rate capped at 100%).
- Allies: **two ally DPS**, each assumed to deal the same damage as you WITHOUT the
  bracelet line, with fixed 90% crit rate / 280% crit damage. Score contribution =
  self gain % + 2 × ally gain % (ally extra damage counts as your extra damage, in
  units of your own baseline damage).
- The "ally Attack Power buff effect +B%" rider on these lines scores 0 for DPS (it
  scales a buff only supports provide); it scores for the support role instead.
- Family 18 (shielded-target damage +A%) also scores for DPS (revised 2026-08-11):
  party-wide flat damage +A% at **60% shield uptime** (default, adjustable). Self and
  both allies each gain 0.6·A%; score = selfGain% + 2 × allyGain%. Its +B% AP-buff
  rider is 0 for DPS like the others.

## Support

Full write-up, every constant and the cross-check against loa-gpd: `support-model.md`.
The rulings:

- A support is scored by what its buffs add to **one** damage dealer, above a support
  wearing nothing. Its own damage is never counted.
  `Q = 100·ln(ap · brand · identity)`, three channels each scaled by its own uptime.
  - `ap` — the support hands each ally `0.22 × (1 + allyAtkEnh)` of its own **base** attack
    power, which then rides the dealer's own attack-power percentage. The only channel the
    support's own gear reaches, so weapon-power and main-stat lines are not dead weight.
  - `brand` — 10% damage scaled by brand power. No T4 line feeds it, so it cancels out of
    every bracelet score today.
  - `identity` — Serenade, Major Chord and the T-skill all raise the dealer's **additional
    damage**, so they share one bracket and are then divided by `(1 + baseAdd)`: the dealer's
    own additional damage dilutes the buff.
- The support's **flat attack power is deliberately excluded** from the buff base (the house
  model reads the base figure, not the total). Flat **weapon** power is counted — it sits
  inside the square root.
- **The party debuff halves of families 16-19 are NOT in the support model.** They land on
  every dealer whoever applies them, so they run through the same `allyCritFactor` /
  `defShredGain` / shield-uptime path this spec already fixes for DPS. One code path, so the
  two roles cannot disagree about what a shred line does. The ally AP rider is the only half
  that differs by role — 0 for a DPS, real for a support — which is why those four families
  belong on the support.
- **Specialization** is scored by running the bracelet's trait points through the identity
  bracket (`spec × classCoeff`), not by the class weights. **Swiftness is priced the same**
  (Shizu): the model has no channel for it, but in game it shortens the buff cycle, which
  would lift the uptimes this model takes as fixed inputs. Crit, Domination, Endurance and
  Expertise score 0.
- Everything that only moves the support's own damage scores **0**: crit, additional damage,
  outgoing, positional, stagger, demon. A support bracelet carrying three fat DPS lines is a
  blank bracelet.
- **Open:** `partyMult()` counts `allyDpsCount` (default 2) dealers on the debuff halves
  while the buff channels count one, so the two halves of families 16-19 are on different
  scales — about 1.7× too much weight on the shred families. loa-gpd counts one dealer
  throughout and multiplies by party size on the gold axis. Needs a ruling; see
  `support-model.md` §8.

## Other buckets

- "Damage to enemies +X%" (outgoing), stagger, demon, positional (back/front),
  non-directional: own multiplicative buckets scaled by share/uptime inputs.
- Conditional WP lines (families 20/21/22): effective-WP with stated stack/uptime
  assumptions, documented per family.

## References to mine (research pending)

- bebkok's calculator: WP + main stat per ilvl/gear piece; ask Shizu if inputs are
  missing once inspected.
- DPS sheet: https://docs.google.com/spreadsheets/d/1_0J7liyM_yw16pyn6TKlF1YGaIt5n_A9hSoLnT3yTUc/
  (Shizu doesn't fully understand it; scan for buckets this model misses.)
- loseii astrogem methodology (loastuff/loa-astrogem-calc docs) for the astrogem
  additional-damage value at level 60.
