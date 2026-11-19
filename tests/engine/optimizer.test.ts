// M4 gate: the optimizer meets every target or says why it can't, its results
// match an independent Python check, and every plan passes all five audits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_BOUNDS,
  DEFAULT_PRESETS,
  FoodDb,
  SEED_PACKAGES,
  YieldDb,
  applyPreferences,
  auditRecipe,
  buildShoppingList,
  calculateRecipe,
  optimizeRecipe,
  portionRecipe,
  practicalQuantity,
  presetProblems,
  type FoodDbFile,
  type MacroPreset,
  type OptimizedPlan,
  type Recipe,
  type UserProfile,
  type YieldsFile,
} from "../../src/engine/index.ts";
import { TEST_PRESETS, goldenPlans } from "../../scripts/export-optimized.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const db = new FoodDb(read("../../public/data/fooddb.json") as FoodDbFile);
const yields = new YieldDb(read("../../public/data/yields.json") as YieldsFile);
const profile = read("../fixtures/profile.json") as UserProfile;
const pinned = read("../fixtures/optimized-plans.json") as { plans: { key: string }[] };
const python = read("../fixtures/golden-optimized-expected.json") as { plans: Record<string, { perMeal: Record<string, number> }> };
const recipes = ["teriyaki-fried-rice", "taco-mac-and-cheese"].map(
  (f) => applyPreferences(read(`../fixtures/recipes/${f}.json`).recipe as Recipe, profile.preferences).recipe,
);
const [teriyaki, taco] = recipes as [Recipe, Recipe];
const [standard, higher] = DEFAULT_PRESETS as [MacroPreset, MacroPreset];

function allPlans(): { label: string; plan: OptimizedPlan; requested: MacroPreset }[] {
  const out: { label: string; plan: OptimizedPlan; requested: MacroPreset }[] = [];
  for (const r of recipes) {
    for (const preset of [...DEFAULT_PRESETS, ...TEST_PRESETS]) {
      const res = optimizeRecipe(r, preset, db);
      if (res.ok) {
        out.push({ label: `${r.id}/${preset.id}`, plan: res.plan, requested: preset });
        for (const a of res.alternatives) out.push({ label: `${r.id}/${preset.id}/${a.title}`, plan: a.plan, requested: preset });
      } else {
        for (const o of res.options) out.push({ label: `${r.id}/${preset.id}/${o.title}`, plan: o.plan, requested: preset });
      }
    }
  }
  return out;
}
const plans = allPlans();

test("default presets have no arithmetic conflicts; impossible ones are caught", () => {
  for (const p of DEFAULT_PRESETS) assert.deepEqual(presetProblems(p), []);
  const tiny: MacroPreset = { ...standard, id: "tiny", kcal: 250 };
  assert.match(presetProblems(tiny)[0]!, /75 g protein alone is about 300 kcal/);
  assert.match(presetProblems({ ...standard, meals: 0 })[0]!, /whole number/);
  const r = optimizeRecipe(teriyaki, tiny, db);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.options.length, 0, "no options are offered for a preset that can't work at all");
});

test("optimizer output is unchanged from the independently checked fixture", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(goldenPlans())), pinned.plans, "re-run `node scripts/export-optimized.ts` and `npm run golden:optimizer` after an intended change");
});

test("per-meal totals match the independent Python calculation", () => {
  const entries = goldenPlans().filter((e) => (e as { kind: string }).kind !== "conflict") as { key: string; recipe: Recipe }[];
  assert.equal(entries.length, Object.keys(python.plans).length);
  for (const e of entries) {
    const calc = calculateRecipe({ ...teriyaki, ...e.recipe, steps: [] } as Recipe, db);
    const want = python.plans[e.key]!.perMeal;
    for (const k of ["kcal", "protein", "carbs", "fat"] as const) {
      const got = calc.perPortion[k].value;
      assert.ok(Math.abs(got - want[k]!) <= 1e-9 * Math.max(1, Math.abs(want[k]!)), `${e.key} ${k}: ${got} vs ${want[k]}`);
    }
  }
});

