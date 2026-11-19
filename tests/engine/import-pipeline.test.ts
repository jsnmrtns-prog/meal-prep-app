// M6 gate, part 2: PDF and Word files, the AI shortcut's recipe block, food
// matching, and a full import → recipe that passes the audits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  AI_BLOCK_FORMAT,
  AI_PROMPT,
  FoodDb,
  STARTING_PROFILE,
  applyPreferences,
  auditRecipe,
  calculateRecipe,
  docxText,
  extractJson,
  looksLikeAiBlock,
  parseAiBlock,
  parseRecipeText,
  piecesToLines,
  quantityFor,
  recipeFromImport,
  recipeProblems,
  stepsMentioning,
  suggestFoods,
  wantFor,
  type FoodDbFile,
  type ReviewedLine,
  type TextPiece,
} from "../../src/engine/index.ts";

const files = new URL("../fixtures/import-files/", import.meta.url);
const read = (u: URL) => readFileSync(u);
const db = new FoodDb(JSON.parse(readFileSync(new URL("../../public/data/fooddb.json", import.meta.url), "utf8")) as FoodDbFile);

async function pdfLines(data: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages: TextPiece[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.flatMap((it) => ("str" in it ? [{ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width, height: it.height || Math.abs(it.transform[3] as number) }] : [])));
  }
  await task.destroy();
  return piecesToLines(pages).join("\n");
}

test("PDF with a two-column ingredient list is read in the right order", async () => {
  const text = await pdfLines(new Uint8Array(read(new URL("two-column.pdf", files))));
  const r = parseRecipeText(text);
  assert.equal(r.title, "SPICY CHICKEN PASTA");
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients.map((i) => [i.group, i.amount, i.unit && i.unit.kind !== "count" ? i.unit.unit : null, i.name]), [
    ["Chicken", 600, "g", "boneless skinless chicken breast"],
    ["Chicken", 1, "tbsp", "olive oil"],
    ["Chicken", 1, "tsp", "smoked paprika"],
    ["Sauce", 200, "g", "tomato passata"],
    ["Sauce", 2, null, "garlic cloves"],
    ["Pasta", 280, "g", "penne"],
    ["Pasta", 60, "g", "light cream"],
    ["Pasta", 30, "g", "grated parmesan"],
    ["Pasta", 1, "tsp", "chili flakes"],
  ]);
  assert.equal(r.steps.length, 4);
  assert.match(r.steps[0]!, /^Season the chicken breast .* about 6 minutes per side\. Slice\.$/);
  assert.ok(!r.steps.some((s) => /TABLE OF CONTENTS/.test(s)), "page footer is ignored");
});

test("Word document is read", async () => {
  const text = await docxText(new Uint8Array(read(new URL("turkey-taco-bowls.docx", files))));
  const r = parseRecipeText(text);
  assert.equal(r.title, "Weeknight Turkey Taco Bowls");
  assert.equal(r.servings, 4);
  assert.equal(r.ingredients.length, 6);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.ingredients[3]!.packageSize, { amount: 15, unit: "oz" });
  assert.deepEqual(r.ingredients[5]!.flags.map((f) => f.code), ["suggested"]);
});

// The user's own recipe PDFs are not in the repository; this runs only where they're present.
const userPdfs = ["/mnt/user-data/uploads/a52b07aa-Teriyaki_Fried_Rice.pdf", "/mnt/user-data/uploads/804e0c57-Taco_Mac__Cheese.pdf"];
test("your two recipe PDFs read correctly", { skip: !userPdfs.every(existsSync) && "PDFs not available here" }, async () => {
  const teriyaki = parseRecipeText(await pdfLines(new Uint8Array(read(new URL(`file://${userPdfs[0]}`)))));
  assert.equal(teriyaki.servings, 5);
  assert.equal(teriyaki.steps.length, 6);
  assert.deepEqual(teriyaki.ingredients.map((i) => i.amount), [710, 30, 5, 15, 3, 60, 24, 60, 1, 8, 15, 300, 300, 2, 200, 1, 1]);
  const taco = parseRecipeText(await pdfLines(new Uint8Array(read(new URL(`file://${userPdfs[1]}`)))));
  assert.equal(taco.servings, 5);
  assert.equal(taco.steps.length, 5);
  assert.deepEqual(taco.ingredients.map((i) => i.amount), [2, 2, 1, 454, 30, 50, 1, 1, 330, 350, 25, 50, 10, 50]);
  const velveeta = taco.ingredients.find((i) => /Velveeta/.test(i.name))!;
  assert.deepEqual(velveeta.flags.map((f) => f.code).sort(), ["alternatives", "joined_line"]);
});

