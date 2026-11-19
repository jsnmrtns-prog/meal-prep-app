/**
 * Verification audits. Each audit re-derives what it checks by its own code
 * path instead of trusting calculate.ts, so a bug in one place shows up as a
 * disagreement instead of being repeated.
 *
 *  1. Ingredient audit   — food records, units, grams, states, allergies, preferences
 *  2. Nutrition audit    — every line recomputed with exact scaled-integer arithmetic
 *  3. Recipe audit       — lines sum to batch totals; batch weight adds up
 *  4. Portion audit      — batch ÷ portions = per portion, both directions; with a
 *                          preset, per-meal totals rebuilt from scratch meet every target
 *  5. Consistency audit  — steps use every ingredient; purchases, packages and cooked weights reconcile
 */
import { customAllergenHit, screenAllergens } from "./allergens.ts";
import { type CalcResult, recipeInputsHash } from "./calculate.ts";
import type { FoodDb } from "./fooddb.ts";
import { preferenceMatches } from "./preferences.ts";
import { NUTRIENT_KEYS, type IngredientLine, type NutrientKey, type Recipe, type UserProfile } from "./recipe.ts";
import type { PackageEntry } from "./packages.ts";
import type { Portioning, ShoppingList } from "./shopping.ts";
import type { YieldDb } from "./yields.ts";
import type { MacroPreset } from "./presets.ts";

/** Everything audit 5 needs; without it audit 5 is reported as pending. */
export interface PlanForAudit {
  yields: YieldDb;
  packages: PackageEntry[];
  shopping: ShoppingList;
  portioning: Portioning;
}

export type AuditStatus = "pass" | "warn" | "fail" | "pending";

export interface AuditResult {
  id: 1 | 2 | 3 | 4 | 5;
  name: string;
  status: AuditStatus;
  /** Problems (fail) and things to know (warn), in plain language. */
  findings: string[];
}

/**
 * Overall status, best to worst:
 *  verified                  all audits pass, no assumptions
 *  verified_with_assumptions all audits pass; some amounts or yields are assumed (each listed)
 *  checks_pending            nothing failed, but a required audit hasn't run yet
 *  estimate                  some nutrition comes from stand-in foods, so it can't be verified
 *  needs_review              an audit failed; the recipe must be fixed before use
 */
export type RecipeStatus = "verified" | "verified_with_assumptions" | "checks_pending" | "estimate" | "needs_review";

export interface AuditReport {
  status: RecipeStatus;
  audits: AuditResult[];
  inputsHash: string;
  engineVersion: string;
  foodDbVersion: string;
  checkedAt: string;
}

/** Largest allowed difference between the main calculation and an audit, in the nutrient's unit. */
const TOLERANCE = 1e-6;

// ---------- independent unit tables (deliberately not imported from units.ts) ----------
const GRAMS_PER: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
const ML_PER: Record<string, number> = {
  ml: 1, l: 1000, tsp: 4.92892159375, tbsp: 14.78676478125, fl_oz: 29.5735295625, cup: 236.5882365,
};

const COOKED_WORDS = ["cooked", "boiled", "roasted", "fried", "baked", "grilled", "braised", "broiled", "stewed", "sauteed", "steamed", "microwaved", "pan browned", "simmered"];

export function auditRecipe(
  recipe: Recipe,
  calc: CalcResult,
  db: FoodDb,
  profile: UserProfile,
  options: { now?: Date; plan?: PlanForAudit; targets?: MacroPreset } = {},
): AuditReport {
  const now = options.now ?? new Date();
  const audits: AuditResult[] = [
    ingredientAudit(recipe, calc, db, profile),
    nutritionAudit(recipe, calc, db),
    recipeTotalsAudit(calc),
    portionAudit(recipe, calc, db, options.targets),
    options.plan
      ? consistencyAudit(recipe, calc, db, options.plan)
      : { id: 5, name: "Consistency audit", status: "pending", findings: ["Shopping and cooked-weight plan not provided."] },
  ];

  if (calc.inputsHash !== recipeInputsHash(recipe, db.version)) {
    audits[0]!.status = "fail";
    audits[0]!.findings.push("The calculation is stale: the recipe changed after it was calculated.");
  }

  return {
    status: overallStatus(audits, recipe),
    audits,
    inputsHash: calc.inputsHash,
    engineVersion: calc.engineVersion,
    foodDbVersion: calc.foodDbVersion,
    checkedAt: now.toISOString(),
  };
}

