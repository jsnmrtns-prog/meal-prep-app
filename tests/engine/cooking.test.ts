// The cookable recipe: amounts written into the original steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cookingSteps, stepsDivide, upgradeSavedLines, type Recipe } from "../../src/engine/index.ts";

const teriyaki = JSON.parse(readFileSync(new URL("../fixtures/recipes/teriyaki-fried-rice.json", import.meta.url), "utf8")).recipe as Recipe;
const show = (r: Recipe, containers?: number) =>
  cookingSteps(r, containers).map((s) => s.parts.map((p) => (p.kind === "text" ? p.text : `[${p.lineId}]`)).join("") + (s.also.length ? ` +${s.also.join(",")}` : ""));

const line = (id: string, name: string, steps: number[], extra: Partial<Recipe["lines"][number]> = {}) =>
  ({ id, name, food: { kind: "usda", fdcId: 1 }, quantity: { kind: "mass", amount: 10, unit: "g" }, state: "raw", role: "other", usedInSteps: steps, ...extra }) as Recipe["lines"][number];

test("each amount goes right after the ingredient's name in its step; the wording is kept", () => {
  const s = show(teriyaki);
  assert.match(s[0]!, /^In a small saucepan over medium heat, combine minced garlic cloves\[garlic\], soy sauce\[soy-sauce\], zero-calorie brown sugar\[brown-sugar\], mirin\[mirin\]/);
  assert.match(s[4]!, /crack in eggs\[eggs\] and pour in egg whites\[egg-whites\]/, "egg whites doesn't take the eggs' word");
  assert.match(s[4]!, /sesame oil\[sesame-oil\] and soy sauce\[soy-drizzle\]/);
});

test("the plan's number of containers replaces the recipe's in a 'divide into' step", () => {
  assert.match(show(teriyaki, 6)[5]!, /Divide into 6 servings/);
  assert.ok(stepsDivide(teriyaki));
});

test("full names win: 'bell peppers' gets the bell pepper, 'pepper' the black pepper; the same food twice goes to two steps", () => {
  const r = {
    id: "r", name: "x", portions: 4,
    steps: [{ text: "Season the beef with salt, black pepper and soy sauce." }, { text: "Add sliced onions and mixed bell peppers. Season with salt and pepper. Add soy sauce." }],
    lines: [
      line("beef", "beef", [1]), line("salt1", "salt", [1, 2]), line("bp1", "black pepper", [1, 2]), line("soy1", "soy sauce", [1, 2]),
      line("onion", "white onion", [2]), line("bell", "red bell pepper", [1, 2]), line("salt2", "salt", [1, 2]), line("bp2", "black pepper", [1, 2]), line("soy2", "soy sauce", [1, 2]),
    ],
  } as Recipe;
  const s = show(r);
  assert.equal(s[0], "Season the beef[beef] with salt[salt1], black pepper[bp1] and soy sauce[soy1].");
  assert.equal(s[1], "Add sliced onions[onion] and mixed bell peppers[bell]. Season with salt[salt2] and pepper[bp2]. Add soy sauce[soy2].");
});

test("an ingredient the steps don't name is listed after the step it was placed in", () => {
  const r = { id: "r", name: "x", portions: 2, steps: [{ text: "Heat the pan." }, { text: "Cook the chicken." }], lines: [line("oil", "olive oil", [1], { stepsInferred: true }), line("ch", "chicken breast", [2])] } as Recipe;
  assert.deepEqual(show(r), ["Heat the pan. +oil", "Cook the chicken[ch]."]);
  assert.equal(stepsDivide(r), false);
});

test("soy sauce is a sauce, not a carb, so scaling keeps it as the recipe says", () => {
  const r = { id: "r", name: "x", portions: 2, steps: [{ text: "Add soy sauce." }], lines: [line("soy", "soy sauce", [1], { role: "carb" })] } as Recipe;
  assert.equal(upgradeSavedLines(r).lines[0]!.role, "sauce");
});
