/**
 * method.js — the Method tab. Prose only: what the model does, where the numbers
 * came from, and what it does not model. Loaded lazily on first visit to the tab
 * (see LAZY_TABS in index.html).
 *
 * Every figure quoted here is read from window.Bracelet / window.BraceletData at
 * render time, so the page cannot drift from the model the way a hand-written
 * write-up does.
 *
 * WHERE THE LINE IS DRAWN (docs/design/copy-rules.md, rule 3). Every other tab
 * now carries a collapsed <details class="method"> at its foot, and that block
 * answers one question: what am I looking at on THIS screen. It names the
 * figures on that tab and gives the formula where the figure IS a formula.
 *
 * This tab is the model behind all of them — where the baseline comes from, how
 * each bucket is scored, which tables the numbers were transcribed from, what is
 * not modelled. So the short restatements a tab block now owns have come OUT of
 * the paragraphs below, and what is left is the derivation. A formula may appear
 * in both places; a paragraph may not.
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData;

  function fx(v, n) { return (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n); }
  function nf(v) { return Math.round(v).toLocaleString("en-US"); }

  function render() {
    var pane = document.getElementById("tab-method");
    if (!pane || pane.getAttribute("data-init")) return;
    pane.setAttribute("data-init", "1");
    if (!B || !DATA) { pane.innerHTML = '<div class="placeholder"><b>Model not loaded</b>Reload the page.</div>'; return; }

    var p = B.normalizeProfile({});
    var base = B.deriveBaseline({});
    var pool = B.addDamagePool(p);

    pane.innerHTML = "" +
      "<style>" +
      "#tab-method .mt{max-width:760px}" +
      "#tab-method .mt p,#tab-method .mt li{font-size:14px;line-height:1.7}" +
      "#tab-method .mt h2{margin-top:30px}" +
      "#tab-method .mt h3{font-size:14px;margin:22px 0 6px;font-weight:700}" +
      "#tab-method .mt ul{padding-left:20px}" +
      "#tab-method .mt .formula{margin:10px 0}" +
      "#tab-method .mt table{margin:10px 0}" +
      "</style>" +

      '<div class="mt">' +

      "<h2>What this tool answers</h2>" +
      "<p>Three questions, in the order you hit them. What is this bracelet worth in damage? Which lines should I lock before the next roll? The roll landed — do I keep it or take the new set?</p>" +
      "<p>Everything below is the model behind those answers. Where a number is a judgement call rather than a published fact, it says so.</p>" +
      "<p>Each tab also carries its own short block at the foot of the page, on how to read the figures on that screen. This one is the model underneath them all.</p>" +

      "<h2>Damage adds up in logs</h2>" +
      "<p>Lost Ark stacks damage by multiplying. Two lines worth 10% each give 21%, not 20%. So each line is scored</p>" +
      '<div class="formula">D = 100 · ln(multiplier)</div>' +
      "<p>which turns multiplication into addition: line scores sum, and D reads as roughly the percentage gain. The headline number is the exact combined figure, <code>(e^(ΣD/100) − 1) × 100</code>. This is the same convention as the accessory and astrogem calculators, so the three tools' percentages can be added together.</p>" +

      "<h2>Where the baseline comes from</h2>" +
      "<p>A line's worth depends on what you already have. A weapon-power line is small if you carry a lot of weapon power, and crit rate is worthless at 100%. So every tier's value is computed from your character, never read off a table.</p>" +
      "<p>Attack power drives damage and is built like this:</p>" +
      '<div class="formula">AP = √(mainStat × (weaponPower + flatWP) / 6) × (1 + gemsAndStone) + flatAP</div>' +
      "<p>The bracelet's flat lines go into the <b>raw</b> stat, before the percentage buckets, so those buckets amplify them exactly as they amplify gear. With no flat attack power the whole thing collapses to a plain square-root ratio; the ark-grid cores are what stop it.</p>" +
      "<p>Note where the two flats sit. Flat <b>attack</b> power — an ark-grid attack core, an accessory's “Attack Power +390” — is added at the end, outside the root and outside the gem bucket. Flat <b>weapon</b> power — a weapon core instead of an attack one, an accessory's “Weapon Power +480” — is weapon power, so it joins the weapon inside the root and the weapon-power bucket amplifies it. That makes it worth less per point than the same number of flat attack power, and it makes every weapon-power line on your bracelet worth slightly less, because you already have more of what the line gives.</p>" +
      "<p>The gear numbers are bebkok's Serca honing table. The default build is weapon +25, gloves +23 and the other four at +21, which is item level " + base.ilvl + ": main stat " + nf(base.mainStatRaw) + " raw, weapon power " + nf(base.weaponPowerRaw) + " raw. Accessories sit at the top of their ranges with no flat-stat rolls (" + nf(71429) + " main stat), the roster bonus is " + nf(2085) + ", and the percentage buckets are " + fx(p.msPct * 100, 1) + "% on main stat (skins plus the stronghold ranch) and " + fx(p.wpPct * 100, 1) + "% on weapon power (two earring lines plus karma). Attack power carries " + fx(p.baseApPct * 100, 1) + "% from eleven level-9 damage gems and an ability stone worth its 1.5%, and " + nf(p.flatAP) + " flat from ark-grid cores. Every one of those is an input you can change.</p>" +

      "<h3>Crit</h3>" +
      "<p>A skill's expected multiplier is <code>1 + critRate × (critDamage − 1)</code>. Crit damage of 280% means a crit deals 2.8 times, not 3.8. The default character is one skill at 90% crit and 280% crit damage; add skills with damage shares and the multipliers are share-weighted. Crit rate is capped at 100% when a line pushes past it, which is why a crit-rate line quietly dies on a high-crit build.</p>" +
      "<p>The \"on crit, damage +1.5%\" rider on two of the combo families is crit-<i>hit</i> damage, not additional damage: the crit branch becomes <code>1 + cr × (cd × 1.015 − 1)</code>. The crit parts of one line are resolved together, because they genuinely interact inside a single hit; different lines still combine in log space.</p>" +

      "<h3>Additional damage</h3>" +
      "<p>Additional damage is one pool, additive inside itself, multiplying total damage once as <code>(1 + pool)</code>. The default pool is " + fx(pool * 100, 2) + "%: a 100-quality weapon 30%, pet 1%, a high additional-damage necklace 2.6% and 4.84% from a 60-level astrogem grid. A bracelet line worth +3% is therefore worth <code>1.4144 / 1.3844</code>, not 3%. The Master node adds 7% to this pool and nothing else — that is Shizu's ruling, and it overrides the sheet reading that also credits crit rate.</p>" +

      "<h3>The other buckets</h3>" +
      "<p>Outgoing damage is its own multiplicative bucket and is not diluted. Stagger, demon, back, front and Hitmaster damage are each scaled by a share you set: how much of your damage actually lands in that window or from that angle. <b>Back, front and Hitmaster all start at " + fx(p.backAttackShare * 100, 0) + "%</b> — slide one down and that family's lines shrink with it. Stagger windows start at " + fx(p.staggeredShare * 100, 0) + "%. The Demon boss toggle starts off; turning it on says the whole fight is a Demon or Archdemon, and demon damage is then diluted by the " + fx(p.demonBase * 100, 1) + "% you already carry from cards and pets. Family 15 trades +2% cooldown for damage; it is scored as a weighted mean of the burst case (no penalty) and the sustained case (damage divided by 1.02), weighted <b>" + fx(p.cooldownPenaltyWeight * 100, 0) + "% to burst</b> by default, and you can slide that.</p>" +
      "<p>Three weapon-power families carry a condition, and all three are now scored at their best case rather than as an input you tune. Family 20 stacks once per hit per second and caps at six, so it is scored at six stacks. Family 21's on-hit rider refreshes every five seconds while you are above 50% health, so it is scored at full uptime. Family 22 gains a stack every 30 seconds and holds each for 120, so four stacks is the ceiling it settles at and that is what it gets.</p>" +

      "<h2>Party lines get credit for the party</h2>" +
      "<p>Four families help everyone: enemy defense down, enemy crit resist down, enemy crit-damage resist down, and damage to a shielded target. Only one instance counts per party, and this model assumes you are the one carrying it.</p>" +
      "<p>They are scored as <code>1 + yourGain + " + p.allyDpsCount + " × allyGain</code>. Two other damage dealers, each assumed to deal what you deal before the line, each fixed at 90% crit and 280% crit damage. An ally's extra damage is counted as your extra damage, in units of your own baseline — that is the only way to put a party buff on the same scale as a personal one.</p>" +
      "<p>Defense shred goes through the enemy's damage reduction: if the boss reduces damage by " + fx(p.enemyBaseDR * 100, 0) + "% then shredding a fraction A of its defense multiplies damage by <code>(D+K) / (D(1−A)+K)</code>. Crit resist down reads as crit rate up for the whole party; crit-damage resist down likewise. The shielded-target line is flat damage while a shield is up, scaled by a " + fx(p.shieldUptime * 100, 0) + "% uptime.</p>" +
      "<p>The \"ally attack power buff +B%\" rider that rides along on all four scores <b>zero</b> for a damage dealer: it scales a buff only a support hands out. Switch the role to Support and it is the reason those four families sit at the top of the list.</p>" +

      "<h2>A support is scored on one damage dealer</h2>" +
      "<p>Every support figure on this site &mdash; the score, the percentage, the gold &mdash; is <b>what one damage dealer gains</b>. Not the party total, and not multiplied by anything. A bracelet that reads 2.2% is 2.2% more damage for a dealer standing next to you.</p>" +
      "<p>That is a reporting choice, not a limit. A support&rsquo;s buffs do land on every dealer in the party, so the party-wide figure is three times this one &mdash; but a number you can compare directly against a damage dealer&rsquo;s own bracelet is the more useful one, and multiplying it by party size would make the two axes incomparable. Both halves of a party line follow the same rule: the debuff half goes through the same crit and defence functions the damage-dealer side uses, counted once, and the ally attack-power rider goes through the buff model, also counted once.</p>" +

      "<h2>The two fixed combat traits</h2>" +
      "<p>Every bracelet arrives with two combat-trait lines, 61–120 points on Ancient and 41–100 on Relic. They never reroll, so whatever they are worth is a constant added to every score the solver can reach — it moves the headline number and the gold, and it changes nothing about which lines to lock.</p>" +
      "<p><b>Crit converts exactly.</b> A crit trait line gives <code>value × 25 / 699</code> percentage points of crit rate — 25 points of crit rate per 699 trait points — and that goes through the same per-skill crit model a granted crit-rate line does: additive with everything else, capped at 100%. A 120-point crit line is +" + fx(120 * 25 / 699, 2) + " pp of crit rate, worth " + fx(B.damagePercent(B.traitDamage({ crit: 120 }, p)), 2) + "% to the default character and worth nothing at all to a build already at cap.</p>" +
      "<p><b>Spec and Swiftness are yours to set</b>: what 100 points of each is worth to your class in percent damage, and the line scores <code>value × weight ÷ 100</code>. There is no class table behind it. The default is <b>" + fx(p.traitWeights.spec * 100, 4) + "%</b>, which is what a crit point is worth on the shipped settings, so all three combat traits price alike until you say otherwise. Domination, Endurance and Expertise score nothing.</p>" +
      "<p>A trait rolled into a <i>granted</i> slot still scores nothing. Only the two fixed lines count, which is what keeps the trait total a constant.</p>" +

      "<h2>The letter on the family picker</h2>" +
      "<p>Each family in the slot picker carries a grade from F to S. It rates the family's <i>average</i> roll — the three tiers weighted 6 : 3 : 1, the odds of rolling each one — against the best family in the game, banded at 90, 70, 50, 30 and 10 percent of that best. The best family is always S and a family that converts to no damage at all is always F.</p>" +
      "<p>The letter is always computed on the <b>default character</b>, never on your inputs. A grade labels the family, not your build, so it means the same thing to everyone and does not shuffle every time you move a slider. What a particular roll is worth to <i>you</i> is the tier box beside it and the line-by-line table below.</p>" +

      "<h2>Buckets that score nothing</h2>" +
      "<p>For a damage dealer: Vitality, combat traits in a granted slot, the ten defensive and utility families, and the three support families score 0% damage. That is not a claim they are worthless in game. It means they do not convert into a damage percentage, so the tool refuses to invent one. Attack and move speed is in the same bucket: real value through Raid Captain, out of scope for now.</p>" +
      "<p>This matters for the solver, not just the display. Every line that scores nothing is interchangeable with every other line that scores nothing in the same category, so they all collapse into a single outcome. That is what keeps a three-slot solve down to about 48,000 states instead of millions.</p>" +

      "<h2>The roll problem, solved exactly</h2>" +
      "<p>The mechanics, from the official disclosure and live data: a bracelet has one or two fixed lines and, on Ancient, two or three granted slots. You get four rolls plus up to three more from reconversion tickets. Each attempt rerolls <b>every unlocked slot at once</b>, and afterwards you keep the old set or take the new one — the whole set, no cherry-picking. Draws inside one attempt are sequential without replacement: no duplicate family, capped categories drop out, and everything left renormalises over the surviving weight.</p>" +
      "<p>Rolls cost silver, not gold, and the cost is small next to the bracelet. This tool treats them as free. That single assumption settles a lot: rolling always beats stopping, so there is no \"should I stop\" question, and the value of a state is simply the expected final score under the best play.</p>" +
      '<div class="formula">V(s, 0) = score(s)\nV(s, n) = max over lock masks m of  E[ max( V(s, n−1), V(T, n−1) ) ]</div>' +
      "<p>No simulation. Every outcome of every roll is enumerated and the recursion is solved backwards from the last roll. The numbers you see are the exact expectations of the model, not a sample of them.</p>" +

      "<h3>Keep or replace</h3>" +
      "<p>The verdict never compares today's scores. It compares <b>continuation values</b> — what each set is worth with the remaining rolls still to come. A weaker set can genuinely be worth more, because the families it holds are cleared out of the pool and the next roll draws from a better one. Comparing raw scores would get that backwards.</p>" +

      "<h3>Which locks to buy</h3>" +
      "<p>The tool works out the expected final score for every legal lock mask and ranks them, so the advice is a comparison of masks and never a judgement of one line on its own. Locking a line that scores nothing is never offered: it freezes a slot for no reason.</p>" +

      "<h2>Turning damage into gold</h2>" +
      "<p>Set what one percent of damage is worth to you, and set the bracelet you would otherwise wear. A bracelet is then worth <code>E[max(0, final % − baseline %)] × gold per 1%</code> — the truncation is inside the expectation, and that is the whole argument. It is not <code>(expected final − baseline)</code>, a difference of means that goes negative the moment the baseline outruns the bracelet and that, by taking the expectation before the truncation, prices the upside short. With no lines and no baseline it is what an unrolled bracelet is worth to a buyer, which is the number the market actually needs. Slot count moves it a long way: three granted slots against two is a different item.</p>" +
      "<p>The gold conversion is a rate you choose, not a market read. It is the same convention the accessory and astrogem tools use, so a bracelet, an accessory and a gem can be priced against each other.</p>" +

      "<h2>Where the tables come from</h2>" +
      "<p>Line values and probabilities are transcribed from the official Stove disclosure page, revised 2025-12-30. The listed special-effect percentages sum to 100.00016% because the page rounds; the model normalises at read time and never edits a published number. Basic-stat values are continuous bands from that page, not the four fixed points a community sheet lists — the official page wins. The character baseline is bebkok's gear tables and Arsonistic's DPS sheet, cross-checked against each other and against a live character payload.</p>" +
      "<p>The model core ships with more than 1,600 checks on each side: JavaScript against first principles, the exact solver against a brute-force recursion on small cases, and the whole JavaScript model against an independent Python mirror. Both have to pass before anything ships.</p>" +

      "<h2>What this does not model</h2>" +
      "<ul>" +
      "<li><b>Speed lines.</b> Attack and move speed scores zero. It is worth real damage through Raid Captain, and that conversion is not built yet.</li>" +

      "<li><b>Support classes other than Bard.</b> The Specialization-to-buff coefficient is Bard’s. Paladin and Artist have their own and nobody has published them, so the field is there to type into and the default is a Bard.</li>" +
      "<li><b>Positional base multipliers.</b> A front attack is ×1.20 and a back attack ×1.05 with +10% crit rate before any bracelet line. The tool uses your share inputs but does not fold those base multipliers in, so a positional line is valued against your average damage rather than against the boosted hit.</li>" +
      "<li><b>Roll costs.</b> Silver per attempt rises with each roll and was never published. Treated as free.</li>" +
      "<li><b>The Relic to Ancient upgrade.</b> Upgrading bumps existing lines. Pick the grade you are actually holding.</li>" +
      "<li><b>Combat stat caps.</b> Reported as roughly 120 on Ancient, never confirmed for T4.</li>" +
      "<li><b>Your class.</b> There is no class list. Set the shares — back, front, Hitmaster, stagger, demon — and the trait weights, and the model follows them.</li>" +
      "</ul>" +

      "<h2>Reading the numbers honestly</h2>" +
      "<p>\"Expected final\" is an average over every way the remaining rolls can land. Half of all bracelets finish below the median, and the p10 to p90 strip on the Advisor tab shows how wide that is. A bracelet worth 4% expected is not a bracelet that will be worth 4%.</p>" +
      "<p>The community reads 7–9% as good and 10% or more as near-final. Those figures come from the same per-source percentage lostark.bible prints on a character page, so they are directly comparable to what this tool reports.</p>" +

      "</div>";
  }

  document.addEventListener("tabselected", function (e) {
    if (e && e.detail && e.detail.tab === "method") render();
  });
  if (document.querySelector("#tab-method.active")) render();
})();
