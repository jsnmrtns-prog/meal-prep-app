// Cookbook-style PDF layouts: symbol-font bullets, letter-spaced "STEP" markers,
// section labels without colons, "each" lists, mixes used by the serving, and
// notes boxes. The fixture is an original recipe that copies those layout quirks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FoodDb, parseRecipeText, suggestFoods, tidyLine, upgradeSettings, defaultSettings, wantFor, quantityFor, type FoodDbFile } from "../../src/engine/index.ts";

const text = readFileSync(new URL("../fixtures/import-files/cookbook-layout.txt", import.meta.url), "utf8");
const db = new FoodDb(JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile);

test("tidyLine cleans symbol bullets and letter-spaced words", () => {
  assert.equal(tidyLine("z S T E P 1"), "• STEP 1");
  assert.equal(tidyLine("Bake at 200°C z"), "Bake at 200°C");
  assert.equal(tidyLine("»» IMPORTANT COOKING NOTES"), "• IMPORTANT COOKING NOTES");
  assert.equal(tidyLine("z"), "");
  assert.equal(tidyLine("Add the zucchini"), "Add the zucchini");
});

const r = parseRecipeText(text);

test("cookbook layout: title, servings and notes", () => {
  assert.equal(r.title, null, "a running page header is not the recipe name");
  assert.equal(r.servings, 3);
  assert.deepEqual(r.notes, ["Keep the crema in its own container.", "Reheat the turkey and potatoes only."]);
});

test("cookbook layout: STEP markers start steps; wrapped lines join; notes and links are left out", () => {
  assert.equal(r.steps.length, 3, JSON.stringify(r.steps));
  assert.equal(r.steps[0], "Toss the sweet potatoes with the smoky rub and olive oil, then roast at 200°C for 25 minutes.");
  assert.equal(r.steps[1], "Stir the yogurt, salt, cumin and lime juice together. Chill until needed.");
  assert.match(r.steps[2]!, /^Melt the butter .* top with cheddar and serve with the potatoes and crema\.$/);
});

test("cookbook layout: section labels, each-lists and a mix used by the serving", () => {
  const rows = r.ingredients.map((i) => `${i.group} | ${i.amount} ${i.unit?.kind === "count" ? i.unit.noun : i.unit?.unit ?? ""} | ${i.name}`);
  assert.deepEqual(rows, [
    "Smoky Rub | 1.5 tsp | Salt",
    "Smoky Rub | 1.5 tsp | Smoked Paprika",
    "Smoky Rub | 1.5 tsp | Onion Powder",
    "Smoky Rub | 1.5 tsp | Garlic Powder",
    "Roasted Sweet Potatoes | 600 g | Sweet Potatoes",
    "Roasted Sweet Potatoes | 1 tsp | Olive Oil",
    "Turkey Mince | 500 g | 93% Lean Ground Turkey",
    "Turkey Mince | 30 g | Cheddar Cheese",
    "Turkey Mince | 10 g | Butter",
    "Lime Crema | 120 g | 0% Greek Yogurt",
    "Lime Crema | 0.5 tsp | Salt",
    "Lime Crema | 0.5 tsp | Cumin",
    "Lime Crema | 1 lime | Lime juice",
  ]);
  const rub = r.ingredients[0]!;
  assert.ok(rub.flags.some((f) => f.code === "sub_recipe" && /1 \+ 0\.5 = 1\.5 servings/.test(f.message)), rub.flags.map((f) => f.message).join(" / "));
  const cheese = r.ingredients[7]!;
  assert.equal(cheese.prep, "or any reduced fat cheese");
  assert.ok(cheese.flags.every((f) => f.severity === "check"), "a suggested swap is a check, not a fix");
  assert.ok(r.ingredients[11]!.flags.some((f) => f.code === "split_line"));
});

test("a serving of something that isn't in the recipe asks for grams", () => {
  const p = parseRecipeText("Ingredients\n2 servings protein powder\nInstructions\nShake.").ingredients[0]!;
  assert.ok(p.flags.some((f) => f.severity === "fix" && /grams/.test(f.message)));
});

test("matching: common names find the right USDA food", () => {
  const top = (name: string) => suggestFoods(name, db, 1)[0]?.description ?? "";
  assert.match(top("Chipotle Paste"), /^Peppers, hot chili/);
  assert.doesNotMatch(suggestFoods("Chipotle Paste", db, 3).map((f) => f.description).join(" "), /pasteurized/i);
  assert.match(top("Green Bell Peppers"), /^Peppers, sweet, green, raw/);
  assert.match(top("Onion Powder"), /^Spices, onion powder/);
  assert.match(top("Chilli Powder"), /^Spices, chili powder/);
  assert.match(top("Buffalo Hot Sauce"), /pepper or hot/);
  assert.match(top("Tomatoes"), /^Tomatoes, red, ripe, raw/);
  assert.match(top("Raw 95% Ground/Mince Beef"), /^Beef, ground, 95% lean/);
});

test("lime juice and black pepper resolve to a USDA weight without asking", () => {
  const lime = r.ingredients[12]!;
  const food = suggestFoods(lime.name, db, 1, wantFor(lime))[0]!;
  assert.match(food.description, /^Lime juice, raw/);
  assert.equal(quantityFor(lime, food).quantity?.kind, "count");
  const pepper = parseRecipeText("Ingredients\n1 tsp black pepper\nInstructions\nStir.").ingredients[0]!;
  const pf = suggestFoods(pepper.name, db, 1, wantFor(pepper))[0]!;
  assert.deepEqual(quantityFor(pepper, pf).quantity, { kind: "volume", amount: 1, unit: "tsp", portionLabel: "tsp, ground" });
});

test("limits still at an old default (½×–2½× or ½×–5×) move to 0.05×–10×; changed limits stay", () => {
  const s = defaultSettings();
  const old = { ...s, bounds: { protein: { min: 0.5, max: 2.5 }, carb: { min: 0.5, max: 5 }, fat: { min: 0.75, max: 2.5 } } };
  const up = upgradeSettings(old);
  assert.deepEqual(up.bounds, { protein: { min: 0.05, max: 10 }, carb: { min: 0.05, max: 10 }, fat: { min: 0.75, max: 2.5 } });
  assert.deepEqual(upgradeSettings(s).bounds, s.bounds);
});

test("canned foods are matched to USDA canned records and measured as packaged", async () => {
  const { guessState } = await import("../../src/engine/index.ts");
  for (const line of ["1 (15 oz) can black beans, drained", "1 15oz. can black beans", "400g can chopped tomatoes"]) {
    const p = parseRecipeText(`Ingredients\n${line}\nInstructions\nStir.`).ingredients[0]!;
    const food = suggestFoods(p.name, db, 1, wantFor(p))[0]!;
    assert.match(food.description, /\bcanned\b/i, line);
    assert.equal(guessState(food, p.name), "as_packaged", line);
  }
});

test("foods USDA doesn't have are marked as stand-ins, so they aren't accepted without a look", async () => {
  const { approximateNote } = await import("../../src/engine/index.ts");
  for (const name of ["Cajun Seasoning", "Italian Seasoning", "Chipotle Paste", "Garlic Salt", "Protein Pasta", "Tandoori Masala"]) assert.ok(approximateNote(name), name);
  for (const name of ["Garlic Powder", "Smoked Paprika", "Chicken Breast"]) assert.equal(approximateNote(name), null, name);
});