export function isStale(recipe: Recipe, report: AuditReport, db: FoodDb): boolean {
  return report.inputsHash !== recipeInputsHash(recipe, db.version);
}

function overallStatus(audits: AuditResult[], recipe: Recipe): RecipeStatus {
  if (audits.some((a) => a.status === "fail")) return "needs_review";
  if (recipe.lines.some((l) => l.substituteFor)) return "estimate";
  if (audits.some((a) => a.status === "pending")) return "checks_pending";
  const assumed =
    audits.some((a) => a.status === "warn") ||
    recipe.lines.some((l) => (l.assumptions?.length ?? 0) > 0 || (l.food.kind === "builtin" && l.food.id !== "water"));
  return assumed ? "verified_with_assumptions" : "verified";
}

// ---------- 1. Ingredient audit ----------
function ingredientAudit(recipe: Recipe, calc: CalcResult, db: FoodDb, profile: UserProfile): AuditResult {
  const fails: string[] = [];
  const warns: string[] = [];
  if (calc.lines.length !== recipe.lines.length) fails.push("Ingredient count differs between the recipe and the calculation.");

  recipe.lines.forEach((line, i) => {
    const calcLine = calc.lines[i];
    if (!calcLine || calcLine.lineId !== line.id) {
      fails.push(`"${line.name}": missing from the calculation.`);
      return;
    }
    // Grams, re-derived here with separate unit tables and portion lookup.
    const grams = independentGrams(line, db);
    if (grams === null) fails.push(`"${line.name}": no sound basis for converting ${line.quantity.amount} ${describeQuantity(line)} to grams.`);
    else if (Math.abs(grams - calcLine.grams) > TOLERANCE) {
      fails.push(`"${line.name}": grams disagree (calculation ${calcLine.grams}, audit ${grams}).`);
    }
    if (line.quantity.amount === 0) warns.push(`"${line.name}": amount is zero.`);

    if (line.food.kind === "usda") {
      if (!db.has(line.food.fdcId)) {
        fails.push(`"${line.name}": USDA food ${line.food.fdcId} isn't in the database.`);
        return;
      }
      const food = db.get(line.food.fdcId);
      if (!food.usableForMacros) fails.push(`"${line.name}": USDA record ${food.fdcId} is incomplete (no calories or macros).`);
      const desc = ` ${food.description.toLowerCase().replace(/[^a-z]+/g, " ")} `;
      const cookedRecord = COOKED_WORDS.some((w) => desc.includes(` ${w} `));
      if ((line.state === "raw" || line.state === "dry" || line.state === "frozen") && cookedRecord) {
        fails.push(`"${line.name}" is measured ${line.state}, but its USDA record is a cooked food (${food.description}).`);
      }
      if (line.state === "cooked" && !cookedRecord) {
        fails.push(`"${line.name}" is measured cooked, but its USDA record isn't a cooked food (${food.description}).`);
      }
      const screen = screenAllergens(food);
      const hits = screen.allergens.filter((a) => profile.allergies.includes(a));
      if (hits.length > 0) fails.push(`"${line.name}" may contain ${hits.join(", ")}, which is on your allergy list.`);
      else if (profile.allergies.length > 0 && screen.needsLabelCheck) {
        warns.push(`"${line.name}": ingredients vary by brand; check the label for your allergens.`);
      }
    } else if (profile.allergies.length > 0 && !(line.food.kind === "builtin" && line.food.id === "water")) {
      warns.push(`"${line.name}": allergens can't be verified from this source; check the label.`);
    }

    for (const ca of profile.customAllergens ?? []) {
      const texts = [line.name, calcLine.food.description, line.substituteFor ?? ""];
      const hit = texts.map((t) => customAllergenHit(t, ca)).find((h) => h !== null);
      if (hit) fails.push(`"${line.name}" matches "${hit}", which is on your avoid list (${ca.label}).`);
    }
    if (line.substituteFor) warns.push(`"${line.name}": nutrition estimated from ${calcLine.food.description} (stand-in for ${line.substituteFor}).`);
    for (const a of line.assumptions ?? []) warns.push(`"${line.name}": ${a}`);

    const excluded = profile.preferences.find((p) => p.mode === "exclude" && preferenceMatches(p, line.name));
    if (excluded) fails.push(`"${line.name}" conflicts with your preference "${excluded.label}".`);
  });

  return { id: 1, name: "Ingredient audit", status: fails.length ? "fail" : warns.length ? "warn" : "pass", findings: [...fails, ...warns] };
}

