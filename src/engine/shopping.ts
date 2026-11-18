/**
 * Purchase amounts, single-recipe shopping list and cooked-weight portioning.
 *
 *   usable raw grams (from the nutrition calculation)
 *     ÷ bone yield (bone-in cuts) ÷ trim kept (your measured trimming)
 *     = grams to purchase
 *   → whole packages / whole items / exact weight / pantry check
 *
 * Nutrition always uses the usable grams; the package you buy may be bigger.
 */
import type { CalcResult } from "./calculate.ts";
import type { FoodDb } from "./fooddb.ts";
import type { PackageEntry } from "./packages.ts";
import { PANTRY_ROLES } from "./packages.ts";
import type { IngredientLine, Quantity, Recipe } from "./recipe.ts";
import type { YieldDb, YieldEntry } from "./yields.ts";

export type ShoppingCategory =
  | "Meat & seafood" | "Produce" | "Dairy & eggs" | "Grains & pasta" | "Frozen"
  | "Sauces & condiments" | "Spices & seasonings" | "Oils" | "Other";

export interface PurchasePlanLine {
  lineId: string;
  name: string;
  usableGrams: number;
  /** Percent of purchased weight that's usable (100 when nothing is removed). */
  usablePercent: number;
  purchaseGrams: number;
  /** Plain-language steps from purchase to usable, e.g. "Bone removed: 88% usable (USDA AH-102)". */
  basis: string[];
  assumptions: string[];
}

export interface ShoppingItem {
  key: string;
  name: string;
  category: ShoppingCategory;
  lineIds: string[];
  usableGrams: number;
  purchaseGrams: number;
  buy:
    | { kind: "package"; label: string; packageGrams: number; count: number; totalGrams: number; leftoverGrams: number; verified: boolean }
    | { kind: "by_weight"; grams: number; verified: boolean }
    | { kind: "each"; label: string; count: number; eachGrams: number; verified: boolean }
    | { kind: "pantry"; grams: number }
    | { kind: "unknown_package"; grams: number };
  notes: string[];
}

export interface ShoppingList {
  recipeId: string;
  items: ShoppingItem[];
  purchase: PurchasePlanLine[];
}

const CATEGORY_BY_USDA: Record<string, ShoppingCategory> = {
  "Poultry Products": "Meat & seafood", "Beef Products": "Meat & seafood", "Pork Products": "Meat & seafood",
  "Finfish and Shellfish Products": "Meat & seafood", "Lamb, Veal, and Game Products": "Meat & seafood",
  "Sausages and Luncheon Meats": "Meat & seafood",
  "Vegetables and Vegetable Products": "Produce", "Fruits and Fruit Juices": "Produce",
  "Dairy and Egg Products": "Dairy & eggs",
  "Cereal Grains and Pasta": "Grains & pasta", "Baked Products": "Grains & pasta",
  "Soups, Sauces, and Gravies": "Sauces & condiments", "Beverages": "Sauces & condiments",
  "Spices and Herbs": "Spices & seasonings", "Fats and Oils": "Oils",
  "Legumes and Legume Products": "Other", "Sweets": "Other", "Nut and Seed Products": "Other",
};

function categoryFor(line: IngredientLine, db: FoodDb): ShoppingCategory {
  if (line.state === "frozen") return "Frozen";
  if (line.food.kind !== "usda") return line.role === "seasoning" ? "Spices & seasonings" : "Other";
  const food = db.get(line.food.fdcId);
  if (/\bfrozen\b/i.test(food.description) && food.category !== "Dairy and Egg Products") return "Frozen";
  return CATEGORY_BY_USDA[food.category] ?? (line.role === "seasoning" ? "Spices & seasonings" : "Other");
}

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

export function purchasePlanLine(line: IngredientLine, usableGrams: number, yields: YieldDb): PurchasePlanLine {
  let usablePercent = 100;
  const basis: string[] = [];
  const assumptions: string[] = [];
  if (line.prep?.boneYieldId) {
    const y = yields.get(line.prep.boneYieldId);
    if (y.kind !== "bone") throw new Error(`${y.id} is not a bone-removal yield`);
    usablePercent = (usablePercent * y.percent) / 100;
    basis.push(`Bone removed: ${pct(y.percent)} usable (${y.description}; USDA ${y.ref}${y.min !== null ? `, range ${y.min}–${y.max}%` : ""})`);
  }
  if (line.prep?.trimKeptPercent !== undefined) {
    const t = line.prep.trimKeptPercent;
    if (!(t > 0 && t <= 100)) throw new Error(`"${line.name}": trim kept must be between 0 and 100%`);
    usablePercent = (usablePercent * t) / 100;
    basis.push(`Fat trimmed: ${pct(t)} kept (your measurement)`);
  }
  return {
    lineId: line.id,
    name: line.name,
    usableGrams,
    usablePercent,
    purchaseGrams: (usableGrams * 100) / usablePercent,
    basis,
    assumptions,
  };
}

