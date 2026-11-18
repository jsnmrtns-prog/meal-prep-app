/**
 * Recipe nutrition calculation (primary path, floating point).
 *
 *   nutrient = usable grams × value per 100 g ÷ 100
 *
 * Audits in audit.ts re-check every number by an independent path.
 */
import { gramsForAmount, type FoodDb } from "./fooddb.ts";
import {
  CORE_NUTRIENTS,
  NUTRIENT_KEYS,
  type BuiltinFoodId,
  type FoodRef,
  type IngredientLine,
  type NutrientKey,
  type NutrientValues,
  type Recipe,
} from "./recipe.ts";
import { ENGINE_VERSION } from "./version.ts";

/** How much the user can rely on a line's nutrition source. */
export type SourceTrust = "usda" | "label" | "builtin" | "substitute";

export interface ResolvedFood {
  description: string;
  per100g: NutrientValues;
  trust: SourceTrust;
  /** Short source text for the nutrition report, e.g. "USDA SR Legacy, FDC 171077". */
  sourceText: string;
  fdcId?: number;
}

export const BUILTIN_FOODS: Record<BuiltinFoodId, { description: string; per100g: NutrientValues; basis: string }> = {
  water: {
    description: "Water",
    per100g: { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, sugars: 0, sodium: 0, satFat: 0 },
    basis: "Water adds no calories or macronutrients.",
  },
  zero_calorie_sweetener: {
    description: "Zero-calorie sweetener (assumed)",
    per100g: { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, sugars: 0, sodium: 0, satFat: 0 },
    basis: "Assumed from the product's zero-calorie claim; sugar alcohols are not counted as carbs. Add the product label for exact values.",
  },
};

export class RecipeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeInputError";
  }
}

export function resolveFood(ref: FoodRef, db: FoodDb, substituteFor?: string): ResolvedFood {
  if (ref.kind === "usda") {
    const food = db.get(ref.fdcId);
    const { water: _water, ...rest } = food.per100g;
    return {
      description: food.description,
      per100g: rest,
      trust: substituteFor ? "substitute" : "usda",
      sourceText: `USDA ${food.dataset === "foundation" ? "Foundation Foods" : "SR Legacy"}, FDC ${food.fdcId}`,
      fdcId: food.fdcId,
    };
  }
  if (ref.kind === "label") {
    if (!(ref.servingGrams > 0)) throw new RecipeInputError(`Label food "${ref.name}" needs a serving size in grams`);
    const scale = 100 / ref.servingGrams;
    const per100g = Object.fromEntries(
      NUTRIENT_KEYS.map((k) => [k, ref.perServing[k] === null ? null : ref.perServing[k] * scale]),
    ) as unknown as NutrientValues;
    return { description: ref.name, per100g, trust: substituteFor ? "substitute" : "label", sourceText: ref.source };
  }
  const builtin = BUILTIN_FOODS[ref.id];
  return { description: builtin.description, per100g: builtin.per100g, trust: "builtin", sourceText: builtin.basis };
}

export interface GramsResolution {
  grams: number;
  /** How the grams were found, e.g. "1 tsp = 4.5 g (USDA portion)". */
  basis: string;
}

/** Converts a line's quantity to grams of usable food. Throws when there's no sound basis. */
export function resolveGrams(line: IngredientLine, db: FoodDb): GramsResolution {
  const q = line.quantity;
  if (!(q.amount >= 0) || !Number.isFinite(q.amount)) {
    throw new RecipeInputError(`"${line.name}": amount must be zero or more`);
  }
  if (q.kind === "mass") {
    return { grams: massGrams(q.amount, q.unit), basis: `${q.amount} ${q.unit} (exact)` };
  }
  if (line.food.kind !== "usda") {
    if (line.food.kind === "builtin" && line.food.id === "water" && q.kind === "volume") {
      // Water: 1 mL = 1 g.
      const ml = volumeMl(q.amount, q.unit);
      return { grams: ml, basis: `${q.amount} ${q.unit} of water = ${ml} g` };
    }
    throw new RecipeInputError(`"${line.name}": enter this ingredient by weight`);
  }
  const food = db.get(line.food.fdcId);
  if (q.kind === "volume") {
    const r = gramsForAmount(food, q.amount, q.unit, q.portionLabel);
    if (r.ok) {
      const p = r.portion;
      return { grams: r.grams, basis: p ? `${p.amount} ${p.label} = ${p.grams} g (USDA portion)` : `${q.unit}` };
    }
    if (r.reason === "ambiguous") {
      throw new RecipeInputError(
        `"${line.name}": USDA lists different weights for ${q.unit} (${r.options.map((o) => o.label).join("; ")}). Choose one.`,
      );
    }
    throw new RecipeInputError(`"${line.name}": USDA has no ${q.unit} weight for this food; enter it by weight`);
  }
  const portion = food.portions.find((p) => p.label === q.portionLabel);
  if (!portion) throw new RecipeInputError(`"${line.name}": USDA portion "${q.portionLabel}" not found`);
  return { grams: (q.amount / portion.amount) * portion.grams, basis: `${portion.amount} ${portion.label} = ${portion.grams} g (USDA portion)` };
}

