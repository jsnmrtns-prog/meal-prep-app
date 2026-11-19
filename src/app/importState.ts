// Hands an import from one screen to the next (Import → Review → Editor).
// Kept in memory and in sessionStorage so a reload doesn't lose your work.
import type { ParsedRecipe, Recipe, RecipeSource } from "../engine/index.ts";

export interface ImportSession {
  parsed: ParsedRecipe;
  source: RecipeSource;
}

const IMPORT_KEY = "meal-prep-import";
const DRAFT_KEY = "meal-prep-draft";

function put(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private browsing); memory still works.
  }
}
function get<T>(key: string): T | null {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

let importSession: ImportSession | null = null;
let draft: Recipe | null = null;

export function setImport(s: ImportSession | null): void {
  importSession = s;
  put(IMPORT_KEY, s);
}
export function getImport(): ImportSession | null {
  return importSession ?? get<ImportSession>(IMPORT_KEY);
}

/** A recipe built from an import, waiting to open in the editor (not saved yet). */
export function setDraft(r: Recipe | null): void {
  draft = r;
  put(DRAFT_KEY, r);
}
export function takeDraft(): Recipe | null {
  const r = draft ?? get<Recipe>(DRAFT_KEY);
  draft = null;
  put(DRAFT_KEY, null);
  return r;
}