/** Grams in one package or item, using the food's own USDA portions for counts and volumes. */
export function quantityGrams(q: Quantity, line: IngredientLine, db: FoodDb): number {
  if (q.kind === "mass") return q.amount * ({ g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } as const)[q.unit];
  if (line.food.kind !== "usda") throw new Error(`"${line.name}": package size needs a weight`);
  const food = db.get(line.food.fdcId);
  if (q.kind === "count") {
    const p = food.portions.find((x) => x.label === q.portionLabel);
    if (!p) throw new Error(`"${line.name}": USDA portion "${q.portionLabel}" not found`);
    return (q.amount * p.grams) / p.amount;
  }
  const p = food.portions.find((x) => x.unit === q.unit);
  if (!p) throw new Error(`"${line.name}": USDA has no ${q.unit} weight for this food`);
  return (q.amount * p.grams) / p.amount;
}

function packageFor(line: IngredientLine, packages: PackageEntry[]): PackageEntry | undefined {
  if (line.packageKey) return packages.find((p) => p.key === line.packageKey);
  if (line.food.kind === "usda") {
    const id = line.food.fdcId;
    return packages.find((p) => p.fdcIds.includes(id));
  }
  return undefined;
}

/** Whole packages needed; a tiny tolerance stops 2.0000000001 becoming 3. */
export function packagesNeeded(purchaseGrams: number, packageGrams: number): number {
  return Math.max(1, Math.ceil(purchaseGrams / packageGrams - 1e-9));
}

export function buildShoppingList(
  recipe: Recipe,
  calc: CalcResult,
  db: FoodDb,
  yields: YieldDb,
  packages: PackageEntry[],
): ShoppingList {
  const purchase: PurchasePlanLine[] = [];
  const groups = new Map<string, { lines: IngredientLine[]; plans: PurchasePlanLine[] }>();

  recipe.lines.forEach((line, i) => {
    const calcLine = calc.lines[i];
    if (!calcLine || calcLine.lineId !== line.id) throw new Error("Calculation doesn't match the recipe");
    if (line.food.kind === "builtin" && line.food.id === "water") return; // tap water isn't shopped for
    const plan = purchasePlanLine(line, calcLine.grams, yields);
    purchase.push(plan);
    // Lines for the same food with the same package rule become one shopping item.
    const pkg = packageFor(line, packages);
    const key = line.food.kind === "usda" ? `usda-${line.food.fdcId}-${pkg?.key ?? "none"}` : `line-${line.id}`;
    const g = groups.get(key) ?? { lines: [], plans: [] };
    g.lines.push(line);
    g.plans.push(plan);
    groups.set(key, g);
  });

  const items: ShoppingItem[] = [];
  for (const [key, { lines, plans }] of groups) {
    const first = lines[0]!;
    const usableGrams = plans.reduce((s, p) => s + p.usableGrams, 0);
    const purchaseGrams = plans.reduce((s, p) => s + p.purchaseGrams, 0);
    const pkg = packageFor(first, packages);
    const notes: string[] = [];
    let buy: ShoppingItem["buy"];
    if (pkg && pkg.rule.kind === "package") {
      const size = quantityGrams(pkg.rule.size, first, db);
      const count = packagesNeeded(purchaseGrams, size);
      buy = { kind: "package", label: pkg.rule.label, packageGrams: size, count, totalGrams: count * size, leftoverGrams: count * size - purchaseGrams, verified: pkg.verified };
      const overflow = purchaseGrams - (count - 1) * size;
      if (count > 1 && overflow < size * 0.02) {
        notes.push(`Only ${Math.round(overflow * 10) / 10} g more than ${count - 1} package${count > 2 ? "s" : ""}: check whether the recipe amount was rounded.`);
      }
    } else if (pkg && pkg.rule.kind === "by_weight") {
      buy = { kind: "by_weight", grams: purchaseGrams, verified: pkg.verified };
    } else if (pkg && pkg.rule.kind === "each") {
      const each = quantityGrams({ kind: "count", amount: 1, portionLabel: pkg.rule.portionLabel }, first, db);
      buy = { kind: "each", label: pkg.rule.label, count: packagesNeeded(purchaseGrams, each), eachGrams: each, verified: pkg.verified };
    } else if (pkg?.rule.kind === "pantry" || lines.every((l) => PANTRY_ROLES.has(l.role))) {
      buy = { kind: "pantry", grams: purchaseGrams };
    } else {
      buy = { kind: "unknown_package", grams: purchaseGrams };
      notes.push("Package size not set: buy at least this amount.");
    }
    if (lines.some((l) => l.substituteFor)) notes.push(`Buy the real ${lines.find((l) => l.substituteFor)!.substituteFor}; nutrition is estimated with a stand-in.`);
    items.push({
      key,
      name: lines.length > 1 ? shortestName(lines) : first.name,
      category: categoryFor(first, db),
      lineIds: lines.map((l) => l.id),
      usableGrams,
      purchaseGrams,
      buy,
      notes,
    });
  }
  const order: ShoppingCategory[] = ["Meat & seafood", "Produce", "Dairy & eggs", "Frozen", "Grains & pasta", "Sauces & condiments", "Oils", "Spices & seasonings", "Other"];
  items.sort((a, b) => (a.buy.kind === "pantry" ? 1 : 0) - (b.buy.kind === "pantry" ? 1 : 0) || order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name));
  return { recipeId: recipe.id, items, purchase };
}