function describeQuantity(line: IngredientLine): string {
  const q = line.quantity;
  return q.kind === "count" ? q.portionLabel : q.unit;
}

function independentGrams(line: IngredientLine, db: FoodDb): number | null {
  const q = line.quantity;
  if (q.kind === "mass") return q.amount * (GRAMS_PER[q.unit] ?? Number.NaN);
  if (line.food.kind === "builtin" && line.food.id === "water" && q.kind === "volume") return q.amount * (ML_PER[q.unit] ?? Number.NaN);
  if (line.food.kind !== "usda" || !db.has(line.food.fdcId)) return null;
  const portions = db.get(line.food.fdcId).portions;
  if (q.kind === "count") {
    const p = portions.find((x) => x.label === q.portionLabel);
    return p ? (q.amount * p.grams) / p.amount : null;
  }
  // Volume: same-unit portion (optionally the named one); otherwise convert through mL.
  const pool = portions.filter((p) => p.unit !== null && p.unit in ML_PER && (q.portionLabel === undefined || p.label === q.portionLabel));
  const sameUnit = pool.filter((p) => p.unit === q.unit);
  // USDA weights are rounded to 0.1 g, so two portions only conflict beyond 1% plus that rounding.
  const slack = (a: { grams: number }, b: { grams: number }) => 0.01 + 0.05 / a.grams + 0.05 / b.grams;
  if (sameUnit.length > 1) {
    const d = sameUnit.map((p) => p.grams / p.amount);
    if (d.some((x, k) => Math.abs(x - d[0]!) / d[0]! > slack(sameUnit[k]!, sameUnit[0]!))) return null; // conflicting USDA weights: no sound basis
  }
  const same = sameUnit[0];
  if (same) return (q.amount * same.grams) / same.amount;
  const any = pool[0];
  if (!any || any.unit === null) return null;
  const dens = pool.map((p) => p.grams / (p.amount * (ML_PER[p.unit ?? ""] ?? Number.NaN)));
  if (dens.some((x, k) => Math.abs(x - dens[0]!) / dens[0]! > slack(pool[k]!, pool[0]!))) return null;
  return q.amount * (ML_PER[q.unit] ?? Number.NaN) * (any.grams / (any.amount * (ML_PER[any.unit] ?? Number.NaN)));
}

// ---------- 2. Nutrition audit (scaled-integer arithmetic) ----------
const SCALE = 1_000_000n; // micro-units

function toMicro(x: number): bigint {
  return BigInt(Math.round(x * 1_000_000));
}

/** Contribution in micro-units: grams(µg-scaled) × value(µ-scaled) ÷ 100 ÷ 10^6, rounded half up. */
function microContribution(grams: number, per100: number): bigint {
  const num = toMicro(grams) * toMicro(per100);
  const den = 100n * SCALE;
  return (num + den / 2n) / den;
}

function per100From(line: IngredientLine, db: FoodDb, key: NutrientKey): number | null {
  const f = line.food;
  if (f.kind === "usda") return db.get(f.fdcId).per100g[key];
  if (f.kind === "label") {
    const v = f.perServing[key];
    return v === null ? null : (v * 100) / f.servingGrams;
  }
  return 0; // built-in foods (water, zero-calorie sweetener) are zero by definition
}