test("golden recipes: what the presets produce", () => {
  // With the default 0.05×–10× limits, even 650 kcal teriyaki works, but only by cutting the rice
  // to almost nothing, so it's flagged as a big change.
  assert.deepEqual(DEFAULT_BOUNDS.carb, { min: 0.05, max: 10 });
  const wide650 = optimizeRecipe(teriyaki, TEST_PRESETS[0]!, db);
  assert.ok(wide650.ok && wide650.plan.bigChange);
  // Tighter limits (½×–5×) show how the planner handles a squeeze.
  const narrow = { bounds: { protein: { min: 0.5, max: 5 }, carb: { min: 0.5, max: 5 }, fat: { min: 0.5, max: 5 } } };
  const t750 = optimizeRecipe(teriyaki, standard, db, narrow);
  assert.ok(t750.ok);
  if (t750.ok) {
    // Chicken thighs are fatty: 750 kcal works only with the rice and oils at their minimum,
    // so the plan is flagged and the leaner swap is offered.
    assert.equal(t750.plan.bigChange, true);
    assert.match(t750.plan.method, /fats at their minimum/);
    assert.equal(t750.alternatives[0]?.title, "Use chicken breast instead of thighs");
    assert.equal(t750.alternatives[0]?.plan.bigChange, false);
  }
  for (const [r, p] of [[teriyaki, higher], [taco, standard], [taco, higher]] as const) {
    const res = optimizeRecipe(r, p, db);
    assert.ok(res.ok, `${r.id}/${p.id}`);
  }
  const t650 = optimizeRecipe(teriyaki, TEST_PRESETS[0]!, db, narrow);
  assert.equal(t650.ok, false);
  if (!t650.ok) {
    assert.match(t650.conflicts[0]!, /no room for the white rice/);
    assert.deepEqual(t650.options.map((o) => o.keepsTargets), [true, false, false], "options that keep your targets come first");
  }
});

test("every plan meets its targets: protein never below the minimum, calories within tolerance", () => {
  assert.ok(plans.length >= 15);
  for (const { label, plan } of plans) {
    for (const t of plan.targets) assert.ok(t.ok, `${label}: ${t.label} ${t.value} outside ${t.range.min}–${t.range.max}`);
    const p = plan.preset.protein;
    if (p.mode === "minimum") assert.ok(plan.perMeal.protein >= p.grams, `${label}: protein ${plan.perMeal.protein}`);
    assert.equal(plan.recipe.portions, plan.preset.meals);
    assert.equal(plan.recipe.measuredCookedBatchGrams, undefined, "a weighed batch no longer applies after rescaling");
  }
});

test("every plan passes all five audits, including the target check", () => {
  for (const { label, plan } of plans) {
    const shopping = buildShoppingList(plan.recipe, plan.calc, db, yields, SEED_PACKAGES);
    const portioning = portionRecipe(plan.recipe, plan.calc, yields);
    const report = auditRecipe(plan.recipe, plan.calc, db, profile, { targets: plan.preset, plan: { yields, packages: SEED_PACKAGES, shopping, portioning } });
    for (const a of report.audits) assert.notEqual(a.status, "fail", `${label} audit ${a.id}: ${a.findings.join(" | ")}`);
    assert.notEqual(report.audits[4]!.status, "pending");
  }
});

test("audit 4 catches a plan that misses its targets", () => {
  const res = optimizeRecipe(taco, standard, db);
  assert.ok(res.ok);
  if (!res.ok) return;
  const broken: Recipe = {
    ...res.plan.recipe,
    lines: res.plan.recipe.lines.map((l) => (l.id === "beef" ? { ...l, quantity: { kind: "mass", amount: 900, unit: "g" } } : l)),
  };
  const calc = calculateRecipe(broken, db);
  const report = auditRecipe(broken, calc, db, profile, { targets: res.plan.preset });
  assert.equal(report.audits[3]!.status, "fail");
  assert.match(report.audits[3]!.findings.join(" "), /Protein: .* per meal is outside 75\.00–80\.00 g/);
  const wrongMeals = auditRecipe(res.plan.recipe, res.plan.calc, db, profile, { targets: { ...res.plan.preset, meals: 5 } });
  assert.match(wrongMeals.audits[3]!.findings.join(" "), /preset asks for 5 meals/);
});

