// Loads the bundled USDA food and yield data once and shares it across screens.
import { FoodDb, YieldDb, type FoodDbFile, type YieldsFile } from "../engine/index.ts";

let pending: Promise<FoodDb> | null = null;
let pendingYields: Promise<YieldDb> | null = null;

function loadJson<T>(path: string): Promise<T> {
  return fetch(path).then((res) => {
    if (!res.ok) throw new Error(`${path} download failed (${res.status})`);
    return res.json() as Promise<T>;
  });
}

export function loadFoodDb(): Promise<FoodDb> {
  pending ??= loadJson<FoodDbFile>("./data/fooddb.json")
    .then((file) => new FoodDb(file))
    .catch((error: unknown) => {
      pending = null; // allow a retry
      throw error;
    });
  return pending;
}

export function loadYields(): Promise<YieldDb> {
  pendingYields ??= loadJson<YieldsFile>("./data/yields.json")
    .then((file) => new YieldDb(file))
    .catch((error: unknown) => {
      pendingYields = null;
      throw error;
    });
  return pendingYields;
}