function nutritionAudit(recipe: Recipe, calc: CalcResult, db: FoodDb): AuditResult {
  const fails: string[] = [];
  recipe.lines.forEach((line, i) => {
    const calcLine = calc.lines[i];
    if (!calcLine) return;
    for (const key of NUTRIENT_KEYS) {
      const per100 = per100From(line, db, key);
      const reported = calcLine.nutrients[key];
      if (per100 === null || reported === null) {
        if (per100 !== reported && !(per100 === null && reported === null)) {
          fails.push(`"${line.name}" ${key}: known in one path and unknown in the other.`);
        }
        continue;
      }
      const audited = Number(microContribution(calcLine.grams, per100)) / 1_000_000;
      // The audit works in millionths: grams rounded to 1e-6 g carry up to per100 × 1e-8 of rounding.
      if (Math.abs(audited - reported) > 2 * TOLERANCE + Math.abs(per100) * 1e-8 + Math.abs(reported) * 1e-9) {
        fails.push(`"${line.name}" ${key}: calculation ${reported}, audit ${audited}.`);
      }
    }
  });
  return { id: 2, name: "Nutrition audit", status: fails.length ? "fail" : "pass", findings: fails };
}

// ---------- 3. Recipe audit ----------
function recipeTotalsAudit(calc: CalcResult): AuditResult {
  const fails: string[] = [];
  for (const key of NUTRIENT_KEYS) {
    let sum = 0n;
    let complete = true;
    for (const l of calc.lines) {
      const v = l.nutrients[key];
      if (v === null) complete = false;
      else sum += toMicro(v);
    }
    const audited = Number(sum) / 1_000_000;
    const total = calc.batch[key];
    if (Math.abs(audited - total.value) > TOLERANCE * calc.lines.length + 1e-9) {
      fails.push(`Batch ${key}: total ${total.value}, sum of ingredients ${audited}.`);
    }
    if (complete !== total.complete) fails.push(`Batch ${key}: completeness flag is wrong.`);
  }
  const grams = Number(calc.lines.reduce((s, l) => s + toMicro(l.grams), 0n)) / 1_000_000;
  if (Math.abs(grams - calc.batchGrams) > TOLERANCE * calc.lines.length + 1e-9) {
    fails.push(`Batch weight: total ${calc.batchGrams} g, sum of ingredients ${grams} g.`);
  }
  return { id: 3, name: "Recipe audit", status: fails.length ? "fail" : "pass", findings: fails };
}

// ---------- 4. Portion audit ----------
function portionAudit(recipe: Recipe, calc: CalcResult, db: FoodDb, targets?: MacroPreset): AuditResult {
  const fails: string[] = [];
  if (targets) fails.push(...targetFindings(recipe, db, targets));
  if (calc.portions !== recipe.portions) fails.push(`Portion count: recipe ${recipe.portions}, calculation ${calc.portions}.`);
  for (const key of NUTRIENT_KEYS) {
    const batch = calc.batch[key].value;
    const per = calc.perPortion[key].value;
    if (Math.abs(per * recipe.portions - batch) > 1e-6) fails.push(`${key}: per portion × ${recipe.portions} = ${per * recipe.portions}, batch = ${batch}.`);
    if (Math.abs(batch / recipe.portions - per) > 1e-6) fails.push(`${key}: batch ÷ ${recipe.portions} = ${batch / recipe.portions}, per portion = ${per}.`);
    if (calc.perPortion[key].complete !== calc.batch[key].complete) fails.push(`${key}: completeness differs between batch and portion.`);
  }
  return { id: 4, name: "Portion audit", status: fails.length ? "fail" : "pass", findings: fails };
}

/**
 * Per-meal totals rebuilt from the recipe alone (audit grams × USDA values,
 * scaled-integer sums), then compared with the preset's ranges, which are
 * also worked out here rather than taken from presets.ts.
 */
