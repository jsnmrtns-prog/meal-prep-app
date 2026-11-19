// Your data, saved on this phone in IndexedDB (Safari's on-device database).
// Nothing leaves the phone unless you export a backup yourself.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  blankSettings,
  defaultSettings,
  duplicateSavedRecipe,
  makeBackup,
  newSavedRecipe,
  revertSavedRecipe,
  updateSavedRecipe,
  upgradeSettings,
  upgradeSavedLines,
  type Backup,
  type Recipe,
  type SavedRecipe,
  type Settings,
} from "../engine/index.ts";
import teriyaki from "../../tests/fixtures/recipes/teriyaki-fried-rice.json";
import taco from "../../tests/fixtures/recipes/taco-mac-and-cheese.json";

const DB_NAME = "meal-prep";
const DB_VERSION = 1;
const SETTINGS_KEY = "settings";

/** Your two recipes from the PDFs, added to the library on first run. */
export const REFERENCE_RECIPES = [teriyaki.recipe, taco.recipe] as unknown as Recipe[];

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("recipes")) db.createObjectStore("recipes", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open the on-device database"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Couldn't save"));
    tx.onabort = () => reject(tx.error ?? new Error("Save was cancelled"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't read"));
  });
}

async function loadEverything(): Promise<{ settings: Settings; recipes: SavedRecipe[] }> {
  // Read in one transaction, write (if needed) in another: Safari can close a
  // transaction while a promise is awaited, so nothing is written mid-read.
  const db = await openDb();
  const tx = db.transaction(["kv", "recipes"], "readonly");
  const [stored, storedRecipes] = await Promise.all([
    request(tx.objectStore("kv").get(SETTINGS_KEY)) as Promise<Settings | undefined>,
    request(tx.objectStore("recipes").getAll()) as Promise<SavedRecipe[]>,
  ]);
  db.close();
  if (!stored) {
    // First run: a blank start (the setup makes your first meal plan). "?seed=demo" in the address
    // starts with the spec's profile, two presets and the two reference recipes instead (for testing).
    const demo = typeof location !== "undefined" && new URLSearchParams(location.search).get("seed") === "demo";
    const settings = demo ? defaultSettings() : blankSettings();
    const now = new Date();
    const recipes = demo ? REFERENCE_RECIPES.map((r) => newSavedRecipe(r, "reference", now)) : [];
    await write((kv, rs) => {
      kv.put(settings, SETTINGS_KEY);
      for (const r of recipes) rs.put(r);
    });
    return { settings, recipes };
  }
  const settings = upgradeSettings(stored);
  // Saved recipes pick up the current step-linking rules (amounts and foods stay as they are).
  const recipes = storedRecipes.map((r) => {
    const up = upgradeSavedLines(r.recipe);
    return up === r.recipe ? r : { ...r, recipe: up };
  });
  const changedRecipes = recipes.filter((r, i) => r !== storedRecipes[i]);
  const settingsChanged = JSON.stringify(settings) !== JSON.stringify(stored);
  if (settingsChanged || changedRecipes.length) {
    await write((kv, rs) => {
      if (settingsChanged) kv.put(settings, SETTINGS_KEY);
      for (const r of changedRecipes) rs.put(r);
    });
  }
  return { settings: settingsChanged ? settings : stored, recipes };
}

async function write(fn: (kv: IDBObjectStore, rs: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["kv", "recipes"], "readwrite");
  fn(tx.objectStore("kv"), tx.objectStore("recipes"));
  await done(tx);
  db.close();
}

export interface UserData {
  settings: Settings;
  recipes: SavedRecipe[];
  saveSettings: (next: Settings) => Promise<void>;
  /** Creates or updates a recipe (updates keep the previous version). Returns its ID. */
  saveRecipe: (recipe: Recipe, origin?: SavedRecipe["origin"]) => Promise<string>;
  deleteRecipe: (id: string) => Promise<void>;
  duplicateRecipe: (id: string) => Promise<string>;
  revertRecipe: (id: string, versionIndex: number) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  exportBackup: () => Backup;
  /** Replaces everything with a checked backup. */
  restoreBackup: (backup: Backup) => Promise<void>;
}

const Ctx = createContext<UserData | null>(null);

export function useUserData(): UserData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUserData outside UserDataProvider");
  return v;
}

const byName = (a: SavedRecipe, b: SavedRecipe) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt);

export function UserDataProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<{ settings: Settings; recipes: SavedRecipe[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadEverything()
      .then((s) => setState({ settings: s.settings, recipes: [...s.recipes].sort(byName) }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const putRecipe = useCallback(async (r: SavedRecipe) => {
    await write((_kv, rs) => rs.put(r));
    setState((s) => (s ? { ...s, recipes: [...s.recipes.filter((x) => x.id !== r.id), r].sort(byName) } : s));
  }, []);

  const api = useMemo<UserData | null>(() => {
    if (!state) return null;
    const find = (id: string) => {
      const r = state.recipes.find((x) => x.id === id);
      if (!r) throw new Error("Recipe not found");
      return r;
    };
    return {
      settings: state.settings,
      recipes: state.recipes,
      saveSettings: async (next) => {
        await write((kv) => kv.put(next, SETTINGS_KEY));
        setState((s) => (s ? { ...s, settings: next } : s));
      },
      saveRecipe: async (recipe, origin = "manual") => {
        const existing = state.recipes.find((x) => x.id === recipe.id);
        const saved = existing ? updateSavedRecipe(existing, recipe, new Date()) : newSavedRecipe(recipe, origin, new Date());
        await putRecipe(saved);
        return saved.id;
      },
      deleteRecipe: async (id) => {
        await write((_kv, rs) => rs.delete(id));
        setState((s) => (s ? { ...s, recipes: s.recipes.filter((x) => x.id !== id) } : s));
      },
      duplicateRecipe: async (id) => {
        const copy = duplicateSavedRecipe(find(id), new Set(state.recipes.map((r) => r.id)), new Date());
        await putRecipe(copy);
        return copy.id;
      },
      revertRecipe: async (id, i) => putRecipe(revertSavedRecipe(find(id), i, new Date())),
      toggleFavorite: async (id) => {
        const r = find(id);
        await putRecipe({ ...r, favorite: !r.favorite });
      },
      exportBackup: () => makeBackup(state.settings, state.recipes, new Date()),
      restoreBackup: async (backup) => {
        const settings = upgradeSettings(backup.settings);
        await write((kv, rs) => {
          rs.clear();
          for (const r of backup.recipes) rs.put(r);
          kv.put(settings, SETTINGS_KEY);
        });
        setState({ settings, recipes: [...backup.recipes].sort(byName) });
      },
    };
  }, [state, putRecipe]);

  if (error) {
    return (
      <div className="screen">
        <p className="warning">Couldn't open your saved data on this phone: {error}. Private Browsing can block saving; try opening the app from your Home Screen.</p>
      </div>
    );
  }
  if (!api) return <div className="screen"><p className="lead">Loading your data…</p></div>;
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
