/**
 * Read-only access to the bundled USDA food database (public/data/fooddb.json),
 * built by scripts/build-fooddb.mjs.
 *
 * All nutrient values are per 100 g, copied exactly from USDA. A nutrient USDA
 * did not report is `null` (unknown), never 0.
 */
import { GRAMS_PER_MASS_UNIT, ML_PER_VOLUME_UNIT, isMassUnit, isVolumeUnit } from "./units.ts";

export type Dataset = "foundation" | "sr_legacy";

/** Where a food's calorie value came from. */
export type EnergySource =
  | "usda_energy" // USDA nutrient 208, "Energy"
  | "atwater_specific" // USDA nutrient 958, Atwater specific factors
  | "atwater_general"; // USDA nutrient 957, Atwater general factors

export interface NutrientsPer100g {
  kcal: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fiber: number | null;
  sugars: number | null;
  sodium: number | null; // mg
  satFat: number | null;
  water: number | null;
}

export interface Portion {
  amount: number;
  /** A unit the engine converts exactly (cup, tbsp, oz...), or null for count portions ("1 large"). */
  unit: string | null;
  label: string;
  grams: number;
}

export interface Food {
  fdcId: number;
  dataset: Dataset;
  description: string;
  category: string;
  energySource: EnergySource | null;
  per100g: NutrientsPer100g;
  portions: Portion[];
  /** USDA calorie conversion factors (kcal per g of protein, fat, carbohydrate), when published. */
  calorieFactors: { protein: number; fat: number; carbs: number } | null;
  /** True when calories, protein, fat and carbs are all known, so the food can be used in recipe math. */
  usableForMacros: boolean;
}

export interface FoodDbFile {
  version: string;
  schema: number;
  citation: string;
  license: string;
  releases: { foundation: string; srLegacy: string };
  datasets: string[];
  nutrients: { key: string; unit: string }[];
  energySources: string[];
  categories: string[];
  foods: unknown[][];
}

const ENERGY_BY_NUMBER: Record<string, EnergySource> = {
  "208": "usda_energy",
  "958": "atwater_specific",
  "957": "atwater_general",
};

const NUTRIENT_KEYS: (keyof NutrientsPer100g)[] = [
  "kcal", "protein", "fat", "carbs", "fiber", "sugars", "sodium", "satFat", "water",
];

export class FoodDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoodDbError";
  }
}

export class FoodDb {
  readonly version: string;
  readonly citation: string;
  readonly releases: { foundation: string; srLegacy: string };
  private readonly byId = new Map<number, Food>();
  private readonly searchIndex: { food: Food; words: string[] }[] = [];

  constructor(file: FoodDbFile) {
    if (file.schema !== 1) throw new FoodDbError(`Unsupported food database schema ${file.schema}`);
    const keys = file.nutrients.map((n) => n.key).join(",");
    if (keys !== NUTRIENT_KEYS.join(",")) throw new FoodDbError(`Unexpected nutrient layout: ${keys}`);
    this.version = file.version;
    this.citation = file.citation;
    this.releases = file.releases;

    for (const row of file.foods) {
      const [fdcId, datasetIdx, description, categoryIdx, energyIdx, values, portions, factors] = row as [
        number, number, string, number, number, (number | null)[], [number, string | null, string, number][],
        [number, number, number] | null,
      ];
      const per100g = Object.fromEntries(NUTRIENT_KEYS.map((k, i) => [k, values[i] ?? null])) as unknown as NutrientsPer100g;
      const energyNumber = energyIdx >= 0 ? file.energySources[energyIdx] : undefined;
      const food: Food = {
        fdcId,
        dataset: datasetIdx === 0 ? "foundation" : "sr_legacy",
        description,
        category: file.categories[categoryIdx] ?? "Uncategorized",
        energySource: energyNumber ? (ENERGY_BY_NUMBER[energyNumber] ?? null) : null,
        per100g,
        portions: portions.map(([amount, unit, label, grams]) => ({ amount, unit, label, grams })),
        calorieFactors: factors ? { protein: factors[0], fat: factors[1], carbs: factors[2] } : null,
        usableForMacros:
          per100g.kcal !== null && per100g.protein !== null && per100g.fat !== null && per100g.carbs !== null,
      };
      if (this.byId.has(fdcId)) throw new FoodDbError(`Duplicate food ${fdcId}`);
      this.byId.set(fdcId, food);
      this.searchIndex.push({ food, words: words(description) });
    }
  }

  get size(): number {
    return this.byId.size;
  }