function shortestName(lines: IngredientLine[]): string {
  return lines.map((l) => l.name.replace(/\s*\(.*\)\s*$/, "")).sort((a, b) => a.length - b.length)[0]!;
}

// ---------- cooked weight and portioning ----------
export interface CookedLine {
  lineId: string;
  name: string;
  rawGrams: number;
  cookedGrams: number;
  low: number;
  high: number;
  basis: string;
  assumed: boolean;
}

export interface Portioning {
  lines: CookedLine[];
  batchCookedGrams: number;
  batchLow: number;
  batchHigh: number;
  portions: number;
  perContainerGrams: number;
  /** True when you weighed the finished batch; containers use that weight. */
  measured: boolean;
  assumptions: string[];
}

export function cookedLine(line: IngredientLine, rawGrams: number, yields: YieldDb): CookedLine {
  const cook = line.cook;
  if (!cook || cook.kind === "unchanged") {
    return { lineId: line.id, name: line.name, rawGrams, cookedGrams: rawGrams, low: rawGrams, high: rawGrams, basis: "Weight assumed unchanged by cooking", assumed: true };
  }
  if (cook.kind === "absorbed") {
    return { lineId: line.id, name: line.name, rawGrams, cookedGrams: 0, low: 0, high: 0, basis: "Absorbed or evaporated; counted in other ingredients' cooked weight", assumed: false };
  }
  const y: YieldEntry = yields.get(cook.yieldId);
  if (y.kind === "bone") throw new Error(`${y.id} is a bone yield, not a cooking yield`);
  const f = y.percent / 100;
  return {
    lineId: line.id,
    name: line.name,
    rawGrams,
    cookedGrams: rawGrams * f,
    low: rawGrams * ((y.min ?? y.percent) / 100),
    high: rawGrams * ((y.max ?? y.percent) / 100),
    basis: `${y.kind === "hydration" ? "Grows" : "Cooks down"} to ${pct(y.percent)}${y.min !== null && y.max !== null ? ` (${pct(y.min)}–${pct(y.max)})` : ""}: ${y.description}, ${y.method}${cook.match === "closest" ? " (closest USDA match)" : ""}`,
    assumed: cook.match === "closest",
  };
}

export function portionRecipe(recipe: Recipe, calc: CalcResult, yields: YieldDb): Portioning {
  const lines = recipe.lines.map((line, i) => cookedLine(line, calc.lines[i]!.grams, yields));
  const batchCookedGrams = lines.reduce((s, l) => s + l.cookedGrams, 0);
  const measured = recipe.measuredCookedBatchGrams !== undefined && recipe.measuredCookedBatchGrams > 0;
  const assumptions = lines.filter((l) => l.assumed && l.rawGrams > 0).map((l) => `${l.name}: ${l.basis.toLowerCase()}`);
  const batch = measured ? recipe.measuredCookedBatchGrams! : batchCookedGrams;
  return {
    lines,
    batchCookedGrams,
    batchLow: lines.reduce((s, l) => s + l.low, 0),
    batchHigh: lines.reduce((s, l) => s + l.high, 0),
    portions: recipe.portions,
    perContainerGrams: batch / recipe.portions,
    measured,
    assumptions,
  };
}
