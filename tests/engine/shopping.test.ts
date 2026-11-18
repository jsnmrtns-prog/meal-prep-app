// M3 gate: purchase amounts, packages and cooked weights match an independent
// Python calculation, and audit 5 catches every inconsistency it exists for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FoodDb,
  YieldDb,
  SEED_PACKAGES,
  applyPreferences,
  auditRecipe,
  buildShoppingList,
  calculateRecipe,
  packagesNeeded,
  portionRecipe,
  purchasePlanLine,
  type FoodDbFile,
  type Recipe,
  type UserProfile,
  type YieldsFile,
  type ShoppingList,
  type Portioning,
} from "../../src/engine/index.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const db = new FoodDb(read("../../public/data/fooddb.json") as FoodDbFile);
const yields = new YieldDb(read("../../public/data/yields.json") as YieldsFile);
const profile = read("../fixtures/profile.json") as UserProfile;
const expected = read("../fixtures/golden-recipes-expected.json") as {
  recipes: Record<string, {
    shopping: Record<string, { grams: number; rule: string; count?: number; unitGrams?: number; lines: string[] }>;
    cookedBatchGrams: number;
    perContainerGrams: number;
  }>;
};
const fixtures = ["teriyaki-fried-rice", "taco-mac-and-cheese"].map((f) => read(`../fixtures/recipes/${f}.json`).recipe as Recipe);
const close = (a: number, b: number, label: string, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${label}: ${a} vs ${b}`);

function full(recipe: Recipe) {
  const adjusted = applyPreferences(recipe, profile.preferences).recipe;
  const calc = calculateRecipe(adjusted, db);
  const shopping = buildShoppingList(adjusted, calc, db, yields, SEED_PACKAGES);
  const portioning = portionRecipe(adjusted, calc, yields);
  const audit = (s: ShoppingList = shopping, p: Portioning = portioning, r: Recipe = adjusted) =>
    auditRecipe(r, calc, db, profile, { plan: { yields, packages: SEED_PACKAGES, shopping: s, portioning: p } });
  return { recipe: adjusted, calc, shopping, portioning, audit };
}

test("yield data loads with its sources", () => {
  assert.equal(yields.list("cook").length, 163);
  assert.equal(yields.list("bone").length, 6);
  assert.equal(yields.list("hydration").length, 3);
  assert.equal(yields.get("cook-23565").percent, 69);
  assert.equal(yields.get("bone-ah102-247").percent, 88);
  assert.match(yields.citation(yields.get("cook-23565")), /Table of Cooking Yields/);
});

for (const recipe of fixtures) {
  test(`${recipe.name}: shopping list matches the independent calculation`, () => {
    const { shopping } = full(recipe);
    const ref = expected.recipes[recipe.id]!.shopping;
    const byRefKey = new Map(shopping.items.map((i) => [i.key.replace(/^(usda-\d+)-.*$/, "$1"), i]));
    assert.deepEqual([...byRefKey.keys()].sort(), Object.keys(ref).sort());
    for (const [key, r] of Object.entries(ref)) {
      const item = byRefKey.get(key)!;
      close(item.purchaseGrams, r.grams, `${key} purchase`);
      assert.deepEqual([...item.lineIds].sort(), [...r.lines].sort());
      if (r.rule === "package") {
        assert.equal(item.buy.kind, "package", key);
        assert.ok(item.buy.kind === "package" && item.buy.count === r.count, `${key} count`);
        assert.ok(item.buy.kind === "package" && Math.abs(item.buy.packageGrams - r.unitGrams!) < 1e-9, `${key} size`);
      } else if (r.rule === "each") {
        assert.ok(item.buy.kind === "each" && item.buy.count === r.count, `${key} each`);
      } else if (r.rule === "by_weight") {
        assert.equal(item.buy.kind, "by_weight", key);
      } else {
        assert.ok(item.buy.kind === "pantry" || item.buy.kind === "unknown_package", `${key} is ${item.buy.kind}`);
      }
    }
  });

  test(`${recipe.name}: cooked batch and container weights match`, () => {
    const { portioning } = full(recipe);
    const ref = expected.recipes[recipe.id]!;
    close(portioning.batchCookedGrams, ref.cookedBatchGrams, "batch cooked");
    close(portioning.perContainerGrams, ref.perContainerGrams, "per container");
    assert.ok(portioning.batchLow <= portioning.batchCookedGrams && portioning.batchCookedGrams <= portioning.batchHigh);
  });

  test(`${recipe.name}: audit 5 passes with notes; still an estimate because of stand-ins`, () => {
    const report = full(recipe).audit();
    const a5 = report.audits[4]!;
    assert.equal(a5.status, "warn", a5.findings.join("\n"));
    assert.ok(!a5.findings.some((f) => /doesn't|isn't|appears \d+ times|wrong/.test(f)), a5.findings.join("\n"));
    assert.equal(report.status, "estimate");
  });
}

test("soy sauce used twice becomes one shopping item", () => {
  const { shopping } = full(fixtures[0]!);
  const soy = shopping.items.filter((i) => i.lineIds.includes("soy-sauce") || i.lineIds.includes("soy-drizzle"));
  assert.equal(soy.length, 1);
  close(soy[0]!.purchaseGrams, 76, "soy grams");
});

test("water and removed ingredients never reach the shopping list", () => {
  const { shopping } = full(fixtures[0]!);
  const ids = shopping.items.flatMap((i) => i.lineIds);
  assert.ok(!ids.includes("slurry-water"));
  assert.ok(!ids.includes("ginger")); // removed by "Avoid ginger"
});

// ---------- audit 5 catches inconsistencies ----------
test("audit 5 fails when an ingredient isn't in any step, or the step doesn't mention it", () => {
  const base = structuredClone(fixtures[1]!);
  delete base.lines.find((l) => l.id === "milk")!.usedInSteps;
  assert.ok(full(base).audit().audits[4]!.findings.some((f) => /"1% milk" isn't linked/.test(f)));

  const wrong = structuredClone(fixtures[1]!);
  wrong.lines.find((l) => l.id === "milk")!.usedInSteps = [1];
  const r = full(wrong).audit();
  assert.equal(r.audits[4]!.status, "fail");
  assert.ok(r.audits[4]!.findings.some((f) => /Step 1 doesn't mention "1% milk"/.test(f)));
});

test("audit 5 fails on too few packages, an extra package, a missing item or a wrong purchase amount", () => {
  const { shopping, portioning, audit } = full(fixtures[1]!);
  const fewer = structuredClone(shopping);
  const pasta = fewer.items.find((i) => i.lineIds.includes("cottage-cheese"))!;
  if (pasta.buy.kind === "package") { pasta.buy.count = 0; pasta.buy.totalGrams = 0; }
  assert.equal(audit(fewer, portioning).audits[4]!.status, "fail");

  const extra = structuredClone(shopping);
  const beef = extra.items.find((i) => i.lineIds.includes("beef"))!;
  if (beef.buy.kind === "package") { beef.buy.count = 2; beef.buy.totalGrams = 2 * beef.buy.packageGrams; }
  assert.ok(audit(extra, portioning).audits[4]!.findings.some((f) => /one package fewer/.test(f)));

  const missing = structuredClone(shopping);
  missing.items = missing.items.filter((i) => !i.lineIds.includes("onion"));
  assert.ok(audit(missing, portioning).audits[4]!.findings.some((f) => /"onion" appears 0 times/.test(f)));

  const wrongAmount = structuredClone(shopping);
  wrongAmount.purchase.find((p) => p.lineId === "pasta")!.purchaseGrams = 300;
  assert.equal(audit(wrongAmount, portioning).audits[4]!.status, "fail");
});

test("audit 5 fails when cooked weights don't add up", () => {
  const { shopping, portioning, audit } = full(fixtures[0]!);
  const bad = structuredClone(portioning);
  bad.batchCookedGrams += 10;
  assert.equal(audit(shopping, bad).audits[4]!.status, "fail");
  const bad2 = structuredClone(portioning);
  bad2.perContainerGrams += 1;
  assert.equal(audit(shopping, bad2).audits[4]!.status, "fail");
});

// ---------- purchase edge cases ----------
test("bone-in steak: buy more than you use, by USDA's bone yield", () => {
  const steak = { id: "s", name: "T-bone steak", food: { kind: "usda", fdcId: 168726 }, quantity: { kind: "mass", amount: 500, unit: "g" }, state: "raw", role: "protein", prep: { boneYieldId: "bone-ah102-247" } } as const;
  const plan = purchasePlanLine(structuredClone(steak) as never, 500, yields);
  close(plan.purchaseGrams, 500 / 0.88, "bone-in purchase");
  assert.match(plan.basis[0]!, /88% usable/);

  const trimmed = purchasePlanLine({ ...structuredClone(steak), prep: { boneYieldId: "bone-ah102-247", trimKeptPercent: 90 } } as never, 500, yields);
  close(trimmed.purchaseGrams, 500 / 0.88 / 0.9, "bone and trim");
  assert.match(trimmed.basis[1]!, /90% kept \(your measurement\)/);

  assert.throws(() => purchasePlanLine({ ...structuredClone(steak), prep: { trimKeptPercent: 0 } } as never, 500, yields));
  assert.throws(() => purchasePlanLine({ ...structuredClone(steak), prep: { trimKeptPercent: 120 } } as never, 500, yields));
});

test("a steak recipe with bone and trim passes audit 5's purchase check", () => {
  const recipe: Recipe = {
    id: "steak", name: "Steak test", portions: 3,
    steps: [{ text: "Grill the T-bone steak." }],
    lines: [{
      id: "steak", name: "T-bone steak", food: { kind: "usda", fdcId: 168726 }, state: "raw", role: "protein",
      quantity: { kind: "mass", amount: 2, unit: "lb" }, usedInSteps: [1],
      prep: { boneYieldId: "bone-ah102-247", trimKeptPercent: 92 },
      cook: { kind: "yield", yieldId: "cook-13930", match: "closest" },
    }],
  };
  const calc = calculateRecipe(recipe, db);
  const shopping = buildShoppingList(recipe, calc, db, yields, SEED_PACKAGES);
  const portioning = portionRecipe(recipe, calc, yields);
  const report = auditRecipe(recipe, calc, db, { allergies: [], preferences: [] }, { plan: { yields, packages: SEED_PACKAGES, shopping, portioning } });
  assert.notEqual(report.audits[4]!.status, "fail", report.audits[4]!.findings.join("\n"));
  close(shopping.items[0]!.purchaseGrams, (2 * 453.59237) / 0.88 / 0.92, "purchase");
  close(portioning.batchCookedGrams, 2 * 453.59237 * 0.8, "cooked");
});

test("package rounding: exact multiples aren't rounded up, tiny overflows are flagged", () => {
  assert.equal(packagesNeeded(453.59237, 453.59237), 1);
  assert.equal(packagesNeeded(907.18474, 453.59237), 2);
  assert.equal(packagesNeeded(453.6, 453.59237), 2);
  assert.equal(packagesNeeded(0.0001, 453.59237), 1);

  const beef454 = structuredClone(fixtures[1]!);
  beef454.lines.find((l) => l.id === "beef")!.quantity = { kind: "mass", amount: 454, unit: "g" };
  const item = full(beef454).shopping.items.find((i) => i.lineIds.includes("beef"))!;
  assert.ok(item.buy.kind === "package" && item.buy.count === 2);
  assert.ok(item.notes.some((n) => /Only 0\.4 g more than 1 package/.test(n)), item.notes.join("; "));
});

test("a weighed finished batch sets the container weight", () => {
  const r = structuredClone(fixtures[0]!);
  r.measuredCookedBatchGrams = 2000;
  const { portioning, audit } = full(r);
  assert.equal(portioning.measured, true);
  assert.equal(portioning.perContainerGrams, 400);
  assert.notEqual(audit().audits[4]!.status, "fail");
});

test("container weights divide evenly for 5, 6 and 7 portions", () => {
  for (const n of [5, 6, 7]) {
    const r = structuredClone(fixtures[1]!);
    r.portions = n;
    const { portioning, audit } = full(r);
    close(portioning.perContainerGrams * n, portioning.batchCookedGrams, `portions ${n}`);
    assert.notEqual(audit().audits[4]!.status, "fail");
  }
});
