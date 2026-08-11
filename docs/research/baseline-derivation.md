# Baseline WP / main stat / damage buckets (bebkok + Arsonistic, extracted 2026-08-11)

Sources: bebkok "LOA Sup buff calc v3.81" (sheet 1le-LqVr9l4dXxBDlPaSMNpf6tDVfvfsFE_QRIAmVONE,
tabs `Gear data (Serca)`, `DPS players data (Serca)`) and Arsonistic's DPS sheet v1.2
(1_0J7liyM_yw16pyn6TKlF1YGaIt5n_A9hSoLnT3yTUc, tabs `Calc`, `Brace`, `ArkGrid`, `Acc`).
Downloaded copies in the 2026-08-11 session scratchpad. Official probability doc still
wins on roll values; this doc governs the damage model.

## Serca gear table (honing level → per-piece main stat / weapon WP)

Level 0 = ilvl 1675, +5 ilvl per level, level 25 = 1800. Verbatim from bebkok:

| Lv | ilvl | Head | Shoulder | Chest | Pants | Gloves | Weapon WP |
|---|---|---|---|---|---|---|---|
| 0 | 1675 | 72017 | 76646 | 57614 | 62242 | 86421 | 124793 |
| 1 | 1680 | 73903 | 78654 | 59123 | 63872 | 88684 | 128059 |
| 2 | 1685 | 75855 | 80731 | 60684 | 65559 | 91026 | 131439 |
| 3 | 1690 | 77875 | 82881 | 62300 | 67306 | 93450 | 134936 |
| 4 | 1695 | 79965 | 85106 | 63973 | 69113 | 95959 | 138556 |
| 5 | 1700 | 82129 | 87410 | 65704 | 70983 | 98556 | 142303 |
| 6 | 1705 | 84369 | 89793 | 67497 | 72919 | 101244 | 146182 |
| 7 | 1710 | 86688 | 92261 | 69351 | 74922 | 104025 | 150196 |
| 8 | 1715 | 89087 | 94815 | 71270 | 76996 | 106905 | 154350 |
| 9 | 1720 | 91570 | 97457 | 73257 | 79142 | 109885 | 158649 |
| 10 | 1725 | 94140 | 100193 | 75313 | 81364 | 112969 | 163099 |
| 11 | 1730 | 96801 | 103023 | 77441 | 83664 | 116161 | 167706 |
| 12 | 1735 | 99554 | 105954 | 79644 | 86043 | 119465 | 172473 |
| 13 | 1740 | 102404 | 108987 | 81924 | 88506 | 122885 | 177406 |
| 14 | 1745 | 105353 | 112126 | 84283 | 91056 | 126425 | 182514 |
| 15 | 1750 | 108406 | 115375 | 86725 | 93693 | 130087 | 187799 |
| 16 | 1755 | 111565 | 118738 | 89253 | 96424 | 133879 | 193270 |
| 17 | 1760 | 114358 | 121709 | 91486 | 98838 | 137229 | 198101 |
| 18 | 1765 | 117218 | 124754 | 93775 | 101310 | 140662 | 203054 |
| 19 | 1770 | 120150 | 127874 | 96120 | 103844 | 144180 | 208130 |
| 20 | 1775 | 123155 | 131072 | 98524 | 106441 | 147786 | 213333 |
| 21 | 1780 | 126236 | 134351 | 100989 | 109104 | 151483 | 218667 |
| 22 | 1785 | 129393 | 137711 | 103514 | 111833 | 155271 | 224133 |
| 23 | 1790 | 132629 | 141155 | 106103 | 114630 | 159155 | 229737 |
| 24 | 1795 | 135946 | 144686 | 108757 | 117497 | 163136 | 235480 |
| 25 | 1800 | 139346 | 148304 | 111477 | 120435 | 167216 | 241367 |

Character ilvl = ROUND(mean of the six piece ilvls, 2). Default build weapon 25,
gloves 23, others 21 → exactly 1785. (Aegir-gear table exists in the sheet too, with
Advanced Honing +2%/+5% multipliers; Serca gear has no AH bonus. Not needed for v1.)

## Baseline assembly

Main stat raw = Σ five armor pieces + accessories + base 477 + roster bonus (default
2085). Accessories at max (loseii lost-ark-accessories MAIN_RANGE tops, no flats):
neck 17,857 + 2× earring 13,889 + 2× ring 12,897 = **71,429**.
Main stat total = raw × (1 + msPct); **msPct default 0.08 (skins, per Shizu)**;
stronghold ranch would add +0.01 (option, off by default).

