/**
 * Package sizes for turning purchase amounts into things on a shelf.
 *
 * The seed values are typical U.S. retail sizes, NOT verified for any store.
 * They're editable, and the app always labels them "typical size, unverified"
 * until the user confirms or changes them.
 */
import type { Quantity } from "./recipe.ts";

export type PackageRule =
  /** Sold in fixed packages; buy whole packages. */
  | { kind: "package"; label: string; size: Quantity }
  /** Sold loose by weight (meat counter, bulk); buy the exact weight. */
  | { kind: "by_weight" }
  /** Sold individually (peppers, onions); buy whole items of the given USDA portion size. */
  | { kind: "each"; portionLabel: string; label: string }
  /** Usually on hand; listed so you can check your pantry. */
  | { kind: "pantry" };

export interface PackageEntry {
  key: string;
  /** USDA foods this entry applies to. */
  fdcIds: number[];
  rule: PackageRule;
  verified: boolean;
}

const LB = 453.59237;
const OZ = 28.349523125;

export const SEED_PACKAGES: PackageEntry[] = [
  { key: "chicken-thighs", fdcIds: [2646171, 173627], rule: { kind: "by_weight" }, verified: false },
  { key: "chicken-breast", fdcIds: [2646170, 171077], rule: { kind: "by_weight" }, verified: false },
  { key: "ground-beef-1lb", fdcIds: [173110, 2514743, 2514744, 171790, 171796, 173111], rule: { kind: "package", label: "1 lb package", size: { kind: "mass", amount: 1, unit: "lb" } }, verified: false },
  { key: "white-rice-2lb", fdcIds: [168877, 169756, 2512381], rule: { kind: "package", label: "2 lb bag", size: { kind: "mass", amount: 2, unit: "lb" } }, verified: false },
  { key: "brown-rice-2lb", fdcIds: [169703, 2512380], rule: { kind: "package", label: "2 lb bag", size: { kind: "mass", amount: 2, unit: "lb" } }, verified: false },
  { key: "pasta-16oz", fdcIds: [169736, 168927, 2758998], rule: { kind: "package", label: "16 oz box", size: { kind: "mass", amount: 16, unit: "oz" } }, verified: false },
  { key: "frozen-veg-12oz", fdcIds: [170471], rule: { kind: "package", label: "12 oz bag", size: { kind: "mass", amount: 12, unit: "oz" } }, verified: false },
  { key: "eggs-dozen", fdcIds: [171287], rule: { kind: "package", label: "dozen large eggs", size: { kind: "count", amount: 12, portionLabel: "large" } }, verified: false },
  { key: "egg-whites-16oz", fdcIds: [323697, 172183, 172203], rule: { kind: "package", label: "16 oz carton", size: { kind: "mass", amount: 16, unit: "oz" } }, verified: false },
  { key: "cottage-cheese-16oz", fdcIds: [328841, 172182], rule: { kind: "package", label: "16 oz tub", size: { kind: "mass", amount: 16, unit: "oz" } }, verified: false },
  { key: "cheddar-8oz", fdcIds: [171292, 328637, 173414], rule: { kind: "package", label: "8 oz bag or block", size: { kind: "mass", amount: 8, unit: "oz" } }, verified: false },
  { key: "milk-half-gallon", fdcIds: [746772, 170872, 746778], rule: { kind: "package", label: "half gallon", size: { kind: "volume", amount: 8, unit: "cup" } }, verified: false },
  { key: "yellow-pepper-each", fdcIds: [169383], rule: { kind: "each", portionLabel: "pepper, large (3-3/4\" long, 3\" dia)", label: "large pepper" }, verified: false },
  { key: "red-pepper-each", fdcIds: [170108], rule: { kind: "each", portionLabel: "large (2-1/4 per pound, approx 3-3/4\" long, 3\" dia.)", label: "large pepper" }, verified: false },
  { key: "onion-each", fdcIds: [170000], rule: { kind: "each", portionLabel: "medium (2-1/2\" dia)", label: "medium onion" }, verified: false },
  { key: "enchilada-sauce-10oz", fdcIds: [174074], rule: { kind: "package", label: "10 oz can", size: { kind: "count", amount: 1, portionLabel: "can" } }, verified: false },
  // Packet sizes vary by brand (about 1–1.25 oz); seeded from the recipe's own "30 g (1 packet)".
  { key: "taco-seasoning-packet", fdcIds: [172243], rule: { kind: "package", label: "packet (30 g)", size: { kind: "mass", amount: 30, unit: "g" } }, verified: false },
];

export const PANTRY_ROLES = new Set(["seasoning", "fat", "sauce"]);

export { LB as GRAMS_PER_LB, OZ as GRAMS_PER_OZ };
