// Whole cookbooks: finding the recipes in a PDF, two-page spreads, three
// ingredient columns, printed nutrition, suggested amounts for unmeasured
// items, and linking ingredients to the steps that use them.
// sample-cookbook.pdf is an original book made with reportlab that copies the
// layouts of three real meal prep cookbooks (their PDFs stay out of the repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, openAsBlob, readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfPages } from "../../src/app/fileText.ts";
import {
  FoodDb,
  findPrintedNutrition,
  findRecipes,
  gramsForAmount,
  parseIngredientLine,
  parseRecipeText,
  stepMentionsLine,
  stepsMentioning,
  linkSteps,
  type FoodDbFile,
} from "../../src/engine/index.ts";

const sample = new URL("../fixtures/import-files/sample-cookbook.pdf", import.meta.url);
const db = new FoodDb(JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile);
const pagesPromise = openAsBlob(sample).then((b) => pdfPages(pdfjs as never, b));

test("a cookbook PDF is read page by page and its recipes are found; the tips page is left out", async () => {
  const pages = await pagesPromise;
  assert.equal(pages.length, 5);
  const found = findRecipes(pages);
  assert.deepEqual(found.map((r) => [r.title, r.pages]), [
    ["Lemon Herb Turkey Rice Bowls", [2, 3]],
    ["Smoky Chicken Wraps", [4]],
    ["GARLIC BEEF NOODLES", [5]],
  ]);
  assert.deepEqual(found.map((r) => r.printed?.kcal), [512, 420, 465]);
  assert.deepEqual(found.map((r) => r.servings), [4, 4, 5]);
});

test("two-page spread: the left page gives the name and nutrition; the book's running header isn't the name", async () => {
  const [spread] = findRecipes(await pagesPromise);
  const r = parseRecipeText(spread!.text);
  assert.equal(r.title, "Lemon Herb Turkey Rice Bowls");
  assert.deepEqual(r.printed, { kcal: 512, protein: 48, carbs: 55, fat: 11, per: "serving" });
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.ingredients.map((i) => i.name), [
    "Lean Ground Turkey", "Salt", "Oregano", "Garlic Powder", "Olive Oil", "Uncooked White Rice", "Lemon juice",
    "0% Greek Yogurt", "Light Mayo", "Salt", "Fresh Parsley",
  ]);
  assert.ok(r.ingredients.every((i) => !i.flags.some((f) => f.severity === "fix")), "nothing left to fix");
  assert.ok(!r.ingredients.some((i) => /\d+g$|TAP ICONS|protein in every/i.test(i.name)), "the left page's panel and description aren't ingredients");
});

test("three ingredient columns are read one after another, with their section names", async () => {
  const wraps = findRecipes(await pagesPromise)[1]!;
  const r = parseRecipeText(wraps.text);
  assert.deepEqual([...new Set(r.ingredients.map((i) => i.group))], ["Chicken", "Sauce", "Wraps"]);
  assert.deepEqual(r.ingredients.filter((i) => i.group === "Chicken").map((i) => i.name), ["Chicken Breast", "Paprika", "Cumin", "Salt", "Pepper", "Olive Oil"]);
  assert.equal(r.ingredients.find((i) => i.name === "Shredded Mozzarella")?.amount, 40);
  // "Ingredients (4 Wraps)": four wraps counted as four servings, marked to check.
  assert.equal(r.servings, 4);
  assert.ok(r.flags.some((f) => f.severity === "check" && /4 wraps/.test(f.message)));
});

test("unbulleted lines that wrap are joined ('Parmigiano' / 'Reggiano', '(dry weight)')", async () => {
  const noodles = findRecipes(await pagesPromise)[2]!;
  const r = parseRecipeText(noodles.text);
  assert.deepEqual(r.ingredients.map((i) => `${i.group}: ${i.amount} ${i.name}`), [
    "Beef: 680 93% lean ground beef", "Beef: 1 garlic powder", "Beef: 20 Parmigiano Reggiano",
    "Noodles: 300 egg noodles", "Noodles: 0.25 salt", "Noodles: 0.25 pepper", "Noodles: 1 onion powder",
  ]);
});