const userPage = "/mnt/user-data/uploads/24725eb5-Test_page.pdf";
test("your cookbook page (taco beef and crispy potatoes) reads correctly", { skip: !existsSync(userPage) && "PDF not available here" }, async () => {
  const r = parseRecipeText(await pdfLines(new Uint8Array(read(new URL(`file://${userPage}`)))));
  assert.equal(r.servings, 4);
  assert.equal(r.steps.length, 5, JSON.stringify(r.steps));
  assert.ok(r.steps.every((s) => !/\bz\b|»|STEP|Contents/.test(s)), JSON.stringify(r.steps));
  assert.equal(r.notes.length, 5);
  assert.equal(r.ingredients.length, 33);
  assert.deepEqual([...new Set(r.ingredients.map((i) => i.group))], ["Taco Spice Mix", "Seasoned Taco Potatoes", "Taco Beef", "Chipotle Spicy Sauce", "Pico de Gallo"]);
  assert.ok(r.ingredients.slice(0, 8).every((i) => i.amount === 2.5), "spice mix scaled to 1 + 1.5 servings");
  assert.ok(r.ingredients.every((i) => i.amount !== null));
  assert.equal(r.ingredients.filter((i) => i.flags.some((f) => f.severity === "fix")).length, 0, r.ingredients.filter((i) => i.flags.some((f) => f.severity === "fix")).map((i) => i.raw).join(" | "));
});

test("AI prompt asks for the exact block format and forbids guessing", () => {
  assert.ok(AI_PROMPT.includes(`"format": "${AI_BLOCK_FORMAT}"`));
  assert.match(AI_PROMPT, /Never guess/);
  assert.match(AI_PROMPT, /Don't convert units/);
  const example = extractJson(AI_PROMPT);
  assert.ok(example && parseAiBlock(AI_PROMPT).ok, "the example in the prompt is itself a valid block");
});

test("AI reply with text around the block (ChatGPT style); a misread amount is flagged", () => {
  const text = readFileSync(new URL("ai-reply-chatgpt-style.txt", files), "utf8");
  assert.ok(looksLikeAiBlock(text));
  const r = parseAiBlock(text);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.recipe.title, "Mom's chicken & rice");
  assert.equal(r.recipe.servings, 4);
  assert.equal(r.recipe.steps.length, 4);
  const broth = r.recipe.ingredients[3]!;
  assert.equal(broth.amount, 3, "the app's own reading is kept");
  assert.ok(broth.flags.some((f) => f.code === "ai_mismatch" && f.severity === "fix" && /AI read this as 2 cups/.test(f.message)));
  assert.ok(r.recipe.ingredients[0]!.flags.some((f) => f.code === "ocr_fix"), "the app still flags its own concerns");
  assert.ok(!r.recipe.ingredients[1]!.flags.some((f) => f.code === "ai_mismatch"), "same reading, no mismatch");
  assert.deepEqual(r.recipe.flags.map((f) => f.code), ["ai_unclear"]);
});

test("AI reply that's only the block (Claude style)", () => {
  const r = parseAiBlock(readFileSync(new URL("ai-reply-claude-style.txt", files), "utf8"));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.recipe.ingredients.length, 6);
  assert.ok(r.recipe.ingredients.every((i) => !i.flags.some((f) => f.code === "ai_mismatch")), JSON.stringify(r.recipe.ingredients.map((i) => i.flags)));
  assert.ok(r.recipe.ingredients[5]!.flags.some((f) => f.code === "unusual"), "a pinch still needs a real amount");
});

test("a reply without a valid block is refused with a reason", () => {
  const r = parseAiBlock(readFileSync(new URL("ai-reply-broken.txt", files), "utf8"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.problems[0]!, /No recipe block found/);
  const bad = parseAiBlock('```json\n{"format":"meal-prep-recipe-v1","title":"x","servings":2.5,"ingredients":[{"original":"","amount":"2","item":"egg"}],"steps":[]}\n```');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.problems.some((p) => /Servings must be a whole number/.test(p)));
    assert.ok(bad.problems.some((p) => /"original" text is missing/.test(p)));
    assert.ok(bad.problems.some((p) => /amounts must be numbers/.test(p)));
  }
});

test("food suggestions: the expected USDA food is first for common ingredients", () => {
  const cases: [string, string][] = [
    ["boneless skinless chicken breasts", "Chicken, breast, boneless, skinless, raw"],
    ["chicken thighs", "Chicken, thigh, boneless, skinless, raw"],
    ["93% lean ground turkey", "Turkey, ground, 93% lean/ 7% fat, raw"],
    ["ground beef 93/7", "Beef, ground, 93% lean meat / 7% fat, raw"],
    ["olive oil", "Oil, olive, salad or cooking"],
    ["uncooked white rice", "Rice, white, long-grain, regular, raw, enriched"],
    ["cooked jasmine rice", "Rice, white, long-grain, regular, enriched, cooked"],
    ["plain nonfat Greek yogurt", "Yogurt, Greek, plain, nonfat"],
    ["cottage cheese", "Cheese, cottage, lowfat, 2% milkfat"],
    ["garlic powder", "Spices, garlic powder"],
    ["broccoli florets", "Broccoli, raw"],
  ];
  for (const [name, want] of cases) assert.equal(suggestFoods(name, db, 1)[0]?.description, want, name);
  const garlic = suggestFoods("garlic", db, 1, wantFor({ unit: { kind: "count", noun: "clove" }, sizeWord: null, packageSize: null, name: "garlic" }))[0]!;
  assert.ok(garlic.portions.some((p) => p.label === "clove"), "prefers the garlic record that has a clove weight");
});