function targetFindings(recipe: Recipe, db: FoodDb, t: MacroPreset): string[] {
  const fails: string[] = [];
  if (recipe.portions !== t.meals) fails.push(`The recipe makes ${recipe.portions} portions; the preset asks for ${t.meals} meals.`);
  const totals: Record<"kcal" | "protein" | "carbs" | "fat", bigint> = { kcal: 0n, protein: 0n, carbs: 0n, fat: 0n };
  for (const line of recipe.lines) {
    const grams = independentGrams(line, db);
    if (grams === null) return [...fails, `"${line.name}": no basis for grams, so targets can't be checked.`];
    for (const key of ["kcal", "protein", "carbs", "fat"] as const) {
      const per100 = per100From(line, db, key);
      if (per100 === null) return [...fails, `"${line.name}": ${key} unknown, so targets can't be checked.`];
      totals[key] += microContribution(grams, per100);
    }
  }
  const perMeal = (key: keyof typeof totals) => Number(totals[key]) / 1_000_000 / recipe.portions;
  const check = (label: string, value: number, lo: number, hi: number, unit: string) => {
    if (value < lo - 1e-9 || value > hi + 1e-9) fails.push(`${label}: ${value.toFixed(2)} ${unit} per meal is outside ${lo.toFixed(2)}–${hi.toFixed(2)} ${unit}.`);
  };
  const kd = (t.kcal * t.kcalTolerancePct) / 100;
  check("Calories", perMeal("kcal"), t.kcal - kd, t.kcal + kd, "kcal");
  const p = t.protein;
  if (p.mode === "minimum") check("Protein", perMeal("protein"), p.grams, p.grams + 5, "g");
  else {
    const pd = (p.grams * (p.tolerancePct ?? t.kcalTolerancePct)) / 100;
    check("Protein", perMeal("protein"), p.grams - pd, p.grams + pd, "g");
  }
  if (t.carbs) check("Carbs", perMeal("carbs"), t.carbs.grams * (1 - t.carbs.tolerancePct / 100), t.carbs.grams * (1 + t.carbs.tolerancePct / 100), "g");
  if (t.fat) check("Fat", perMeal("fat"), t.fat.grams * (1 - t.fat.tolerancePct / 100), t.fat.grams * (1 + t.fat.tolerancePct / 100), "g");
  return fails;
}

// ---------- 5. Consistency audit ----------
const STOP_WORDS = new Set(["and", "the", "with", "for", "fresh", "minced", "diced", "chopped", "sliced", "drizzle", "large", "small", "medium", "packet"]);

function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9%]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Short or other names recipes use for the same food in their steps. */
const WORD_ALIASES: Record<string, string[]> = {
  mayonnaise: ["mayo"], mayo: ["mayonnaise"], yoghurt: ["yogurt"], yogurt: ["yoghurt"],
  coriander: ["cilantro"], cilantro: ["coriander"], chilli: ["chili"], chili: ["chilli"],
  scallions: ["green onion", "spring onion"], scallion: ["green onion", "spring onion"],
  courgette: ["zucchini"], zucchini: ["courgette"], aubergine: ["eggplant"], eggplant: ["aubergine"],
  mince: ["ground"], ground: ["mince", "minced"], parmigiano: ["parmesan"], parmesan: ["parm", "parmigiano"],
  potatoes: ["fries", "chips", "wedges"], potato: ["fries", "chips", "wedges"],
};

/**
 * True when a step names the ingredient, another name for it ("mayo" for
 * mayonnaise), or the section it belongs to ("season with taco spice mix").
 */
