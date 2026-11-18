// M2 gate: the golden recipes calculate exactly as the independent Python
// script does, and every audit catches the errors it exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FoodDb,
  RecipeInputError,
  applyPreferences,
  auditRecipe,
  calculateRecipe,
  isStale,
  NUTRIENT_KEYS,
  type CalcResult,
  type FoodDbFile,
  type Recipe,
  type UserProfile,
} from "../../src/engine/index.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const db = new FoodDb(read("../../public/data/fooddb.json") as FoodDbFile);
const profile = read("../fixtures/profile.json") as UserProfile;
const expected = read("../fixtures/golden-recipes-expected.json") as {
  recipes: Record<string, {
    portions: number;
    lines: { id: string; grams: number; nutrients: Record<string, number | null> }[];
    batch: Record<string, number>;
    complete: Record<string, boolean>;
    perPortion: Record<string, number>;
    batchGrams: number;
  }>;
};
const fixtures = ["teriyaki-fried-rice", "taco-mac-and-cheese"].map(
  (f) => read(`../fixtures/recipes/${f}.json`) as { recipe: Recipe; expectedAfterPreferences: { removed: string[]; amounts: Record<string, number> } },
);

const close = (a: number, b: number, label: string, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${label}: ${a} vs ${b}`);

function prepared(i: number) {
  const fx = fixtures[i]!;
  const { recipe, changes } = applyPreferences(fx.recipe, profile.preferences);
  const calc = calculateRecipe(recipe, db);
  return { fx, recipe, changes, calc };
}

for (const [i, fx] of fixtures.entries()) {
  const name = fx.recipe.name;

  test(`${name}: preferences applied as expected`, () => {
    const { recipe } = prepared(i);
    const ids = recipe.lines.map((l) => l.id);
    for (const removed of fx.expectedAfterPreferences.removed) assert.ok(!ids.includes(removed), `${removed} should be removed`);
    for (const [id, amount] of Object.entries(fx.expectedAfterPreferences.amounts)) {
      assert.equal(recipe.lines.find((l) => l.id === id)?.quantity.amount, amount);
    }
    assert.equal(recipe.lines.length, fx.recipe.lines.length - fx.expectedAfterPreferences.removed.length);
  });

  test(`${name}: matches the independent Python calculation`, () => {
    const { recipe, calc } = prepared(i);
    const ref = expected.recipes[recipe.id]!;
    assert.deepEqual(calc.lines.map((l) => l.lineId), ref.lines.map((l) => l.id));
    calc.lines.forEach((line, k) => {
      const r = ref.lines[k]!;
      close(line.grams, r.grams, `${line.lineId} grams`);
      for (const key of NUTRIENT_KEYS) {
        const a = line.nutrients[key];
        const b = r.nutrients[key] ?? null;
        if (a === null || b === null) assert.equal(a, b, `${line.lineId} ${key}`);
        else close(a, b, `${line.lineId} ${key}`);
      }
    });
    for (const key of NUTRIENT_KEYS) {
      close(calc.batch[key].value, ref.batch[key]!, `batch ${key}`);
      assert.equal(calc.batch[key].complete, ref.complete[key], `batch ${key} complete`);
      close(calc.perPortion[key].value, ref.perPortion[key]!, `per portion ${key}`);
    }
    close(calc.batchGrams, ref.batchGrams, "batch grams");
  });

  test(`${name}: audits 2–4 pass, audit 1 only warns, status is "estimate" (stand-in foods)`, () => {
    const { recipe, calc } = prepared(i);
    const report = auditRecipe(recipe, calc, db, profile);
    const status = Object.fromEntries(report.audits.map((a) => [a.id, a.status]));
    assert.deepEqual(status, { 1: "warn", 2: "pass", 3: "pass", 4: "pass", 5: "pending" });
    assert.equal(report.status, "estimate");
    assert.equal(isStale(recipe, report, db), false);
  });
}

test("Teriyaki: every assumption and stand-in is reported", () => {
  const { recipe, calc } = prepared(0);
  const findings = auditRecipe(recipe, calc, db, profile).audits[0]!.findings.join("\n");
  for (const text of ["mirin", "drizzle", "Egg size", "Clove size"]) assert.match(findings, new RegExp(text));
});

// ---------- each audit catches tampering ----------
const clone = <T>(x: T): T => structuredClone(x);

test("audit 2 catches a wrong ingredient value", () => {
  const { recipe, calc } = prepared(0);
  const bad: CalcResult = clone(calc);
  bad.lines[7]!.nutrients.protein = bad.lines[7]!.nutrients.protein! + 0.01;
  const r = auditRecipe(recipe, bad, db, profile);
  assert.equal(r.audits[1]!.status, "fail");
  assert.equal(r.status, "needs_review");
});

test("audit 3 catches a batch total that doesn't add up", () => {
  const { recipe, calc } = prepared(0);
  const bad: CalcResult = clone(calc);
  bad.batch.kcal.value += 1;
  bad.perPortion.kcal.value = bad.batch.kcal.value / bad.portions;
  const r = auditRecipe(recipe, bad, db, profile);
  assert.equal(r.audits[2]!.status, "fail");
  assert.equal(r.audits[3]!.status, "pass");
});

test("audit 4 catches a per-serving value that doesn't match the batch", () => {
  const { recipe, calc } = prepared(1);
  const bad: CalcResult = clone(calc);
  bad.perPortion.protein.value += 0.5;
  assert.equal(auditRecipe(recipe, bad, db, profile).audits[3]!.status, "fail");
});

test("audit 1 catches wrong grams, a raw/cooked mismatch, an allergy and an excluded ingredient", () => {
  const { recipe, calc } = prepared(0);
  const badGrams: CalcResult = clone(calc);
  badGrams.lines[10]!.grams = 310;
  assert.equal(auditRecipe(recipe, badGrams, db, profile).audits[0]!.status, "fail");

  const cooked = clone(recipe);
  cooked.lines.find((l) => l.id === "rice")!.food = { kind: "usda", fdcId: 168878 }; // "...enriched, cooked"
  const cookedReport = auditRecipe(cooked, calculateRecipe(cooked, db), db, profile);
  assert.ok(cookedReport.audits[0]!.findings.some((f) => /measured dry, but its USDA record is a cooked food/.test(f)));

  const milkAllergy: UserProfile = { ...profile, allergies: ["milk"] };
  const taco = prepared(1);
  const allergyReport = auditRecipe(taco.recipe, taco.calc, db, milkAllergy);
  assert.equal(allergyReport.status, "needs_review");
  assert.ok(allergyReport.audits[0]!.findings.some((f) => /may contain milk/.test(f)));

  const withGinger = fixtures[0]!.recipe; // preferences not applied
  const gingerReport = auditRecipe(withGinger, calculateRecipe(withGinger, db), db, profile);
  assert.ok(gingerReport.audits[0]!.findings.some((f) => /conflicts with your preference "Avoid ginger"/.test(f)));
});

test("a recipe edited after calculation is stale and can't pass", () => {
  const { recipe, calc } = prepared(0);
  const edited = clone(recipe);
  edited.lines.find((l) => l.id === "rice")!.quantity.amount = 350;
  const report = auditRecipe(edited, calc, db, profile);
  assert.equal(isStale(edited, auditRecipe(recipe, calc, db, profile), db), true);
  assert.equal(report.status, "needs_review");
});

test("unclear quantities are refused, not guessed", () => {
  const base = clone(fixtures[1]!.recipe);
  const onion = base.lines.find((l) => l.id === "onion")!;
  onion.quantity = { kind: "volume", amount: 1, unit: "cup" }; // chopped 160 g vs sliced 115 g
  assert.throws(() => calculateRecipe(base, db), (e: Error) => e instanceof RecipeInputError && /Choose one/.test(e.message));

  const noPortion = clone(fixtures[1]!.recipe);
  noPortion.lines.find((l) => l.id === "beef")!.quantity = { kind: "volume", amount: 1, unit: "cup" };
  assert.throws(() => calculateRecipe(noPortion, db), RecipeInputError);

  const incomplete = clone(fixtures[1]!.recipe);
  incomplete.lines.find((l) => l.id === "milk")!.food = { kind: "usda", fdcId: 748608 }; // olive oil record without calories
  assert.throws(() => calculateRecipe(incomplete, db), RecipeInputError);
});

test("label foods are converted from per-serving to per-100 g", () => {
  const recipe: Recipe = {
    id: "label-test", name: "Label test", portions: 2, steps: [],
    lines: [{
      id: "nooch", name: "nutritional yeast", state: "as_packaged", role: "seasoning",
      quantity: { kind: "mass", amount: 10, unit: "g" },
      food: {
        kind: "label", name: "Nutritional yeast (label)", servingGrams: 5, source: "Test label",
        perServing: { kcal: 20, protein: 2.5, fat: 0, carbs: 2, fiber: 1, sugars: 0, sodium: 5, satFat: 0 },
      },
    }],
  };
  const calc = calculateRecipe(recipe, db);
  assert.equal(calc.lines[0]!.nutrients.kcal, 40);
  assert.equal(calc.perPortion.protein.value, 2.5);
  const report = auditRecipe(recipe, calc, db, { allergies: [], preferences: [] });
  assert.equal(report.audits[1]!.status, "pass");
  assert.equal(report.status, "checks_pending"); // audit 5 arrives in M3
});

test("portion count must be a whole number", () => {
  const r = clone(fixtures[0]!.recipe);
  r.portions = 0;
  assert.throws(() => calculateRecipe(r, db), RecipeInputError);
  r.portions = 2.5;
  assert.throws(() => calculateRecipe(r, db), RecipeInputError);
});

test("uneven portion counts divide exactly", () => {
  for (const n of [5, 6, 7]) {
    const r = clone(fixtures[1]!.recipe);
    r.portions = n;
    const calc = calculateRecipe(applyPreferences(r, profile.preferences).recipe, db);
    close(calc.perPortion.kcal.value * n, calc.batch.kcal.value, `portions ${n}`);
    assert.equal(auditRecipe(applyPreferences(r, profile.preferences).recipe, calc, db, profile).audits[3]!.status, "pass");
  }
});