test("only adjustable ingredients change; the rest keep their per-meal amount", () => {
  for (const { label, plan } of plans) {
    for (const c of plan.changes) {
      if (c.lever === "fixed") {
        assert.ok(c.factor > 0.8 && c.factor < 1.2, `${label}: ${c.name} moved ${c.factor}× but isn't adjustable`);
        assert.equal(c.swappedFrom, undefined);
      } else {
        const b = plan.relaxation?.kind === "carb_floor" && c.lever === "carb" ? { ...DEFAULT_BOUNDS.carb, min: plan.relaxation.min } : DEFAULT_BOUNDS[c.lever];
        assert.ok(c.factor >= b.min - 1e-9 && c.factor <= b.max + 1e-9, `${label}: ${c.name} ${c.factor}× outside limits`);
      }
    }
  }
});

test("cottage cheese counts as a main protein; seasonings and sauces never do", () => {
  const res = optimizeRecipe(taco, standard, db);
  assert.ok(res.ok);
  if (!res.ok) return;
  const lever = (id: string) => res.plan.changes.find((c) => c.lineId === id)!.lever;
  assert.equal(lever("cottage-cheese"), "protein");
  assert.equal(lever("cheddar"), "fixed"); // 8.7 g protein per 100 kcal: below the line
  assert.equal(lever("nutritional-yeast"), "fixed");
  assert.equal(lever("pasta"), "carb");
});

test("swaps are recalculated with the new USDA food and explained in the steps", () => {
  const res = optimizeRecipe(teriyaki, standard, db);
  assert.ok(res.ok);
  if (!res.ok) return;
  const alt = res.alternatives[0]!.plan;
  const chicken = alt.recipe.lines.find((l) => l.id === "chicken")!;
  assert.deepEqual(chicken.food, { kind: "usda", fdcId: 2646170 });
  assert.equal(alt.calc.lines.find((l) => l.lineId === "chicken")!.food.description, "Chicken, breast, boneless, skinless, raw");
  assert.ok(alt.stepNotes.some((n) => /chicken breast wherever the steps say boneless skinless chicken thighs/.test(n)));
  assert.ok(alt.stepNotes.some((n) => /Divide into 6 containers/.test(n)));
});

test("a recipe with nothing to adjust gets an explanation, not a plan", () => {
  const sauceOnly: Recipe = { ...teriyaki, lines: teriyaki.lines.filter((l) => l.role === "sauce" || l.role === "seasoning") };
  const res = optimizeRecipe(sauceOnly, standard, db);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.conflicts[0]!, /no main protein ingredient/);
});

test("results are deterministic", () => {
  const a = JSON.stringify(optimizeRecipe(taco, higher, db));
  const b = JSON.stringify(optimizeRecipe(taco, higher, db));
  assert.equal(a, b);
});

test("kitchen-friendly rounding", () => {
  assert.equal(practicalQuantity({ kind: "count", amount: 2.4, portionLabel: "large" }).amount, 2.5);
  assert.equal(practicalQuantity({ kind: "count", amount: 2.4, portionLabel: "large" }, true).amount, 2);
  assert.equal(practicalQuantity({ kind: "count", amount: 0.2, portionLabel: "clove" }).amount, 0.5);
  assert.equal(practicalQuantity({ kind: "volume", amount: 1.2, unit: "tsp" }).amount, 1.25);
  assert.equal(practicalQuantity({ kind: "volume", amount: 0.3, unit: "cup" }).amount, 0.25);
  assert.equal(practicalQuantity({ kind: "mass", amount: 72.4, unit: "g" }).amount, 72);
  assert.equal(practicalQuantity({ kind: "mass", amount: 5.3, unit: "g" }).amount, 5.5);
  assert.equal(practicalQuantity({ kind: "mass", amount: 19.2, unit: "oz" }).amount, 19.25);
});