test("printed nutrition in the layouts cookbooks and posts use", () => {
  const cases: [string, object | null][] = [
    ["Macros per serving\n\n230 CALORIES\n\n25g PROTEIN 18g CARBS 6g FAT", { kcal: 230, protein: 25, carbs: 18, fat: 6, per: "serving" }],
    ["Per Serving (makes 5)\n\n505 Calories\n\n44G Protein 52G Carbs 15G Fat", { kcal: 505, protein: 44, carbs: 52, fat: 15, per: "serving" }],
    ["NUTRITIONAL\nINFORMATION\nTOTAL\nCALORIES: 946\nCARBS: 77G\nFATS: 17G\nPROTEIN: 113G", { kcal: 946, protein: 113, carbs: 77, fat: 17, per: "recipe" }],
    ["572 Calories | 52g Protein | 54g Carbs | 16g Fat", { kcal: 572, protein: 52, carbs: 54, fat: 16, per: "serving" }],
    ["PER SERVING (MAKES 4)\n\n597\n\n59g\n\n52g\n\n16g\n\nCALORIES\n\nPROTEIN\n\nCARBS\n\nFAT", { kcal: 597, protein: 59, carbs: 52, fat: 16, per: "serving" }],
    ["Packed with 60g of\nprotein!", null],
  ];
  for (const [text, want] of cases) assert.deepEqual(findPrintedNutrition(text), want, text);
});

test("unmeasured items get a standard amount, marked so it can be changed; real foods still ask", () => {
  const one = (line: string) => parseRecipeText(`Ingredients\n1 cup rice\n${line}\nInstructions\nCook.`).ingredients[1]!;
  const cases: [string, number, string][] = [
    ["Pinch of salt", 1 / 16, "tsp"],
    ["To taste: black pepper", 1 / 4, "tsp"],
    ["Garnish with fresh parsley", 1, "tbsp"],
    ["Handful of spinach", 1, "cup"],
    ["Big Handful Coriander/Cilantro", 2, "tbsp"],
    ["Splash of soy sauce", 1, "tbsp"],
    ["Cooking spray", 1 / 4, "tsp"],
    ["Sesame seeds", 1, "tsp"],
    ["1-2 Tsp Olive Oil", 1.5, "tsp"],
  ];
  for (const [line, amount, unit] of cases) {
    const p = one(line);
    assert.ok(p.amount !== null && Math.abs(p.amount - amount) < 1e-9, `${line}: ${p.amount}`);
    assert.equal(p.unit?.kind !== "count" ? p.unit?.unit : null, unit, line);
    assert.ok(p.flags.every((f) => f.severity === "check"), `${line}: ${p.flags.map((f) => f.message).join(" / ")}`);
  }
  for (const line of ["Brioche Buns", "Low Fat Cream Cheese", "¼ – 1½ cups vegetable oil"]) {
    assert.ok(one(line).flags.some((f) => f.severity === "fix"), `${line} should still ask`);
  }
});

test("a choice uses the first option; '15g (0.7oz)' keeps the grams; '(or to taste)' keeps the amount", () => {
  assert.equal(parseIngredientLine("1 Tsp Rice Vinegar or Lemon Juice").name, "Rice Vinegar");
  assert.equal(parseIngredientLine("100g (3.5oz) Fat Free or Low Fat Greek Yogurt").name, "Fat Free Greek Yogurt");
  assert.equal(parseIngredientLine("50g Velveeta shreds OR reduced fat cheddar").name, "Velveeta shreds");
  const butter = parseIngredientLine("15g (0.7oz) Reduced Fat Butter");
  assert.equal(butter.amount, 15);
  assert.ok(butter.flags.every((f) => f.severity === "check"));
  const salt = parseIngredientLine("1 Tsp Salt (or to taste)");
  assert.equal(salt.amount, 1);
  assert.ok(salt.flags.every((f) => f.severity === "check"));
});

test("an ingredient is linked to a step that names its section or another name for it", () => {
  const steps = ["Season the potatoes with 1 serving of taco spice mix.", "Blend the yogurt, mayo and chipotle paste.", "Top with the chipotle spicy sauce."];
  assert.deepEqual(stepsMentioning("Oregano", steps, "Taco Spice Mix"), [1]);
  assert.deepEqual(stepsMentioning("50% Fat Mayonnaise", steps, "Chipotle Spicy Sauce"), [2]);
  assert.ok(stepMentionsLine(steps[2]!, "Honey", "Chipotle Spicy Sauce"));
  assert.ok(!stepMentionsLine("Cook the rice.", "Honey", "Chipotle Spicy Sauce"));
});

