// Kitchen amounts USDA doesn't measure ("1 bunch asparagus", "juice of 1 lemon",
// "6 lasagna sheets"), and brand notes in brackets that run over several lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FoodDb, parseIngredientLine, parseRecipeText, quantityFor, suggestFoods, wantFor, type FoodDbFile } from "../../src/engine/index.ts";

const db = new FoodDb(JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile);
const resolve = (line: string) => {
  const p = parseRecipeText(`Test\nIngredients\n• ${line}\nSteps\n1. Cook.`).ingredients[0]!;
  const food = suggestFoods(p.name, db, 1, wantFor(p))[0] ?? null;
  return { p, food, ...quantityFor(p, food) };
};

test("a bunch, a head, sheets, a thumb and a can get their usual weight, and say so", () => {
  const cases: [string, number, RegExp][] = [
    ["1 bundle asparagus, trimmed", 450, /bunch of asparagus is usually about 1 lb/],
    ["2 bunches cilantro", 160, /bunch of cilantro/],
    ["1 head garlic", 50, /head of garlic/],
    ["6 Lasagna Sheets", 120, /lasagna sheet is usually about 20 g/],
    ["1 thumb ginger, grated", 15, /thumb of ginger/],
    ["1 can black beans, drained", 250, /drained 15 oz can/],
  ];
  for (const [line, grams, note] of cases) {
    const r = resolve(line);
    assert.deepEqual(r.quantity, { kind: "mass", amount: grams, unit: "g" }, line);
    assert.match(r.assumed!, note, line);
    assert.equal(r.problem, null);
  }
});

test("lemon and lime juice, however it's written, is the juice of the fruit", () => {
  for (const line of ["Juice of 1 lemon", "juice of half a lime", "1 lemon, juiced", "½ lime (juiced)"]) {
    const p = parseIngredientLine(line);
    assert.match(p.name, /^(?:Lemon|Lime) juice$/, line);
    assert.equal(p.unit?.kind, "count", line);
  }
  assert.equal(parseIngredientLine("juice of half a lime").amount, 0.5);
  const q = resolve("Juice of 1 lemon");
  assert.equal(q.quantity?.kind, "count");
  assert.equal(q.problem, null);
});

test("a drop, garlic, zest and water with no amount get a small standard amount", () => {
  const p = parseRecipeText("Test\nIngredients\n• Drop of Milk/Almond Milk\n• Garlic\n• Lemon Zest\n• Boiling Water\nSteps\n1. Mix.").ingredients;
  assert.deepEqual(p.map((x) => [x.amount, x.unit && ("unit" in x.unit ? x.unit.unit : x.unit.noun)]), [[1, "tsp"], [1, "clove"], [1, "tsp"], [1, "cup"]]);
  assert.ok(p.every((x) => !x.flags.some((f) => f.severity === "fix")));
});

test("a brand note in brackets over several lines stays with its ingredient, not a section heading", () => {
  const r = parseRecipeText(`Wraps
Ingredients
• 1 High Protein Low Calorie
Tortilla/Wrap (Brand:
Mission Low GI-Protein
Wrap)
• 100ml 95% Fat Free Carnation
Evaporated Milk (Brand:
Carnation - or you can use light cream)
• 2 Eggs
Steps
1. Cook.`);
  assert.equal(r.ingredients.length, 3);
  assert.ok(r.ingredients.every((i) => i.group === null), JSON.stringify(r.ingredients.map((i) => i.group)));
  assert.equal(r.ingredients[0]!.amount, 1);
  assert.match(r.ingredients[0]!.name, /Tortilla\/Wrap$/);
  assert.equal(r.ingredients[1]!.amount, 100);
  assert.match(r.ingredients[1]!.name, /Evaporated Milk$/);
});
