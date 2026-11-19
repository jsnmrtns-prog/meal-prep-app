/**
 * Recipe data model. Every quantity the engine calculates from lives here,
 * together with where each ingredient's nutrition comes from and every
 * assumption that went into it.
 */
import type { MassUnit, VolumeUnit } from "./units.ts";
import type { Allergen } from "./allergens.ts";

/** Nutrients the engine tracks, per 100 g of food. Null = unknown. */
export interface NutrientValues {
  kcal: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fiber: number | null;
  sugars: number | null;
  sodium: number | null; // mg
  satFat: number | null;
}

export const NUTRIENT_KEYS = ["kcal", "protein", "fat", "carbs", "fiber", "sugars", "sodium", "satFat"] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];
/** Nutrients that must be known for a recipe to be calculated at all. */
export const CORE_NUTRIENTS: readonly NutrientKey[] = ["kcal", "protein", "fat", "carbs"];

/** Nutrition values copied from a product's Nutrition Facts label. */
export interface LabelFood {
  kind: "label";
  name: string;
  /** Serving size in grams, as printed on the label. */
  servingGrams: number;
  perServing: NutrientValues;
  /** Where the values came from, e.g. "Label photo, Lakanto brown, 2026-11-18". */
  source: string;
}

/** Foods the app defines itself because they have no meaningful nutrition data source. */
export type BuiltinFoodId = "water" | "zero_calorie_sweetener";

export type FoodRef =
  | { kind: "usda"; fdcId: number }
  | LabelFood
  | { kind: "builtin"; id: BuiltinFoodId };

export type Quantity =
  /** Exact mass. */
  | { kind: "mass"; amount: number; unit: MassUnit }
  /** Volume, converted with the food's own USDA portion weights. */
  | { kind: "volume"; amount: number; unit: VolumeUnit; portionLabel?: string }
  /** A count of a USDA portion, e.g. 2 × "large" or 1.5 × "clove". */
  | { kind: "count"; amount: number; portionLabel: string };

/** The state the quantity is measured in; must match the food record. */
export type MeasuredState = "raw" | "dry" | "cooked" | "frozen" | "as_packaged";

export type IngredientRole = "protein" | "carb" | "fat" | "vegetable" | "dairy" | "sauce" | "seasoning" | "other";

export interface IngredientLine {
  /** Stable across versions; steps reference ingredients by this ID. */
  id: string;
  name: string;
  /** Section heading from the original recipe, e.g. "Teriyaki Sauce". */
  group?: string;
  food: FoodRef;
  quantity: Quantity;
  state: MeasuredState;
  role: IngredientRole;
  optional?: boolean;
  /** Plain-language assumptions behind this line (each one is shown to the user). */
  assumptions?: string[];
  /** Set when the nutrition comes from a stand-in food, e.g. "mirin" estimated with sake. */
  substituteFor?: string;
  note?: string;
  /** How the purchased product becomes the usable raw quantity (bone removal, trimming). */
  prep?: LinePrep;
  /** How the usable quantity changes weight when cooked (for container weights only). */
  cook?: LineCook;
  /** Step numbers (1-based) that use this ingredient. Required unless optional. */
  usedInSteps?: number[];
  /** True when the app picked the steps because the recipe doesn't name this ingredient in them. */
  stepsInferred?: boolean;
  /** Overrides the package-size table for this line. */
  packageKey?: string;
}

export interface LinePrep {
  /** USDA bone-removal yield (Handbook 102) for bone-in cuts. */
  boneYieldId?: string;
  /** Percent of the purchased weight kept after trimming fat, as measured by you. */
  trimKeptPercent?: number;
}

export type LineCook =
  /** A USDA cooking or hydration yield. `match` says how closely the entry fits this ingredient. */
  | { kind: "yield"; yieldId: string; match: "exact" | "closest" }
  /** Weight assumed unchanged by cooking (sauces, vegetables, eggs); flagged as an assumption. */
  | { kind: "unchanged" }
  /** Cooked in water that's discarded or absorbed elsewhere; adds no weight to the batch. */
  | { kind: "absorbed" };

export interface RecipeStep {
  /** Original wording. `{{qty:lineId}}` and `{{name:lineId}}` placeholders render from the ingredient list. */
  text: string;
}

export interface PrintedNutrition {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface Recipe {
  id: string;
  name: string;
  portions: number;
  lines: IngredientLine[];
  steps: RecipeStep[];
  notes?: string[];
  /** What the source recipe claims per serving, for comparison only. */
  printedPerServing?: PrintedNutrition;
  /** The finished batch's weight, if you weighed it. Container weights then use this. */
  measuredCookedBatchGrams?: number;
  /** The original recipe as imported, kept unchanged for reference. */
  source?: RecipeSource;
}

export interface RecipeSource {
  kind: "paste" | "pdf" | "docx" | "text-file" | "ai";
  /** The text exactly as it was read (or pasted). */
  text: string;
  fileName?: string;
  importedAt: string;
}

export type PreferenceMode = "exclude" | "reduce" | "allow";

export interface IngredientPreference {
  /** Shown to the user, e.g. "Light garlic". */
  label: string;
  /** Whole words or phrases matched against ingredient names (case-insensitive). */
  matches: string[];
  /** Phrases that stop a match, e.g. "garlic" shouldn't match "garlic-free". */
  unless?: string[];
  mode: PreferenceMode;
  /** For "reduce": percent of the original amount to keep (50 = half). */
  keepPercent?: number;
}

/** An allergen or food you avoid that isn't one of the nine major allergens (e.g. mollusks). */
export interface CustomAllergen {
  /** Shown to the user, e.g. "Mollusks (clams, oysters, scallops)". */
  label: string;
  /** Whole words or phrases matched against ingredient names and food descriptions. */
  matches: string[];
}

export interface UserProfile {
  allergies: Allergen[];
  customAllergens?: CustomAllergen[];
  preferences: IngredientPreference[];
}
