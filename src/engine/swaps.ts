/**
 * Leaner versions of the same food, offered as a tradeoff when a recipe can't
 * reach the protein target at its calories. Each swap is the same kind of
 * ingredient, cooked the same way, with a different USDA record. The
 * optimizer only offers a swap after recalculating the whole recipe with it.
 */
import type { LineCook } from "./recipe.ts";

export interface LeanSwap {
  fromFdcId: number;
  toFdcId: number;
  /** Ingredient name after the swap, e.g. "boneless skinless chicken breast". */
  name: string;
  /** Short label for the option, e.g. "chicken breast instead of thighs". */
  label: string;
  /** Cooking yield for the new food (container weights only). */
  cook: LineCook;
}

export const LEAN_SWAPS: LeanSwap[] = [
  {
    fromFdcId: 2646171, // Chicken, thigh, boneless, skinless, raw (Foundation)
    toFdcId: 2646170, // Chicken, breast, boneless, skinless, raw (Foundation)
    name: "boneless skinless chicken breast",
    label: "chicken breast instead of thighs",
    cook: { kind: "yield", yieldId: "cook-5060", match: "closest" },
  },
  {
    fromFdcId: 173110, // Beef, ground, 93% lean meat / 7% fat, raw
    toFdcId: 173111, // Beef, ground, 97% lean meat / 3% fat, raw
    name: "97% lean ground beef",
    label: "97% lean ground beef instead of 93%",
    cook: { kind: "yield", yieldId: "cook-23565", match: "exact" },
  },
  {
    fromFdcId: 171790, // Beef, ground, 95% lean meat / 5% fat, raw
    toFdcId: 173111,
    name: "97% lean ground beef",
    label: "97% lean ground beef instead of 95%",
    cook: { kind: "yield", yieldId: "cook-23565", match: "exact" },
  },
];
