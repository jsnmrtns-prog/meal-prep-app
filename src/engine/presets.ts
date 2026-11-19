/**
 * Macro presets: what one meal should contain, and how many meals to make.
 * Checked here for plain arithmetic conflicts before the optimizer runs.
 */

export interface MacroPreset {
  id: string;
  name: string;
  /** Calories per meal. */
  kcal: number;
  /** Allowed calorie difference, in percent of `kcal` (2 = ±2%). */
  kcalTolerancePct: number;
  /**
   * Protein per meal. "minimum": never below `grams` (the optimizer aims a
   * little above it, up to PROTEIN_MIN_HEADROOM_G over). "exact": within
   * ±tolerancePct of `grams`.
   */
  protein: { grams: number; mode: "minimum" | "exact"; tolerancePct?: number; /** With a minimum: the most allowed (default minimum + 5 g). */ max?: number };
  /** Optional floor: at least this many grams of carbs per meal (no upper target). Ignored when `carbs` is set. */
  carbsMin?: number;
  /** Optional carb target per meal, ±tolerancePct. */
  carbs?: { grams: number; tolerancePct: number };
  /** Optional fat target per meal, ±tolerancePct. */
  fat?: { grams: number; tolerancePct: number };
  /** Number of meals (containers) to make. */
  meals: number;
}

/** With a protein minimum, results stay within [minimum, minimum + this]. */
export const PROTEIN_MIN_HEADROOM_G = 5;
/** Where the optimizer aims above a protein minimum, so rounding can't dip below it. */
export const PROTEIN_MIN_AIM_G = 1;

export const DEFAULT_PRESETS: MacroPreset[] = [
  {
    id: "standard-750",
    name: "Standard Meal Prep",
    kcal: 750,
    kcalTolerancePct: 2,
    protein: { grams: 75, mode: "minimum" },
    carbsMin: 50,
    meals: 6,
  },
  {
    id: "higher-850",
    name: "Higher Calorie Meal Prep",
    kcal: 850,
    kcalTolerancePct: 2,
    protein: { grams: 75, mode: "minimum", max: 85 },
    carbsMin: 60,
    meals: 6,
  },
];

export function describePreset(p: MacroPreset): string {
  const protein = p.protein.mode === "minimum" ? (p.protein.max !== undefined ? `${p.protein.grams}–${p.protein.max} g protein` : `at least ${p.protein.grams} g protein`) : `${p.protein.grams} g protein`;
  const extra = [p.carbs ? `${p.carbs.grams} g carbs` : p.carbsMin !== undefined ? `at least ${p.carbsMin} g carbs` : null, p.fat ? `${p.fat.grams} g fat` : null].filter(Boolean).join(", ");
  return `${p.kcal} kcal · ${protein}${extra ? ` · ${extra}` : ""} · ${p.meals} meals`;
}

/** Inclusive range a value must land in, per meal. */
export interface TargetRange {
  min: number;
  max: number;
  /** Where the optimizer aims inside the range. */
  aim: number;
}

export function kcalRange(p: MacroPreset): TargetRange {
  const d = (p.kcal * p.kcalTolerancePct) / 100;
  return { min: p.kcal - d, max: p.kcal + d, aim: p.kcal };
}

export function proteinRange(p: MacroPreset): TargetRange {
  const g = p.protein.grams;
  if (p.protein.mode === "minimum") return { min: g, max: Math.max(p.protein.max ?? g + PROTEIN_MIN_HEADROOM_G, g + PROTEIN_MIN_AIM_G), aim: g + PROTEIN_MIN_AIM_G };
  const d = (g * (p.protein.tolerancePct ?? p.kcalTolerancePct)) / 100;
  return { min: g - d, max: g + d, aim: g };
}

/**
 * Carbs per meal: the preset's carb target if it has one, otherwise its carb
 * floor (anything from the floor up to all the calories counts), otherwise null.
 */
export function carbsRange(p: MacroPreset): TargetRange | null {
  if (p.carbs) return optionalRange(p.carbs);
  if (p.carbsMin === undefined || !(p.carbsMin > 0)) return null;
  return { min: p.carbsMin, max: Math.max(p.carbsMin, Math.round(kcalRange(p).max / 4)), aim: p.carbsMin + 1 };
}

export function optionalRange(t: { grams: number; tolerancePct: number } | undefined): TargetRange | null {
  if (!t) return null;
  const d = (t.grams * t.tolerancePct) / 100;
  return { min: t.grams - d, max: t.grams + d, aim: t.grams };
}

/**
 * Arithmetic conflicts in the preset itself, found before any recipe is
 * involved. Uses the 4/4/9 Atwater factors, which are approximate, so a
 * combination is only called impossible when it's off by more than the
 * tolerance plus a 5% allowance. Empty array = no conflict found.
 */
export function presetProblems(p: MacroPreset): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(p.meals) || p.meals < 1) problems.push("The number of meals must be a whole number of at least 1.");
  if (!(p.kcal > 0)) problems.push("Calories per meal must be more than 0.");
  if (!(p.kcalTolerancePct >= 0 && p.kcalTolerancePct <= 25)) problems.push("Calorie tolerance must be between 0% and 25%.");
  if (!(p.protein.grams >= 0)) problems.push("Protein can't be negative.");
  if (p.protein.mode === "minimum" && p.protein.max !== undefined && !(p.protein.max >= p.protein.grams + 1)) problems.push("The most protein must be at least 1 g more than the minimum.");
  if (p.carbsMin !== undefined && !(p.carbsMin >= 0)) problems.push("The carb minimum can't be negative.");
  for (const [name, t] of [["Carb", p.carbs], ["Fat", p.fat]] as const) {
    if (t && !(t.grams >= 0)) problems.push(`${name} target can't be negative.`);
    if (t && !(t.tolerancePct >= 0 && t.tolerancePct <= 50)) problems.push(`${name} tolerance must be between 0% and 50%.`);
  }
  if (problems.length > 0) return problems;

  const k = kcalRange(p);
  const slack = 1.05;
  const pr = proteinRange(p);
  const c = carbsRange(p);
  const f = optionalRange(p.fat);
  const leastKcal = 4 * pr.min + 4 * (c?.min ?? 0) + 9 * (f?.min ?? 0);
  if (leastKcal > k.max * slack) {
    const parts = [`${pr.min} g protein`, c ? `${c.min} g carbs` : null, f ? `${f.min} g fat` : null].filter(Boolean).join(" + ");
    problems.push(`${parts} alone is about ${Math.round(leastKcal)} kcal, more than the ${p.kcal} kcal target allows.`);
  }
  if (p.carbs && f && p.protein.mode === "exact" && c) {
    const mostKcal = 4 * pr.max + 4 * c.max + 9 * f.max;
    if (mostKcal * slack < k.min) {
      problems.push(`The protein, carb and fat targets add up to at most about ${Math.round(mostKcal)} kcal, less than the ${p.kcal} kcal target.`);
    }
  }
  return problems;
}
