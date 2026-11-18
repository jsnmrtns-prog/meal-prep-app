// Writes every optimizer result for the golden recipes (main plans, alternatives
// and tradeoff options) to tests/fixtures/optimized-plans.json, so the
// independent Python check (scripts/golden_optimizer.py) can verify them and
// the engine tests can confirm the optimizer still produces exactly these.
//
// Run: node scripts/export-optimized.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_BOUNDS,
  DEFAULT_PRESETS,
  FoodDb,
  applyPreferences,
  optimizeRecipe,
  type FoodDbFile,
  type MacroPreset,
  type OptimizedPlan,
  type Recipe,
  type UserProfile,
} from "../src/engine/index.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const db = new FoodDb(read("public/data/fooddb.json") as FoodDbFile);
const profile = read("tests/fixtures/profile.json") as UserProfile;

/** Extra presets that exercise the no-plan path, tradeoff options and optional targets. */
export const TEST_PRESETS: MacroPreset[] = [
  { id: "test-650", name: "Test: 650 kcal", kcal: 650, kcalTolerancePct: 2, protein: { grams: 75, mode: "minimum" }, meals: 6 },
  { id: "test-exact-carbs", name: "Test: exact protein + carbs", kcal: 700, kcalTolerancePct: 2, protein: { grams: 70, mode: "exact" }, carbs: { grams: 60, tolerancePct: 5 }, meals: 6 },
];

export function goldenPlans() {
  const out: unknown[] = [];
  for (const file of ["teriyaki-fried-rice", "taco-mac-and-cheese"]) {
    const original = applyPreferences(read(`tests/fixtures/recipes/${file}.json`).recipe as Recipe, profile.preferences).recipe;
    for (const preset of [...DEFAULT_PRESETS, ...TEST_PRESETS]) {
      const result = optimizeRecipe(original, preset, db);
      const entry = (kind: string, title: string, plan: OptimizedPlan) => ({
        key: `${original.id}/${preset.id}/${kind}${title ? `/${title}` : ""}`,
        kind,
        title,
        preset: plan.preset,
        bounds: plan.relaxation?.kind === "carb_floor" ? { ...DEFAULT_BOUNDS, carb: { ...DEFAULT_BOUNDS.carb, min: plan.relaxation.min } } : DEFAULT_BOUNDS,
        original: { portions: original.portions, lines: original.lines },
        recipe: { portions: plan.recipe.portions, lines: plan.recipe.lines },
        method: plan.method,
      });
      if (result.ok) {
        out.push(entry("plan", "", result.plan));
        for (const a of result.alternatives) out.push(entry("alternative", a.title, a.plan));
      } else {
        out.push({ key: `${original.id}/${preset.id}/conflict`, kind: "conflict", conflicts: result.conflicts });
        for (const o of result.options) out.push(entry("option", o.title, o.plan));
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const plans = goldenPlans();
  writeFileSync(new URL("tests/fixtures/optimized-plans.json", root), JSON.stringify({ source: "scripts/export-optimized.ts", plans }, null, 1) + "\n");
  console.log(`Wrote ${plans.length} entries to tests/fixtures/optimized-plans.json`);
}
