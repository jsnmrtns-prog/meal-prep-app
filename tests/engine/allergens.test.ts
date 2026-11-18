import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { screenAllergens, type Allergen } from "../../src/engine/allergens.ts";
import { FoodDb, type FoodDbFile } from "../../src/engine/fooddb.ts";

const db = new FoodDb(JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile);

const cases: [string, string, Allergen[]][] = [
  ["Cheese, cheddar", "Dairy and Egg Products", ["milk"]],
  ["Butter, salted", "Dairy and Egg Products", ["milk"]],
  ["Egg, whole, raw, fresh", "Dairy and Egg Products", ["egg"]],
  ["Peanut butter, smooth style, with salt", "Legumes and Legume Products", ["peanuts"]],
  ["Almond milk, unsweetened", "Beverages", ["tree_nuts"]],
  ["Coconut milk, raw", "Nut and Seed Products", ["tree_nuts"]],
  ["Shrimp, mixed species, raw", "Finfish and Shellfish Products", ["crustacean_shellfish"]],
  ["Fish, salmon, Atlantic, farmed, raw", "Finfish and Shellfish Products", ["fish"]],
  ["Pasta, dry, enriched", "Cereal Grains and Pasta", ["wheat"]],
  ["Rice, white, long-grain, regular, raw, enriched", "Cereal Grains and Pasta", []],
  // Conservative on purpose: "tortillas" alone can't prove the product is wheat-free.
  ["Tortillas, ready-to-bake or -fry, corn", "Baked Products", ["wheat"]],
  ["Soy sauce made from soy and wheat (shoyu)", "Soups, Sauces, and Gravies", ["wheat", "soy"]],
  ["Tofu, raw, firm, prepared with calcium sulfate", "Legumes and Legume Products", ["soy"]],
  ["Seeds, sesame butter, tahini", "Nut and Seed Products", ["sesame"]],
  ["Nuts, mixed nuts, dry roasted, with peanuts, with salt added", "Nut and Seed Products", ["tree_nuts", "peanuts"]],
  ["Nuts, butternuts, dried", "Nut and Seed Products", ["tree_nuts"]],
  ["Water chestnuts, chinese, raw", "Vegetables and Vegetable Products", []],
  ["Snacks, popcorn, microwave, butter flavored", "Snacks", ["milk"]],
  ["Sauce, worcestershire", "Soups, Sauces, and Gravies", ["fish"]],
  ["Eggplant, raw", "Vegetables and Vegetable Products", []],
  ["Squash, winter, butternut, raw", "Vegetables and Vegetable Products", []],
  ["Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw", "Poultry Products", []],
  ["Onions, raw", "Vegetables and Vegetable Products", []],
  ["Nutmeg, ground", "Spices and Herbs", []],
];

test("allergen screen tags the nine major allergens from description and category", () => {
  for (const [description, category, expected] of cases) {
    const screen = screenAllergens({ description, category });
    assert.deepEqual(screen.allergens, expected, `${description} → ${screen.reasons.join("; ")}`);
  }
});

test("multi-ingredient foods always ask for a label check", () => {
  assert.equal(screenAllergens({ description: "Sauce, worcestershire", category: "Soups, Sauces, and Gravies" }).needsLabelCheck, true);
  assert.equal(screenAllergens({ description: "Onions, raw", category: "Vegetables and Vegetable Products" }).needsLabelCheck, false);
});

test("every allergen tag explains why it was applied", () => {
  const s = screenAllergens({ description: "Cheese, cheddar", category: "Dairy and Egg Products" });
  assert.deepEqual(s.reasons, ['milk: description mentions "cheese"']);
});

test("screen runs on every food in the database without errors", () => {
  let tagged = 0;
  for (const id of [171077, 170000, 173410, 168877]) screenAllergens(db.get(id));
  for (const food of db.search("cheese", 50)) if (screenAllergens(food).allergens.includes("milk")) tagged++;
  assert.ok(tagged >= 45, `only ${tagged} of 50 cheese results tagged milk`);
});
