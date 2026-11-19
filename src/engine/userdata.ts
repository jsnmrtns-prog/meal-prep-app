/**
 * Everything the app saves on the phone: your settings and your recipe
 * library. Also the backup file format, and the checks a backup must pass
 * before it's restored (a damaged or hand-edited file is rejected with plain
 * reasons, never half-loaded).
 */
import { MAJOR_ALLERGENS } from "./allergens.ts";
import { DEFAULT_BOUNDS, type Bounds } from "./optimizer.ts";
import { SEED_PACKAGES, type PackageEntry } from "./packages.ts";
import { DEFAULT_PRESETS, presetProblems, type MacroPreset } from "./presets.ts";
import { NUTRIENT_KEYS, type LabelFood, type Recipe, type UserProfile } from "./recipe.ts";
import { ENGINE_VERSION } from "./version.ts";

export const USER_DATA_SCHEMA = 1;
/** Older versions kept per recipe for "revert". */
export const MAX_VERSIONS = 20;

export interface SavedLabelFood {
  id: string;
  food: LabelFood;
}

export interface Settings {
  profile: UserProfile;
  presets: MacroPreset[];
  defaultPresetId: string;
  /** Adjustment limits for the optimizer (per meal, as a multiple of the original). */
  bounds: Bounds;
  /** Package sizes, starting from the typical U.S. sizes; you can edit them and mark them checked. */
  packages: PackageEntry[];
  labelFoods: SavedLabelFood[];
  onboarded: boolean;
}

export interface RecipeVersion {
  savedAt: string;
  recipe: Recipe;
}

export interface SavedRecipe {
  id: string;
  /** The recipe as you entered it (preferences are applied when it's calculated). */
  recipe: Recipe;
  origin: "manual" | "reference" | "imported";
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
  /** Earlier versions, newest first. */
  versions: RecipeVersion[];
}

export interface Backup {
  app: "meal-prep-app";
  schema: number;
  exportedAt: string;
  engineVersion: string;
  settings: Settings;
  recipes: SavedRecipe[];
}

