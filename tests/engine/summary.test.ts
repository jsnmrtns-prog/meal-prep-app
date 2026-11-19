// The short "what is this recipe" summary, worked out with word rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { introText, summarizeSaved, summarizeText, summaryDetails, type Recipe } from "../../src/engine/index.ts";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/recipes/${f}`, import.meta.url), "utf8")).recipe as Recipe;
const fixture = (f: string) => readFileSync(new URL(`../fixtures/import/${f}`, import.meta.url), "utf8");

test("the golden recipes: main protein, carb, vegetables, sauce, how it's cooked, style", () => {
  const t = summarizeSaved(load("teriyaki-fried-rice.json"));
  assert.match(t.dish!, /^Chicken thighs with white rice and mixed vegetables/);
  assert.match(t.dish!, /teriyaki/);
  assert.equal(t.method, "Stove");
  assert.equal(t.style, "Asian-style");
  const m = summarizeSaved(load("taco-mac-and-cheese.json"));
  assert.match(m.dish!, /^Ground beef with pasta/);
  assert.equal(m.style, "Mexican-style");
});

test("broth isn't the protein, onion is only named when it's the only vegetable, no repeated words", () => {
  const chili = summarizeText("Turkey Chili", fixture("03-web-turkey-chili.txt"));
  assert.match(chili.dish!, /^Ground turkey with /);
  assert.doesNotMatch(chili.dish!, /chicken|tomatoes, tomato/);
  const cozy = summarizeText("Mom's chicken and rice", fixture("13-handwritten-moms-chicken-rice.txt"));
  assert.match(cozy.dish!, /^Chicken thighs with white rice and onion/);
  assert.equal(cozy.method, "Oven");
});

test("cooking time counts cooking, not marinating; short or missing times are left out", () => {
  const stew = summarizeText("Stew", fixture("16-handwritten-stew.txt"));
  assert.match(summaryDetails(stew), /about 2 hours of cooking/);
  const t = summarizeSaved(load("teriyaki-fried-rice.json"));
  assert.equal(t.minutes, null, "marinate for 1 hour isn't cooking");
});

test("a book's description is the prose between the name and the ingredients", () => {
  const text = "Chicken Fajita Rice\n\nThere’s no reason to be eating plain Chicken & Rice!\nThis One Pan Chicken Fajita Rice is a game changer for meal prep!\n\nMacros per serving\n\n408 CALORIES\n\n39g PROTEIN\n\nIngredients\n\nChicken:\nz 700g (24.7oz) Raw Chicken Breast";
  assert.equal(introText(text, "Chicken Fajita Rice"), "There’s no reason to be eating plain Chicken & Rice! This One Pan Chicken Fajita Rice is a game changer for meal prep!");
  const plain = "Recipe # 4\nLemon Pepper\nChicken Rice Bowls\n\n531\n\n46g\n\nCALORIES\n\nThe flavours in this are absolutely incredible, so\nsimple and perfect to meal prep for the week\nahead!\n\nINGREDIENTS (4 SERVINGS)\n– 800g chicken";
  assert.equal(introText(plain, "Lemon Pepper Chicken Rice Bowls"), "The flavours in this are absolutely incredible, so simple and perfect to meal prep for the week ahead!");
  // A handwritten card goes straight into ingredients and steps: no description.
  assert.equal(introText(fixture("17-handwritten-burgers.txt"), "Burgers"), null);
});
