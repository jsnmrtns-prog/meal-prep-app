/**
 * Verification audits. Each audit re-derives what it checks by its own code
 * path instead of trusting calculate.ts, so a bug in one place shows up as a
 * disagreement instead of being repeated.
 *
 *  1. Ingredient audit   — food records, units, grams, states, allergies, preferences
 *  2. Nutrition audit    — every line recomputed with exact scaled-integer arithmetic
 *  3. Recipe audit       — lines sum to batch totals; batch weight adds up
 *  4. Portion audit      — batch ÷ portions = per portion, both directions
 *  5. Consistency audit  — instructions and shopping quantities (milestone M3; reported as pending)
 */
import { screenAllergens } from "./allergens.ts";
import { type CalcResult, recipeInputsHash } from "./calculate.ts";
import type { FoodDb } from "./fooddb.ts";
import { preferenceMatches } from "./preferences.ts";
import { NUTRIENT_KEYS, type IngredientLine, type NutrientKey, type Recipe, type UserProfile } from "./recipe.ts";

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
  now: Date = new Date(),
): AuditReport {
  const audits: AuditResult[] = [
    ingredientAudit(recipe, calc, db, profile),
    nutritionAudit(recipe, calc, db),
    recipeTotalsAudit(calc),
    portionAudit(recipe, calc),
    { id: 5, name: "Consistency audit", status: "pending", findings: ["Instructions and shopping quantities are checked from milestone M3 onward."] },
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
  if (sameUnit.length > 1) {
    const d = sameUnit.map((p) => p.grams / p.amount);
    if (d.some((x) => Math.abs(x - d[0]!) / d[0]! > 0.01)) return null; // conflicting USDA weights: no sound basis
  }
  const same = sameUnit[0];
  if (same) return (q.amount * same.grams) / same.amount;
  const any = pool[0];
  if (!any || any.unit === null) return null;
  const dens = pool.map((p) => p.grams / (p.amount * (ML_PER[p.unit ?? ""] ?? Number.NaN)));
  if (dens.some((x) => Math.abs(x - dens[0]!) / dens[0]! > 0.01)) return null;
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
      if (Math.abs(audited - reported) > 2 * TOLERANCE + Math.abs(reported) * 1e-9) {
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
function portionAudit(recipe: Recipe, calc: CalcResult): AuditResult {
  const fails: string[] = [];
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