/** The spec's starting profile (section 20). */
export const STARTING_PROFILE: UserProfile = {
  allergies: [],
  customAllergens: [],
  preferences: [
    { label: "No peanut butter", matches: ["peanut butter"], mode: "exclude" },
    { label: "No green onions", matches: ["green onion", "green onions", "scallion", "scallions"], mode: "exclude" },
    { label: "No cilantro", matches: ["cilantro"], mode: "exclude" },
    { label: "No smoked paprika", matches: ["smoked paprika"], mode: "exclude" },
    { label: "Avoid ginger", matches: ["ginger"], mode: "exclude" },
    { label: "Avoid shallots", matches: ["shallot", "shallots"], mode: "exclude" },
    { label: "Avoid quinoa", matches: ["quinoa"], mode: "exclude" },
    { label: "Light garlic", matches: ["garlic"], mode: "reduce", keepPercent: 50 },
    { label: "Light paprika", matches: ["paprika"], unless: ["smoked paprika"], mode: "reduce", keepPercent: 50 },
    { label: "Light chili flakes", matches: ["chili flakes", "red pepper flakes", "crushed red pepper"], mode: "reduce", keepPercent: 50 },
  ],
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function defaultSettings(): Settings {
  return {
    profile: clone(STARTING_PROFILE),
    presets: clone(DEFAULT_PRESETS),
    defaultPresetId: DEFAULT_PRESETS[0]!.id,
    bounds: clone(DEFAULT_BOUNDS),
    packages: clone(SEED_PACKAGES),
    labelFoods: [],
    onboarded: false,
  };
}

/** A short random ID, e.g. "r-k3j9x2a7". */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => (b % 36).toString(36)).join("")}`;
}

/** A recipe ID made readable from its name, unique among `taken`. */
export function recipeIdFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recipe";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function newSavedRecipe(recipe: Recipe, origin: SavedRecipe["origin"], now: Date): SavedRecipe {
  const t = now.toISOString();
  return { id: recipe.id, recipe, origin, createdAt: t, updatedAt: t, favorite: false, versions: [] };
}

/** Saves a new version, keeping the previous one for "revert". Unchanged recipes aren't versioned. */
export function updateSavedRecipe(saved: SavedRecipe, recipe: Recipe, now: Date): SavedRecipe {
  if (JSON.stringify(saved.recipe) === JSON.stringify(recipe)) return saved;
  const versions = [{ savedAt: saved.updatedAt, recipe: saved.recipe }, ...saved.versions].slice(0, MAX_VERSIONS);
  return { ...saved, recipe: { ...recipe, id: saved.id }, updatedAt: now.toISOString(), versions };
}

/** Restores version `index` (0 = newest); the current recipe becomes a version itself. */
export function revertSavedRecipe(saved: SavedRecipe, index: number, now: Date): SavedRecipe {
  const v = saved.versions[index];
  if (!v) throw new Error("That version doesn't exist");
  return updateSavedRecipe(saved, v.recipe, now);
}

export function duplicateSavedRecipe(saved: SavedRecipe, taken: Set<string>, now: Date): SavedRecipe {
  const name = `${saved.recipe.name} (copy)`;
  const id = recipeIdFor(name, taken);
  return newSavedRecipe({ ...clone(saved.recipe), id, name }, "manual", now);
}

export function makeBackup(settings: Settings, recipes: SavedRecipe[], now: Date): Backup {
  return { app: "meal-prep-app", schema: USER_DATA_SCHEMA, exportedAt: now.toISOString(), engineVersion: ENGINE_VERSION, settings, recipes };
}

// ---------- validation ----------

type Errors = string[];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

const MASS_UNITS = ["g", "kg", "oz", "lb"];
const VOLUME_UNITS = ["tsp", "tbsp", "cup", "fl_oz", "ml", "l"];
const STATES = ["raw", "dry", "cooked", "frozen", "as_packaged"];
const ROLES = ["protein", "carb", "fat", "vegetable", "dairy", "sauce", "seasoning", "other"];

function checkQuantity(q: unknown, where: string, e: Errors): void {
  if (!isObj(q)) return void e.push(`${where}: missing amount`);
  if (!isNum(q.amount) || q.amount < 0) e.push(`${where}: amount must be zero or more`);
  if (q.kind === "mass") {
    if (!MASS_UNITS.includes(q.unit as string)) e.push(`${where}: unknown weight unit`);
  } else if (q.kind === "volume") {
    if (!VOLUME_UNITS.includes(q.unit as string)) e.push(`${where}: unknown volume unit`);
  } else if (q.kind === "count") {
    if (!isStr(q.portionLabel)) e.push(`${where}: count needs a USDA portion`);
  } else e.push(`${where}: unknown amount type`);
}

function checkLabelFood(f: Record<string, unknown>, where: string, e: Errors): void {
  if (!isStr(f.name) || !f.name.trim()) e.push(`${where}: label food needs a name`);
  if (!isNum(f.servingGrams) || f.servingGrams <= 0) e.push(`${where}: serving size must be more than 0 g`);
  if (!isStr(f.source)) e.push(`${where}: label food needs a source`);
  if (!isObj(f.perServing)) return void e.push(`${where}: label food needs nutrition values`);
  for (const k of NUTRIENT_KEYS) {
    const v = f.perServing[k];
    if (!(v === null || (isNum(v) && v >= 0))) e.push(`${where}: ${k} must be a number of 0 or more, or empty`);
  }
  for (const k of ["kcal", "protein", "fat", "carbs"]) if (!isNum(f.perServing[k])) e.push(`${where}: ${k} is required`);
}

export function recipeProblems(r: unknown, where = "Recipe"): string[] {
  const e: Errors = [];
  if (!isObj(r)) return [`${where}: not a recipe`];
  if (!isStr(r.id) || !r.id) e.push(`${where}: missing ID`);
  if (!isStr(r.name) || !r.name.trim()) e.push(`${where}: missing name`);
  const name = isStr(r.name) && r.name ? `"${r.name}"` : where;
  if (!Number.isInteger(r.portions) || (r.portions as number) < 1) e.push(`${name}: servings must be a whole number of at least 1`);
  if (!Array.isArray(r.steps) || !r.steps.every((s) => isObj(s) && isStr(s.text))) e.push(`${name}: steps are damaged`);
  if (r.source !== undefined) {
    const src = r.source;
    if (!isObj(src) || !["paste", "pdf", "docx", "text-file", "ai"].includes(src.kind as string) || !isStr(src.text) || !isStr(src.importedAt)) e.push(`${name}: original recipe text is damaged`);
  }
  if (!Array.isArray(r.lines)) return [...e, `${name}: ingredients are missing`];
  const ids = new Set<string>();
  r.lines.forEach((l: unknown, i: number) => {
    const w = `${name}, ingredient ${i + 1}`;
    if (!isObj(l)) return void e.push(`${w}: damaged`);
    if (!isStr(l.id) || ids.has(l.id)) e.push(`${w}: missing or repeated ID`);
    else ids.add(l.id);
    if (!isStr(l.name) || !l.name.trim()) e.push(`${w}: missing name`);
    const f = l.food;
    if (!isObj(f)) e.push(`${w}: missing food`);
    else if (f.kind === "usda") {
      if (!Number.isInteger(f.fdcId)) e.push(`${w}: bad USDA ID`);
    } else if (f.kind === "label") checkLabelFood(f, w, e);
    else if (f.kind === "builtin") {
      if (f.id !== "water" && f.id !== "zero_calorie_sweetener") e.push(`${w}: unknown built-in food`);
    } else e.push(`${w}: unknown food type`);
    checkQuantity(l.quantity, w, e);
    if (!STATES.includes(l.state as string)) e.push(`${w}: unknown state`);
    if (!ROLES.includes(l.role as string)) e.push(`${w}: unknown role`);
    if (l.usedInSteps !== undefined && !(Array.isArray(l.usedInSteps) && l.usedInSteps.every((n) => Number.isInteger(n) && n >= 1))) {
      e.push(`${w}: bad step numbers`);
    }
    if (l.assumptions !== undefined && !isStrArr(l.assumptions)) e.push(`${w}: bad assumptions`);
  });
  return e;
}

function presetIssues(p: unknown, where: string): string[] {
  if (!isObj(p) || !isStr(p.id) || !isStr(p.name) || !isObj(p.protein)) return [`${where}: damaged`];
  if (!isNum(p.kcal) || !isNum(p.kcalTolerancePct) || !isNum(p.meals) || !isNum(p.protein.grams)) return [`${where}: damaged`];
  if (p.protein.mode !== "minimum" && p.protein.mode !== "exact") return [`${where}: unknown protein mode`];
  return presetProblems(p as unknown as MacroPreset).map((x) => `${where}: ${x}`);
}

export function settingsProblems(s: unknown): string[] {
  const e: Errors = [];
  if (!isObj(s)) return ["Settings are missing"];
  const p = s.profile;
  if (!isObj(p) || !Array.isArray(p.allergies) || !Array.isArray(p.preferences)) e.push("Profile is damaged");
  else {
    for (const a of p.allergies) if (!(MAJOR_ALLERGENS as readonly string[]).includes(a as string)) e.push(`Unknown allergen "${String(a)}"`);
    if (p.customAllergens !== undefined && !(Array.isArray(p.customAllergens) && p.customAllergens.every((c) => isObj(c) && isStr(c.label) && isStrArr(c.matches)))) {
      e.push("Custom allergens are damaged");
    }
    p.preferences.forEach((x: unknown, i: number) => {
      if (!isObj(x) || !isStr(x.label) || !isStrArr(x.matches) || !["exclude", "reduce", "allow"].includes(x.mode as string)) e.push(`Preference ${i + 1} is damaged`);
      else if (x.mode === "reduce" && !(isNum(x.keepPercent) && x.keepPercent > 0 && x.keepPercent <= 100)) e.push(`Preference "${x.label}": keep percent must be 1–100`);
    });
  }
  if (!Array.isArray(s.presets) || s.presets.length === 0) e.push("At least one macro preset is needed");
  else {
    s.presets.forEach((x: unknown, i: number) => e.push(...presetIssues(x, `Preset ${i + 1}`)));
    const ids = s.presets.map((x) => (isObj(x) ? x.id : null));
    if (new Set(ids).size !== ids.length) e.push("Two presets share an ID");
    if (!ids.includes(s.defaultPresetId)) e.push("The default preset doesn't exist");
  }
  const b = s.bounds;
  if (!isObj(b)) e.push("Adjustment limits are missing");
  else {
    for (const k of ["protein", "carb", "fat"]) {
      const x = b[k];
      if (!isObj(x) || !isNum(x.min) || !isNum(x.max) || x.min <= 0 || x.max < x.min || x.max > 10) e.push(`Adjustment limits for ${k} are invalid`);
    }
  }
  if (!Array.isArray(s.packages) || !s.packages.every((x) => isObj(x) && isStr(x.key) && Array.isArray(x.fdcIds) && isObj(x.rule) && typeof x.verified === "boolean")) {
    e.push("Package sizes are damaged");
  }
  if (!Array.isArray(s.labelFoods)) e.push("Label foods are damaged");
  else s.labelFoods.forEach((x: unknown, i: number) => {
    if (!isObj(x) || !isStr(x.id) || !isObj(x.food)) e.push(`Label food ${i + 1} is damaged`);
    else checkLabelFood(x.food, `Label food ${i + 1}`, e);
  });
  if (typeof s.onboarded !== "boolean") e.push("Setup flag is damaged");
  return e;
}

export type BackupCheck = { ok: true; backup: Backup } | { ok: false; problems: string[] };

/** Checks a parsed backup file. Returns plain-language problems instead of throwing. */
export function checkBackup(data: unknown): BackupCheck {
  if (!isObj(data) || data.app !== "meal-prep-app") return { ok: false, problems: ["This isn't a Meal Prep backup file."] };
  if (!isNum(data.schema) || data.schema > USER_DATA_SCHEMA) {
    return { ok: false, problems: ["This backup was made by a newer version of the app. Update the app first."] };
  }
  const problems = settingsProblems(data.settings);
  if (!Array.isArray(data.recipes)) problems.push("Recipes are missing");
  else {
    const ids = new Set<string>();
    data.recipes.forEach((r: unknown, i: number) => {
      if (!isObj(r) || !isStr(r.id) || !isObj(r.recipe) || !Array.isArray(r.versions)) return void problems.push(`Saved recipe ${i + 1} is damaged`);
      if (ids.has(r.id)) problems.push(`Two recipes share the ID "${r.id}"`);
      ids.add(r.id);
      if (r.recipe.id !== r.id) problems.push(`Saved recipe ${i + 1}: ID doesn't match its recipe`);
      problems.push(...recipeProblems(r.recipe, `Saved recipe ${i + 1}`));
      r.versions.forEach((v: unknown, j: number) => {
        if (!isObj(v) || !isStr(v.savedAt)) problems.push(`Saved recipe ${i + 1}, version ${j + 1} is damaged`);
        else problems.push(...recipeProblems(v.recipe, `Saved recipe ${i + 1}, version ${j + 1}`));
      });
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, backup: data as unknown as Backup };
}