const MASS: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
const VOLUME_ML: Record<string, number> = {
  ml: 1, l: 1000, tsp: 4.92892159375, tbsp: 14.78676478125, fl_oz: 29.5735295625, cup: 236.5882365,
};
const massGrams = (amount: number, unit: string) => amount * (MASS[unit] ?? Number.NaN);
const volumeMl = (amount: number, unit: string) => amount * (VOLUME_ML[unit] ?? Number.NaN);

export interface LineResult {
  lineId: string;
  name: string;
  grams: number;
  gramsBasis: string;
  food: ResolvedFood;
  /** Nutrients this line contributes. Null = unknown for this food. */
  nutrients: NutrientValues;
  assumptions: string[];
  substituteFor?: string;
}

export interface Total {
  value: number;
  /** False when at least one line's value is unknown, so the total is a lower bound. */
  complete: boolean;
}
export type Totals = Record<NutrientKey, Total>;

export interface CalcResult {
  engineVersion: string;
  foodDbVersion: string;
  inputsHash: string;
  portions: number;
  lines: LineResult[];
  batch: Totals;
  perPortion: Totals;
  batchGrams: number;
}

export function calculateRecipe(recipe: Recipe, db: FoodDb): CalcResult {
  if (!Number.isInteger(recipe.portions) || recipe.portions < 1) {
    throw new RecipeInputError("Portion count must be a whole number of at least 1");
  }
  const ids = new Set<string>();
  const lines: LineResult[] = recipe.lines.map((line) => {
    if (ids.has(line.id)) throw new RecipeInputError(`Duplicate ingredient ID ${line.id}`);
    ids.add(line.id);
    const food = resolveFood(line.food, db, line.substituteFor);
    for (const key of CORE_NUTRIENTS) {
      if (food.per100g[key] === null) throw new RecipeInputError(`"${line.name}": ${food.description} has no ${key} value`);
    }
    const { grams, basis } = resolveGrams(line, db);
    const nutrients = Object.fromEntries(
      NUTRIENT_KEYS.map((k) => [k, food.per100g[k] === null ? null : (grams * food.per100g[k]) / 100]),
    ) as unknown as NutrientValues;
    const result: LineResult = {
      lineId: line.id,
      name: line.name,
      grams,
      gramsBasis: basis,
      food,
      nutrients,
      assumptions: line.assumptions ?? [],
    };
    if (line.substituteFor) result.substituteFor = line.substituteFor;
    return result;
  });

  const batch = sumTotals(lines.map((l) => l.nutrients));
  const perPortion = Object.fromEntries(
    NUTRIENT_KEYS.map((k) => [k, { value: batch[k].value / recipe.portions, complete: batch[k].complete }]),
  ) as Totals;

  return {
    engineVersion: ENGINE_VERSION,
    foodDbVersion: db.version,
    inputsHash: recipeInputsHash(recipe, db.version),
    portions: recipe.portions,
    lines,
    batch,
    perPortion,
    batchGrams: lines.reduce((s, l) => s + l.grams, 0),
  };
}

function sumTotals(rows: NutrientValues[]): Totals {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((k) => {
      let value = 0;
      let complete = true;
      for (const r of rows) {
        const v = r[k];
        if (v === null) complete = false;
        else value += v;
      }
      return [k, { value, complete }];
    }),
  ) as Totals;
}

/** Stable fingerprint of everything a calculation depends on; a mismatch means results are stale. */
export function recipeInputsHash(recipe: Recipe, foodDbVersion: string): string {
  const payload = canonicalJson({
    engine: ENGINE_VERSION,
    foodDb: foodDbVersion,
    portions: recipe.portions,
    lines: recipe.lines,
  });
  // FNV-1a, 64-bit.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < payload.length; i++) {
    h ^= BigInt(payload.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
