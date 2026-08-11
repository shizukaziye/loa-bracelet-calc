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
- **DPS only for now** (support scoring stays a stub).
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