/**
 * Package list with any newly seeded sizes added. Your sizes and "checked"
 * marks are kept; newly linked USDA foods are added to existing entries.
 */
export function withSeedPackages(packages: PackageEntry[]): PackageEntry[] {
  const seed = new Map(SEED_PACKAGES.map((p) => [p.key, p]));
  const keys = new Set(packages.map((p) => p.key));
  const merged = packages.map((p) => {
    const s = seed.get(p.key);
    const extra = s ? s.fdcIds.filter((id) => !p.fdcIds.includes(id)) : [];
    return extra.length ? { ...p, fdcIds: [...p.fdcIds, ...extra] } : p;
  });
  return [...merged, ...clone(SEED_PACKAGES).filter((p) => !keys.has(p.key))];
}

/** The old default upper limit (2½×), replaced by 5× in version 0.7.1. */
const OLD_DEFAULT_MAX = 2.5;

/**
 * Brings saved settings up to date: adds new seed packages, and moves limits
 * still at the old ½×–2½× default to the new default. Limits you changed stay.
 */
export function upgradeSettings(s: Settings): Settings {
  const bounds = clone(s.bounds);
  for (const lever of ["protein", "carb", "fat"] as const) {
    const b = bounds[lever];
    if (b && b.min === DEFAULT_BOUNDS[lever].min && b.max === OLD_DEFAULT_MAX) b.max = DEFAULT_BOUNDS[lever].max;
  }
  return { ...s, bounds, packages: withSeedPackages(s.packages) };
}