export function stepMentionsLine(stepText: string, name: string, group?: string | null): boolean {
  const words = significantWords(name);
  if (words.some((w) => mentions(stepText, w) || (WORD_ALIASES[w] ?? []).some((a) => mentions(stepText, a)))) return true;
  if (!group) return false;
  const g = significantWords(group);
  if (g.length === 0) return false;
  const text = ` ${stepText.toLowerCase().replace(/[^a-z0-9%]+/g, " ")} `;
  if (text.includes(` ${g.join(" ")} `)) return true;
  // "Chipotle Spicy Sauce" → "the spicy sauce", "Taco Spice Mix" → "taco spice": all but a generic last word.
  const core = g.filter((w) => !["sauce", "mix", "dressing", "marinade", "topping", "toppings", "base", "seasoning"].includes(w));
  return core.length >= 1 && core.length < g.length && core.every((w) => mentions(stepText, w)) && (core.length >= 2 || mentions(stepText, g.at(-1)!));
}

function mentions(stepText: string, word: string): boolean {
  if (word.includes(" ")) return ` ${stepText.toLowerCase().replace(/[^a-z0-9%]+/g, " ")} `.includes(` ${word} `);
  const text = ` ${stepText.toLowerCase().replace(/[^a-z0-9%]+/g, " ")} `;
  const stem = word.endsWith("es") && word.length > 4 ? word.slice(0, -2) : word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
  return text.includes(` ${word} `) || new RegExp(` ${stem}(s|es)? `).test(text);
}

