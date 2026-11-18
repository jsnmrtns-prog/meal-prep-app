/**
 * Applies the user's ingredient preferences to a recipe, by rule (no AI).
 * Every change is recorded so the user can see exactly what was altered.
 */
import type { IngredientLine, IngredientPreference, Recipe } from "./recipe.ts";

export interface PreferenceChange {
  lineId: string;
  ingredient: string;
  preference: string;
  action: "removed" | "reduced";
  detail: string;
  /** Removing a required (non-optional) ingredient changes the dish; the user should know. */
  needsAttention: boolean;
}

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

export function preferenceMatches(pref: IngredientPreference, ingredientName: string): boolean {
  const text = normalise(ingredientName);
  if ((pref.unless ?? []).some((u) => text.includes(normalise(u)))) return false;
  return pref.matches.some((m) => text.includes(normalise(m)));
}

export function applyPreferences(
  recipe: Recipe,
  preferences: IngredientPreference[],
): { recipe: Recipe; changes: PreferenceChange[] } {
  const changes: PreferenceChange[] = [];
  const lines: IngredientLine[] = [];

  for (const line of recipe.lines) {
    const pref = preferences.find((p) => p.mode !== "allow" && preferenceMatches(p, line.name));
    if (!pref) {
      lines.push(line);
      continue;
    }
    if (pref.mode === "exclude") {
      changes.push({
        lineId: line.id,
        ingredient: line.name,
        preference: pref.label,
        action: "removed",
        detail: line.optional ? "Optional ingredient left out" : "Required ingredient left out; flavor may change",
        needsAttention: !line.optional,
      });
      continue;
    }
    const keep = pref.keepPercent ?? 50;
    if (!(keep > 0 && keep <= 100)) throw new Error(`Invalid keepPercent ${keep} for "${pref.label}"`);
    const amount = line.quantity.amount * (keep / 100);
    lines.push({ ...line, quantity: { ...line.quantity, amount } });
    changes.push({
      lineId: line.id,
      ingredient: line.name,
      preference: pref.label,
      action: "reduced",
      detail: `Kept ${keep}%: ${line.quantity.amount} → ${amount}`,
      needsAttention: false,
    });
  }
  return { recipe: { ...recipe, lines }, changes };
}
