// M1 gate: the bundled food database must match reference values computed by
// an independent Python script (scripts/golden_foods.py) straight from the raw
// USDA files, for 55 common meal-prep foods.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FoodDb, type FoodDbFile, type NutrientsPer100g } from "../../src/engine/fooddb.ts";

const db = new FoodDb(JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile);
const golden = JSON.parse(readFileSync(new URL("../fixtures/golden-foods.json", import.meta.url), "utf8")) as {
  foods: ({ key: string; fdcId: number; dataset: string; description: string; energySource: string } & Record<string, number | null | string>)[];
};

const COMPARED: (keyof NutrientsPer100g)[] = ["kcal", "protein", "fat", "carbs", "fiber", "sodium", "satFat", "water"];

test("at least 50 reference foods are checked", () => {
  assert.ok(golden.foods.length >= 50, `only ${golden.foods.length}`);
});

for (const ref of golden.foods) {
  test(`${ref.key} matches USDA (${ref.fdcId})`, () => {
    const food = db.get(ref.fdcId);
    assert.equal(food.description, ref.description);
    assert.equal(food.dataset, ref.dataset);
    assert.equal(food.energySource, ref.energySource);
    assert.equal(food.usableForMacros, true);
    for (const key of COMPARED) {
      // Exact equality: values are copied, not computed, so they must not differ at all.
      assert.equal(food.per100g[key], ref[key] ?? null, `${key}`);
    }
  });
}
