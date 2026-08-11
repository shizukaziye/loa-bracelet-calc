# Input UI overhaul — design blueprint (Fable, from Shizu's spec, 2026-08-11)

Principle: **mouse-first**. Sliders for quantities, segmented buttons for small option
sets, toggle buttons for on/off. Typing only where a number is truly free-form
(baseline %, WP/MS override, skill name). Every slider shows its value in a chip that
updates live. All controls persist to localStorage as before.

## Layout (desktop ≥900px)

Replace the single CHARACTER panel body with a two-column control deck inside the same
sticky panel. Results area below is unchanged.

```
+--------------------------------- CHARACTER ---------------------------------+
| GEAR                                    |  FIGHT                             |
|  Weapon   [=========o----] +25          |  Back attack    [o------------] 0% |
|  Head     [=======o------] +21          |  Front attack   [o------------] 0% |
|  Shoulder [=======o------] +21          |  Non-directional[o------------] 0% |
|  Chest    [=======o------] +21          |  CD penalty wt  [=========o---] 70%|
|  Pants    [=======o------] +21          |  [ Demon boss ]  (toggle, off)     |
|  Gloves   [========o-----] +23          |                                    |
|                          ITEM LEVEL     |  SKILLS                            |
|                            1785.00      |   [name  ] share [====o] 100%      |
|  Neck bonus   [0%|0.7%|1.6%|2.6%]       |          crit  [=========o] 90%    |
|  Earring 1 WP%[0%|0.8%|1.8%|3%]         |          cdmg  [======o---] 280%   |
|  Earring 2 WP%[0%|0.8%|1.8%|3%]         |   [+ Add skill]                    |
|  Gems (x11)   [6|---7---8---o9---10]    |                                    |
|  [ 9/7 stone ON ] [ Master OFF ]        |  ECONOMY                           |
|                                         |   gpd [dropdown]  baseline [num]   |
|  [Advanced v]  [Reset]                  |                                    |
+-----------------------------------------------------------------------------+
```

Mobile (<900px): single column, order = GEAR, ilvl readout, accessory/gem controls,
FIGHT, SKILLS, ECONOMY.

## Left column — GEAR

1. **Six honing sliders**, one per piece, order Weapon, Head, Shoulder, Chest, Pants,
   Gloves. Range 0–25, step 1, defaults W25 / G23 / others 21. Weapon's track uses the
   accent color (it alone drives WP). Value chip shows "+N".
2. **ITEM LEVEL readout** top-right of the gear block: big numeral (~28px,
   accent-colored), label "ITEM LEVEL" above it in .note style. Live = round(mean of
   six piece ilvls, 2). This is the anchor the eye checks after any slider move.
