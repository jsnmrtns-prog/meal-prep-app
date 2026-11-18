// Loads the bundled USDA food database once and shares it across screens.
import { FoodDb, type FoodDbFile } from "../engine/index.ts";

let pending: Promise<FoodDb> | null = null;

export function loadFoodDb(): Promise<FoodDb> {
  pending ??= fetch("./data/fooddb.json")
    .then((res) => {
      if (!res.ok) throw new Error(`Food database download failed (${res.status})`);
      return res.json() as Promise<FoodDbFile>;
    })
    .then((file) => new FoodDb(file))
    .catch((error: unknown) => {
      pending = null; // allow a retry
      throw error;
    });
  return pending;
}