function consistencyAudit(recipe: Recipe, calc: CalcResult, db: FoodDb, plan: PlanForAudit): AuditResult {
  const fails: string[] = [];
  const warns: string[] = [];
  const eps = 1e-6;

  // a) Every ingredient is used in the instructions (or is optional).
  recipe.lines.forEach((line) => {
    if (line.optional) return;
    const steps = line.usedInSteps ?? [];
    if (steps.length === 0) {
      fails.push(`"${line.name}" isn't linked to any instruction step.`);
      return;
    }
    for (const n of steps) {
      const step = recipe.steps[n - 1];
      if (!step) {
        fails.push(`"${line.name}" points to step ${n}, which doesn't exist.`);
        continue;
      }
      const words = significantWords(line.name);
      if (words.length > 0 && !stepMentionsLine(step.text, line.name, line.group)) {
        fails.push(`Step ${n} doesn't mention "${line.name}".`);
      }
    }
  });

  // b) Nothing is missing from, or duplicated in, the shopping list.
  const shopped = new Map<string, number>();
  for (const item of plan.shopping.items) for (const id of item.lineIds) shopped.set(id, (shopped.get(id) ?? 0) + 1);
  recipe.lines.forEach((line) => {
    const isWater = line.food.kind === "builtin" && line.food.id === "water";
    const count = shopped.get(line.id) ?? 0;
    if (!isWater && count !== 1) fails.push(`"${line.name}" appears ${count} times in the shopping list (expected once).`);
    if (isWater && count !== 0) fails.push(`Water shouldn't be on the shopping list.`);
  });

  // c) Purchase amounts cover usable amounts, recomputed from the yields here.
  const calcGrams = new Map(calc.lines.map((l) => [l.lineId, l.grams]));
  for (const p of plan.shopping.purchase) {
    const line = recipe.lines.find((l) => l.id === p.lineId);
    if (!line) {
      fails.push(`Purchase line ${p.lineId} has no ingredient.`);
      continue;
    }
    let kept = 1;
    if (line.prep?.boneYieldId) {
      const y = plan.yields.get(line.prep.boneYieldId);
      if (y.kind !== "bone") fails.push(`"${line.name}": ${y.id} isn't a bone-removal yield.`);
      kept *= y.percent / 100;
    }
    if (line.prep?.trimKeptPercent !== undefined) kept *= line.prep.trimKeptPercent / 100;
    const usable = calcGrams.get(line.id) ?? Number.NaN;
    if (Math.abs(p.usableGrams - usable) > eps) fails.push(`"${line.name}": shopping uses ${p.usableGrams} g, recipe uses ${usable} g.`);
    if (Math.abs(p.purchaseGrams * kept - usable) > eps * 10) {
      fails.push(`"${line.name}": buying ${p.purchaseGrams} g at ${kept * 100}% usable doesn't give ${usable} g.`);
    }
  }

  // d) Items add up, and packages cover what's needed without an extra package.
  const noPackage: string[] = [];
  for (const item of plan.shopping.items) {
    const usable = item.lineIds.reduce((s, id) => s + (calcGrams.get(id) ?? 0), 0);
    if (Math.abs(item.usableGrams - usable) > eps * item.lineIds.length) fails.push(`"${item.name}": item total ${item.usableGrams} g, ingredients ${usable} g.`);
    const purchase = plan.shopping.purchase.filter((p) => item.lineIds.includes(p.lineId)).reduce((s, p) => s + p.purchaseGrams, 0);
    if (Math.abs(item.purchaseGrams - purchase) > eps * item.lineIds.length) fails.push(`"${item.name}": purchase total doesn't add up.`);
    const b = item.buy;
    if (b.kind === "package") {
      if (b.count * b.packageGrams < item.purchaseGrams - eps) fails.push(`"${item.name}": ${b.count} × ${b.label} doesn't cover ${item.purchaseGrams} g.`);
      if ((b.count - 1) * b.packageGrams >= item.purchaseGrams - eps) fails.push(`"${item.name}": one package fewer would be enough.`);
      if (Math.abs(b.totalGrams - b.count * b.packageGrams) > eps) fails.push(`"${item.name}": package total is wrong.`);
      if (!b.verified) warns.push(`"${item.name}": package size (${b.label}) is a typical size, not verified for your store.`);
    } else if (b.kind === "each") {
      if (b.count * b.eachGrams < item.purchaseGrams - eps) fails.push(`"${item.name}": ${b.count} × ${b.label} doesn't cover ${item.purchaseGrams} g.`);
    } else if (b.kind === "by_weight" || b.kind === "pantry" || b.kind === "unknown_package") {
      if (Math.abs(b.grams - item.purchaseGrams) > eps) fails.push(`"${item.name}": amount to buy doesn't match the purchase total.`);
      if (b.kind === "unknown_package") noPackage.push(item.name);
    }
  }
  // One note for all of them: a list of foods without a store package size isn't a problem, only a reminder.
  if (noPackage.length) {
    warns.push(`No store package size yet for ${noPackage.length === 1 ? `"${noPackage[0]}"` : `${noPackage.length} foods (${noPackage.map((n) => `"${n}"`).join(", ")})`}: the shopping list shows the amount to buy instead. Add sizes under Settings → Packages.`);
  }

  // e) Cooked weights reconcile.
  const por = plan.portioning;
  if (por.lines.length !== recipe.lines.length) fails.push("Cooked-weight lines don't match the ingredients.");
  let sum = 0;
  por.lines.forEach((l, i) => {
    sum += l.cookedGrams;
    if (Math.abs(l.rawGrams - (calc.lines[i]?.grams ?? Number.NaN)) > eps) fails.push(`"${l.name}": cooked plan starts from the wrong raw weight.`);
    const line = recipe.lines[i];
    const cook = line?.cook;
    if (cook?.kind === "yield") {
      const y = plan.yields.get(cook.yieldId);
      if (Math.abs(l.cookedGrams - (l.rawGrams * y.percent) / 100) > eps) fails.push(`"${l.name}": cooked weight doesn't match its yield.`);
      if (cook.match === "closest") warns.push(`"${l.name}": cooked weight uses the closest USDA yield (${y.description}, ${y.method}).`);
    }
  });
  if (Math.abs(sum - por.batchCookedGrams) > eps * por.lines.length) fails.push(`Cooked batch ${por.batchCookedGrams} g doesn't equal the sum of ingredients (${sum} g).`);
  const batch = recipe.measuredCookedBatchGrams ?? por.batchCookedGrams;
  if (Math.abs(por.perContainerGrams * recipe.portions - batch) > 1e-6) fails.push(`Container weight × ${recipe.portions} doesn't equal the batch weight.`);
  if (!por.measured && por.assumptions.length > 0) warns.push("Container weights are estimates: weigh the finished batch and divide by the number of containers.");

  return { id: 5, name: "Consistency audit", status: fails.length ? "fail" : warns.length ? "warn" : "pass", findings: [...fails, ...warns] };
}