3. **Neck bonus** segmented control, options **0% / 0.7% / 1.6% / 2.6%**, default 2.6%.
   Sets the neck term of the additional-damage pool. Label "Neck · additional damage".
   (0.7 is Arsonistic's low tier; Shizu chose these four options explicitly.)
4. **Earring 1 / Earring 2 WP%** — two separate segmented controls, options
   **0% / 0.8% / 1.8% / 3%**, default 3% each. wpPct = earring1 + earring2 + karma
   (karma stays in Advanced, default 2.5%).
5. **Gems slider**: discrete 6/7/8/9/10 with tick marks and labels under the track,
   default 9. Label "Damage gems (all eleven)". Per-gem base-AP%: lv6 0.4 / lv7 0.6 /
   lv8 0.8 / lv9 1.0 / lv10 1.2; baseApPct = 11 × per-gem + stone.
6. **Buttons row**: `[9/7 stone]` toggle default ON (+1.5% base AP);
   `[Master]` toggle default OFF (+7% additional damage — Shizu's ruling, unchanged).
   House .mbtn style with a clear on state (accent border + fill), state word inside
   the button ("9/7 stone · on").

The "Enter WP / main stat directly" override checkbox stays, ABOVE the sliders; when
checked it swaps the six sliders + accessory controls for the two number fields
(unchanged behavior).

## Right column — FIGHT

Sliders (0–100%, step 1, value chip "N%"):
- Back attack share, default 0
- Front attack share, default 0
- Non-directional share, default 0
- **Cooldown penalty weight, default 70%** (spec change from 50% — update model
  default + refs + Method copy)

Toggle button: **Demon boss** default OFF. ON sets demonShare = 1, OFF = 0 (dilution
pool 7.3% unchanged, stays in Advanced).

## TRAITS (right column, between FIGHT and SKILLS) — added by Shizu mid-build

The bracelet's two fixed combat-trait lines now carry value in the score.

1. **Two weight sliders** — Spec / Swiftness weight only, range **0–4%, step 0.1,
   default 2.5%** each. Unit: **% damage per 100 trait points**. Crit gets NO slider
   (Shizu 2026-08-11): a crit trait line converts exactly at **35% crit rate per 699
   points** (value × 35/699 pp) and is scored through the per-skill crit model —
   additive with the other crit-rate sources before the 100% cap, same path as
   granted family 31.
2. **Starting trait values on the bracelet** — three slider rows (Crit, Spec,
   Swiftness), each with an active toggle; **exactly two active** (activating a third
   deactivates the least-recently-touched; with two active the toggles of active rows
   can swap but never drop below/above two). Active slider range = the official band:
   **Ancient 61–120, Relic 41–100** (switches with grade). Inactive trait = 0.
   Default: Crit 120 + Spec 120 active, Swiftness inactive.
3. Scoring: trait contribution = Σ_active value × weight ÷ 100, added as
   percentage points in the same log-space convention as line scores. It is a
   CONSTANT offset w.r.t. rerolling (fixed lines never reroll) — it must appear in
   currentScore, expectedFinal, valueGold, and the per-line breakdown (two rows for
   the fixed traits), but the DP's decisions are unaffected by construction; do NOT
   thread it through the DP state.
4. Trait rows live in the BRACELET panel (they are bracelet lines, above the granted
   slots); the three WEIGHT sliders live in the FIGHT column (they are character
   properties).



Keep current structure, but:
- **Name field much narrower** (~110px, placeholder "name") — Shizu's complaint.
- Share / crit rate / crit damage become **sliders** with value chips:
  share 0–100 step 1; crit rate 0–100 step 1 default 90; crit damage 100–400 step 5
  default 280.
- **Shares must sum to 100 — enforced, not hinted**: with one skill the share slider
  is locked at 100 (disabled look). With N>1, moving one slider proportionally
  rebalances the others so the total is always exactly 100 (largest-remainder to keep
  integers); a new skill enters at an equal share. Remove the old "shares sum to 100%"
  hint text — impossible states shouldn't exist.

## ECONOMY (right column, bottom)

Unchanged: gpd dropdown + baseline % number field.

## Advanced fold (everything Shizu didn't name)

msPct, karma WP%, baseApPct fine-override, flatAP, accessory main stat, roster bonus,
AddDmg components other than neck (weapon 30%, pet 1%, astrogem 4.84%), demon pool
7.3%, shield uptime 60%, enemy DR 50%, stagger share (**default now 10%**, spec
change), fixed-lines editor. WP-line (families 20/21/22) uptime/stack assumptions:
**fix at 100% and REMOVE from Advanced** (hard assumption now, note it in Method).

## Model default changes (update model/bracelet.js + bracelet.py + refs + Method)

- cooldownPenaltyWeight 0.5 → **0.7**
- staggerShare 0.05 → **0.10**
- families 20/21/22 uptime/stacks → **1.0 (max stacks, full uptime)**
- keep both verify batteries green; update the affected ref values deliberately
  (recompute by hand where the case is hand-derived, don't just paste outputs).

## Shizu's live-review revisions (2026-08-11, during build)

1. FIGHT sliders renamed + redefaulted: **"Back" 100%**, **"Front" 100%**,
   **"Hitmaster"** (was non-directional) **100%**.
2. Delete the explainer texts "— what a trait line is worth to you" and "Crit needs
   no weight: …" (the tooltips carry that job).
3. SKILLS: back to **typed number inputs** in rows (Shizu reversed the slider call for
   this section only). Narrow name field stays; shares still enforced to sum 100.
4. ECONOMY becomes sliders: **baseline 0–25%**; **gpd logarithmic 100k–10M** (log-scale
   track, value chip shows e.g. "1.50M").
5. The inputs panel must NOT require collapsing to reach results: normal document flow
   (no full-height sticky trap), page scroll reveals results. Collapse stays available
   but triggers from a click anywhere on the panel header, not just the arrow.
6. Gear slider order: Head, Shoulder, Chest, Pants, Gloves, **Weapon last**.
7. More data-gloss tooltips "anywhere that might seem weird" — Shizu loves them.
   Candidates: ilvl readout, neck bonus, earring WP%, gems slider, 9/7 stone, Master,
   Demon boss, CD penalty weight, trait active toggles, spec/swift weights, unrolled
   card, P(improve), quantile strip, mask table headers, baseline, gpd.
8. Phase 4 note (not this build): the leaderboard scores everyone with the DEFAULT
   profile — canonical defaults, not each player's tweaked knobs.

## Granted-slot picker redesign (Shizu, 2026-08-11)

The family picker must NOT show roll values (+X%) — values depend on the tier, which
is the second box's job, and per-option value coloring confused him.

1. **Family box**: family name only, prefixed with an **astrogem-style letter grade
   (F→S)** using the astrogem calculator's grade colors (copy the palette/classes from
   loa-astrogem-calc). The grade rates the family's AVERAGE roll under the canonical
   default profile: score each tier, weight by within-family tier odds (6:3:1 →
   0.6/0.3/0.1), then band RELATIVE to the best family's average. Bands: monotone,
   round thresholds, zero-damage families = F, best family = S. Grade is computed
   from defaults, NOT the user's current knobs (stable labels).
2. **Tier box**: three options with the actual values and the in-game rarity colors —
   Rare (blue) / Epic (purple) / Legendary (gold), e.g. "Legendary — +10%". Color the
   selected state accordingly.
3. **Row order (Shizu, live review): tier box FIRST, family box SECOND.** The family
   select is currently far too wide — shrink it (truncate long labels with ellipsis,
   full text in the tooltip/title); the tier box is narrow and leads the row.
4. Bracelet trait VALUE fields (crit/spec/swift starting values): **typed number
   inputs, not sliders** (Shizu). Keep the band clamp (Ancient 61–120 / Relic 41–100)
   and the exactly-two-active toggles. The spec/swift WEIGHT controls stay sliders.

## Craft notes

- Segmented controls and toggles are buttons with aria-pressed; sliders are native
  <input type=range> styled to the house theme (accent thumb, .panel2 track) — no
  custom drag code.
- Slider changes go through the existing 300ms debounce → worker; segmented/toggle
  changes solve immediately.
- Value chips are text, not inputs — except crit damage and baseline where a click on
  the chip turns it into a tiny number input (escape hatch for precise values).
- Bump ?v= on every touched file.