  /** Returns the food with this FoodData Central ID, or throws if it isn't in the database. */
  get(fdcId: number): Food {
    const food = this.byId.get(fdcId);
    if (!food) throw new FoodDbError(`Food ${fdcId} is not in database ${this.version}`);
    return food;
  }

  has(fdcId: number): boolean {
    return this.byId.has(fdcId);
  }

  /**
   * Finds foods whose description contains every word of the query (word prefixes count).
   * Ranking favours foods usable for recipe math, Foundation Foods, raw items, and shorter
   * descriptions. This only suggests candidates; the user confirms every match.
   */
  search(query: string, limit = 20): Food[] {
    const terms = words(query);
    if (terms.length === 0) return [];
    const scored: { food: Food; score: number }[] = [];
    for (const { food, words: w } of this.searchIndex) {
      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        const exact = w.indexOf(term);
        if (exact === 0) score += 6;
        else if (exact > 0) score += 4;
        else if (w.some((x) => x.startsWith(term))) score += 2;
        else { matchedAll = false; break; }
      }
      if (!matchedAll) continue;
      if (food.usableForMacros) score += 3;
      if (food.dataset === "foundation") score += 1;
      if (w.includes("raw")) score += 1;
      score -= w.length * 0.05;
      scored.push({ food, score });
    }
    scored.sort((a, b) => b.score - a.score || a.food.description.length - b.food.description.length);
    return scored.slice(0, limit).map((s) => s.food);
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Calories rebuilt from protein, fat and carbs, using the food's USDA calorie
 * factors when published, otherwise 4/9/4. For comparison only: it never
 * replaces the energy value USDA reports.
 */
export function reconstructedKcal(food: Food): number | null {
  const { protein, fat, carbs } = food.per100g;
  if (protein === null || fat === null || carbs === null) return null;
  const f = food.calorieFactors ?? { protein: 4, fat: 9, carbs: 4 };
  return protein * f.protein + fat * f.fat + carbs * f.carbs;
}

export type GramsResult =
  | { ok: true; grams: number; basis: "exact_mass" | "usda_portion"; portion?: Portion }
  | { ok: false; reason: "invalid_amount" | "unsupported_unit" | "no_usda_basis" }
  | { ok: false; reason: "ambiguous"; options: Portion[] };

/** Volume portions whose gram-per-mL densities differ by more than this are treated as different. */
const DENSITY_TOLERANCE = 0.01;

/**
 * Grams for an amount of a food in a unit.
 *
 * - Mass units (g, kg, oz, lb) convert exactly.
 * - Volume units (cup, tbsp, tsp, fl oz, mL, L) need the food's own USDA portion
 *   weights. If USDA lists portions with different densities (for example
 *   "1 cup, chopped" and "1 cup, sliced"), the result is `ambiguous` with the
 *   options, so the user chooses: the engine never picks one silently. Pass
 *   `portionLabel` to use a specific portion.
 * - Count units ("1 large") aren't handled here; use a portion directly.
 */
export function gramsForAmount(food: Food, amount: number, unit: string, portionLabel?: string): GramsResult {
  if (!(amount >= 0) || !Number.isFinite(amount)) return { ok: false, reason: "invalid_amount" };
  if (isMassUnit(unit)) return { ok: true, grams: amount * GRAMS_PER_MASS_UNIT[unit], basis: "exact_mass" };
  if (!isVolumeUnit(unit)) return { ok: false, reason: "unsupported_unit" };

  const volumePortions = food.portions.filter(
    (p): p is Portion & { unit: keyof typeof ML_PER_VOLUME_UNIT } =>
      p.unit !== null && isVolumeUnit(p.unit) && p.amount > 0 && p.grams > 0,
  );
  const named = portionLabel === undefined ? volumePortions : volumePortions.filter((p) => p.label === portionLabel);
  if (named.length === 0) return { ok: false, reason: "no_usda_basis" };

  // USDA's own weight for the exact unit wins; only fall back to converting
  // through another volume unit when the food has no portion in this unit.
  const sameUnit = named.filter((p) => p.unit === unit);
  const candidates = sameUnit.length > 0 ? sameUnit : named;

  const density = (p: (typeof candidates)[number]) => p.grams / (p.amount * ML_PER_VOLUME_UNIT[p.unit]);
  const first = candidates[0]!;
  const d0 = density(first);
  const distinct = candidates.some((p) => Math.abs(density(p) - d0) / d0 > DENSITY_TOLERANCE);
  if (distinct) return { ok: false, reason: "ambiguous", options: candidates };

  const grams = first.unit === unit
    ? (amount / first.amount) * first.grams
    : amount * ML_PER_VOLUME_UNIT[unit] * density(first);
  return { ok: true, grams, basis: "usda_portion", portion: first };
}