test("counts without a size use large eggs or a medium size, and say so; the other sizes stay on offer", () => {
  const egg = db.get(171287);
  assert.deepEqual(quantityFor({ amount: 2, unit: null, sizeWord: "large", packageSize: null, name: "eggs" }, egg).quantity, { kind: "count", amount: 2, portionLabel: "large" });
  const noSize = quantityFor({ amount: 2, unit: null, sizeWord: null, packageSize: null, name: "eggs" }, egg);
  assert.deepEqual(noSize.quantity, { kind: "count", amount: 2, portionLabel: "large" });
  assert.match(noSize.assumed!, /No size given: used USDA "large"/);
  assert.ok(noSize.options.length > 1);
  const onion = db.get(170000);
  const o = quantityFor({ amount: 1, unit: null, sizeWord: null, packageSize: null, name: "onion" }, onion);
  assert.equal(o.quantity?.kind === "count" && o.quantity.portionLabel.startsWith("medium"), true, JSON.stringify(o.quantity));
  assert.deepEqual(quantityFor({ amount: 1, unit: { kind: "count", noun: "can" }, sizeWord: null, packageSize: { amount: 15, unit: "oz" }, name: "black beans" }, null).quantity, { kind: "mass", amount: 15, unit: "oz" });
});

test("steps are linked to the ingredients they mention", () => {
  const steps = ["Season the chicken breasts with chili powder.", "Cook the white rice.", "Top with cilantro."];
  assert.deepEqual(stepsMentioning("boneless skinless chicken breasts", steps), [1]);
  assert.deepEqual(stepsMentioning("uncooked white rice", steps), [2]);
  assert.deepEqual(stepsMentioning("chili powder", steps), [1]);
  assert.deepEqual(stepsMentioning("salt", steps), []);
});

test("a fully reviewed import becomes a recipe that passes the audits", () => {
  const text = readFileSync(new URL("../fixtures/import/05-web-greek-yogurt-chicken.txt", import.meta.url), "utf8");
  const parsed = parseRecipeText(text);
  const lines: ReviewedLine[] = parsed.ingredients.map((p) => {
    const food = suggestFoods(p.name, db, 1, wantFor(p))[0]!;
    const q = quantityFor(p, food);
    // USDA has no cup weight for plain nonfat Greek yogurt, so the app asks; the user enters 227 g from the label.
    if (/greek yogurt/i.test(p.name)) {
      assert.equal(q.quantity, null);
      assert.equal(q.options.length, 0);
      assert.match(q.problem!, /no cup weight/);
    } else assert.ok(q.quantity ?? q.options[0], `${p.raw}: ${q.problem}`);
    // Where USDA has more than one weight per spoon (dried oregano), the app offers the choices; take the first.
    const quantity = q.quantity ?? q.options[0]?.quantity ?? { kind: "mass" as const, amount: 227, unit: "g" as const };
    return { name: p.name, food, quantity, state: /rice|orzo|pasta/i.test(food.description) ? "dry" : "raw", role: "other", optional: p.optional, group: p.group, usedInSteps: stepsMentioning(p.name, parsed.steps), confirmed: p.flags.map((f) => f.message) };
  });
  const recipe = recipeFromImport({ id: "greek-yogurt-chicken", title: parsed.title!, servings: parsed.servings!, lines, steps: parsed.steps, notes: parsed.notes, source: { kind: "paste", text, importedAt: "2026-11-18T12:00:00Z" } });
  assert.deepEqual(recipeProblems(recipe), []);
  assert.equal(recipe.source?.text, text, "the original text is kept unchanged");
  const prepared = applyPreferences(recipe, STARTING_PROFILE.preferences).recipe;
  const calc = calculateRecipe(prepared, db);
  const report = auditRecipe(prepared, calc, db, STARTING_PROFILE);
  for (const a of report.audits) assert.notEqual(a.status, "fail", `audit ${a.id}: ${a.findings.join(" | ")}`);
  assert.ok(calc.perPortion.protein.value > 35 && calc.perPortion.protein.value < 45, `2½ lb chicken thighs and a cup of yogurt for 6: ${calc.perPortion.protein.value}`);
});

test("imported dry rice and pasta get USDA's cooked-weight factor", async () => {
  const { defaultCookFor, guessState } = await import("../../src/engine/index.ts");
  const rice = db.get(168877);
  assert.equal(guessState(rice, "uncooked white rice"), "dry");
  assert.deepEqual(defaultCookFor(rice, "dry"), { kind: "yield", yieldId: "hydrate-rice-white-long-grain", match: "exact" });
  assert.deepEqual(defaultCookFor(db.get(2512381), "dry"), { kind: "yield", yieldId: "hydrate-rice-white-long-grain", match: "exact" }, "same food: long-grain white rice, raw");
  assert.deepEqual(defaultCookFor(db.get(169736), "dry"), { kind: "yield", yieldId: "hydrate-pasta-enriched", match: "exact" });
  assert.deepEqual(defaultCookFor(db.get(2646170), "raw"), { kind: "unchanged" });
});
