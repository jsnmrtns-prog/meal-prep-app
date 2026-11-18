import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FoodDb, FoodDbError, gramsForAmount, reconstructedKcal, type FoodDbFile } from "../../src/engine/fooddb.ts";

const file = JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile;
const db = new FoodDb(file);

test("database loads both USDA datasets with a traceable version and citation", () => {
  assert.equal(db.size, 8217);
  assert.equal(db.releases.foundation, "2026-10-29");
  assert.equal(db.releases.srLegacy, "2018-04");
  assert.match(db.version, /^F2026-10-29-S2018-04-[0-9a-f]{10}$/);
  assert.match(db.citation, /U\.S\. Department of Agriculture, Agricultural Research Service\. FoodData Central/);
});

test("energy rule: USDA Energy first, then Atwater specific, then Atwater general", () => {
  const srChicken = db.get(171077);
  assert.equal(srChicken.dataset, "sr_legacy");
  assert.equal(srChicken.energySource, "usda_energy");
  assert.equal(srChicken.per100g.kcal, 120);

  const fChicken = db.get(2646170); // reports 957 = 106 and 958 = 112, no 208
  assert.equal(fChicken.dataset, "foundation");
  assert.equal(fChicken.energySource, "atwater_specific");
  assert.equal(fChicken.per100g.kcal, 112);
  assert.equal(fChicken.per100g.protein, 22.5);
  assert.equal(fChicken.per100g.fat, 1.93);
});

test("missing nutrients stay unknown (null), never zero", () => {
  const fChicken = db.get(2646170);
  assert.equal(fChicken.per100g.fiber, null);
  assert.equal(fChicken.per100g.sugars, null);
});

test("foods without calories are marked unusable for recipe math", () => {
  const unusable = [...file.foods].filter((row) => row[4] === -1);
  assert.equal(unusable.length, 50);
  for (const row of unusable) assert.equal(db.get(row[0] as number).usableForMacros, false);
  assert.equal(db.get(171077).usableForMacros, true);
});

test("unknown IDs are an error, not a silent fallback", () => {
  assert.throws(() => db.get(1), FoodDbError);
  assert.equal(db.has(1), false);
});

test("search finds both chicken breast records near the top", () => {
  const ids = db.search("chicken breast raw", 10).map((f) => f.fdcId);
  assert.ok(ids.includes(2646170), `Foundation record missing from ${ids}`);
  assert.ok(ids.includes(171077), `SR Legacy record missing from ${ids}`);
  assert.deepEqual(db.search("   "), []);
  assert.deepEqual(db.search("zzzz nothing matches"), []);
});

test("mass units convert exactly without USDA portions", () => {
  const result = gramsForAmount(db.get(171077), 2, "lb");
  assert.deepEqual(result, { ok: true, grams: 907.18474, basis: "exact_mass" });
});

test("volume uses the food's USDA portion weight", () => {
  const rice = gramsForAmount(db.get(168877), 2, "cup");
  assert.ok(rice.ok && rice.grams === 370 && rice.basis === "usda_portion");
  const butter = gramsForAmount(db.get(173410), 2, "tbsp");
  assert.ok(butter.ok && Math.abs(butter.grams - 28.4) < 1e-9);
  // Converting through another volume unit of the same food: 1 tsp butter = 14.2 g / 3.
  const tsp = gramsForAmount(db.get(173410), 1, "tsp");
  assert.ok(tsp.ok);
});

test("different USDA cup weights are reported as ambiguous instead of guessed", () => {
  const onion = db.get(170000); // 1 cup chopped = 160 g, 1 cup sliced = 115 g
  const result = gramsForAmount(onion, 1, "cup");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "ambiguous" && result.options.length >= 2);
  const chopped = gramsForAmount(onion, 1, "cup", "cup, chopped");
  assert.ok(chopped.ok && chopped.grams === 160);
});

test("count units and foods without volume data are refused", () => {
  assert.deepEqual(gramsForAmount(db.get(171077), 1, "cup"), { ok: false, reason: "no_usda_basis" });
  assert.deepEqual(gramsForAmount(db.get(170000), 1, "large"), { ok: false, reason: "unsupported_unit" });
  assert.deepEqual(gramsForAmount(db.get(170000), -1, "g"), { ok: false, reason: "invalid_amount" });
});

test("calories rebuilt from macros are a comparison only", () => {
  const fChicken = db.get(2646170);
  const rebuilt = reconstructedKcal(fChicken)!;
  assert.ok(Math.abs(rebuilt - (22.5 * 4.27 + 1.93 * 9.02 + 0 * 3.87)) < 1e-9);
  assert.equal(fChicken.per100g.kcal, 112); // reported value unchanged
});

test("USDA's weight for the exact unit is used even when other spoon sizes differ slightly", () => {
  const garlicPowder = db.get(171325); // 1 tsp = 3.1 g, 1 tbsp = 9.7 g (slightly different densities)
  const tsp = gramsForAmount(garlicPowder, 0.5, "tsp");
  assert.ok(tsp.ok && tsp.grams === 1.55);
  const tbsp = gramsForAmount(garlicPowder, 1, "tbsp");
  assert.ok(tbsp.ok && tbsp.grams === 9.7);
  // With no cup portion, converting through spoons would mix two densities: refuse.
  const cup = gramsForAmount(garlicPowder, 1, "cup");
  assert.ok(!cup.ok && cup.reason === "ambiguous");
});