Weapon power raw = weapon table value (accessory WP flats = 0 under no-flats).
WP total = raw × (1 + wpPct); wpPct = earring WP% lines 3%×2 = **6%** at max-no-flats
+ karma (sheets: up to 3%, 2.5% "non-whale"; default TBD by Shizu).

Attack power = sqrt(MStot × WPtot / 6) × (1 + baseApPct) + flatAP
- baseApPct = damage gems + ability stone (lv8 gems ×11 ≈ 8.8% + stone ≥9/7 1.5%);
  cancels in most ratios but shifts the sqrt-vs-flat balance.
- flatAP: accessories 0 (no flats); ark-grid cores would give ~2700–3090 (default TBD).
- The overall AP% bucket (accessory AP% 3.1%, Adrenaline, etc.) multiplies the whole
  AP term → cancels out of every bracelet-line ratio; ignore it.

Default 1785 baseline (msPct 8%, before karma/flatAP decisions):
armor MS 629,835 → raw 703,826 → MS_tot 760,132; WP raw 241,367.

## Bracelet-line scoring corrections (vs the naive spec)

1. **Flat AP breaks pure sqrt.** Gain of +ΔWP =
   (sqrt((WPraw+Δ)(1+wpPct) × MStot/6)(1+baseApPct) + flatAP) / (same with Δ=0).
   Main-stat lines likewise, with Δ × (1+msPct) — i.e. percent buckets amplify added
   raw stat; with flatAP=0 this reduces to the sqrt ratio.
2. **Crit-hit-damage rider** (families 11/12 "+1.5% damage on crit"): crit branch is
   1 + cr·(cd·(1+chd) − 1). The rider adds chd +0.015, NOT additional damage.
3. **Master node = +7% crit rate AND +8.5% additional damage** (Arsonistic Calc!E24/E25;
   note says Master is the only temporary AddDmg buff). Shizu's "Master +7% AddDmg" was
   off — pending his confirmation, the toggle applies both numbers.
4. **Additional-damage baseline pool** = weapon quality 0.30 + pet 0.01 + neck 0.026 +
   astrogem grid **0.0484** (60 levels × 0.080667%/lvl per loseii astrogem.js; bebkok
   0.08086, Arsonistic 0.08077 — spread irrelevant) = **0.3844** (+0.085 if Master on).
   Line value = (1+pool+Δ)/(1+pool).
5. **Demon-damage line dilutes** against existing demon sources: sheets carry ~7%
   (cards/pets, "up to 7.3%"); factor (1 + Δ/(1+0.073)) applied × demon-boss share.
6. **Outgoing damage is its own multiplicative bucket** (sheet multiplies outgoing
   sources) → bracelet outgoing line = flat ×(1+Δ), no dilution.
7. **Family 15 (+dmg, +2% cooldown)**: sheet scores it as the mean of burst gain
   (full +A%) and sustained gain (+A% then ÷1.02) → cooldownPenaltyWeight input,
   default 0.5.
8. **Stagger share default 5%** of damage dealt during stagger windows (sheet Brace!Q16).
9. **Positional base facts** (for share inputs): front attack ×1.20 base; back attack
   ×1.05 and +10% crit rate. Bracelet positional lines apply to that skill share only.
10. **Speed/utility families (1, 10 etc.)** stay 0 damage in v1 (attack-speed value via
    Raid Captain exists in the sheets but is out of scope).
11. **Bracelet basic-stat values are CONTINUOUS bands** (official page), not the four
    tier points Arsonistic's Brace tab lists — official wins. Live payload Int +13888
    fits official band 7 (13441–14080). ✔

## Cross-checks

- Arsonistic's Brace tab line values match the official probability table exactly
  (Relic-low column = Relic grade low tier). Independent confirmation of family values.
- Loseii accessory-tool defaults (MS 750k, WP 250k, additional 35.85%) sit within a few
  % of the bebkok-derived 1785 baseline — consistent.
- Other ark-grid side-node coefficients (per level): AP 0.0003667, boss dmg 0.000834
  (bebkok S4:S9) — future use.

## Shizu's rulings (2026-08-11)

- **Master toggle = +7% additional damage only** (his call, overriding Arsonistic's
  +7% crit / +8.5% AddDmg — do not "fix" this without asking him).
- karma WP% = **2.5%** → baseline wpPct = 0.085.
- ranch included → baseline msPct = **0.09**.
- ark-grid flat AP **2700** included → flatAP default 2700.
- baseApPct default = **full level-9 damage gems + 9/7 stone** = 11 × 1.0% + 1.5% =
  **0.125**, adjustable (per-gem: lv7 0.6% / lv8 0.8% / lv9 1.0% / lv10 1.2%).