test("USDA spoon weights that differ only by rounding are one weight, not a choice", () => {
  const hot = db.search("sauce ready-to-serve pepper or hot", 1)[0]!;
  const r = gramsForAmount(hot, 30, "ml");
  assert.ok(r.ok, JSON.stringify(r));
});

const books = ["/mnt/user-data/uploads/The_Meal_Prep_Cookbook_V5.pdf", "/mnt/user-data/uploads/Jalal_s_Cookbook_V3.pdf", "/mnt/user-data/uploads/0bf303ce-Stealth_Health_Meal_Prep_Cookbook_2026_Update.pdf"];
test("your three cookbooks: every recipe is found with a name and steps", { skip: !books.every(existsSync) && "cookbooks not available here" }, async () => {
  const want = [128, 141, 110];
  for (const [k, f] of books.entries()) {
    const found = findRecipes(await pdfPages(pdfjs as never, await openAsBlob(f)));
    assert.equal(found.length, want[k], f);
    assert.ok(found.filter((r) => r.title.startsWith("Recipe on page")).length <= 1, f);
    assert.ok(found.every((r) => parseRecipeText(r.text).steps.length > 0), f);
  }
});

test("Stealth-style wrapped lines: dry weight for cooked rice, names finished on the next line, a stray bracket", () => {
  const text = `CHICKEN FRIED RICE

Per Serving (makes 5)
500 Calories
41G Protein
47G Carbs
17G Fat

INGREDIENTS
Chicken/Marinade:
710g (25oz) chicken breast
30g (2 Tbsp) soy sauce
To taste: salt
Egg & Veggie Mix
200g (~¾ cup) egg whites
3 eggs
300g (~2 cups) mixed frozen
veggies (carrots, mushrooms,
onions or chefs choice)

Rice Base:
300g (1 ⅔ cups) day-old
cooked white rice (300g
dry weight, ~700g
cooked)
45g (3 (Tbsp) sesame oil

INSTRUCTIONS
1.In a large bowl, combine diced chicken breast with soy sauce and salt.
2.In a bowl, whisk together egg whites and eggs until fully combined. Set aside.
3.Add mixed frozen veggies to the pan and cook until softened.
4.Add day-old cooked white rice to the pan. Pour in sesame oil.`;
  const r = parseRecipeText(text);
  const by = (n: string) => r.ingredients.find((i) => i.name === n);
  assert.deepEqual(r.ingredients.map((i) => i.name), ["chicken breast", "soy sauce", "salt", "egg whites", "eggs", "mixed frozen veggies", "uncooked white rice", "sesame oil"]);
  assert.equal(by("mixed frozen veggies")?.prep, "carrots, mushrooms, onions or chefs choice");
  const rice = by("uncooked white rice")!;
  assert.equal(rice.amount, 300);
  assert.ok(rice.flags.every((f) => f.severity === "check"));
  assert.ok(rice.flags.some((f) => /dry weight given/.test(f.message)));
  assert.equal(by("sesame oil")?.amount, 45);
  // "white" in "white rice" isn't "egg whites".
  assert.deepEqual(stepsMentioning("egg whites", r.steps, "Egg & Veggie Mix"), [2]);
  assert.deepEqual(stepsMentioning("uncooked white rice", r.steps, "Rice Base"), [4]);
});

test("an ingredient the steps never name is placed where it most likely goes", () => {
  const steps = [
    "Preheat the oven to 400°F.",
    "Toss the chicken with the paprika and garlic.",
    "Heat a skillet over medium heat and cook the chicken for 6 minutes.",
    "Bake the potatoes for 25 minutes.",
    "Serve with the chicken.",
  ];
  const lines = [
    { name: "chicken breast", group: "Marinade" },
    { name: "cumin", group: "Marinade" }, // same section as the chicken → step 2
    { name: "olive oil", group: null }, // oil → the first heating step
    { name: "black pepper", group: null }, // seasoning → where things are tossed
    { name: "fresh parsley", group: null }, // garnish → where it's served
  ];
  assert.deepEqual(linkSteps(lines, steps), [
    { steps: [2, 3, 5], inferred: false },
    { steps: [2], inferred: true },
    { steps: [1], inferred: true },
    { steps: [2], inferred: true },
    { steps: [5], inferred: true },
  ]);
});
