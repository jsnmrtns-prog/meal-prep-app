/**
 * Recipe optimizer: rebalances a recipe to a macro preset by rule (no AI).
 *
 * How it works, in the order the spec asks for:
 *  1. Every ingredient is first scaled to the new number of meals, so each
 *     meal keeps the original's amount of sauce, vegetables and seasoning.
 *  2. Ingredients are sorted into levers: main proteins (plus protein-rich
 *     dairy such as cottage cheese), carbs (rice, pasta) and added fats
 *     (oils). Everything else stays as it is per meal.
 *  3. The protein lever is solved together with the carb lever so protein
 *     lands just above the minimum and calories land on target. If the carbs
 *     would leave their limits, the fats are moved to their limit and the
 *     carbs solved again; then the carbs are held at their limit and the fats
 *     solved instead.
 *  4. Amounts are rounded to kitchen-friendly sizes (whole eggs, ¼ tsp,
 *     whole grams), the remaining weighed ingredients are solved again to
 *     absorb the rounding, and the result is recalculated from scratch.
 *  5. A plan is only returned if the recalculated recipe meets every target.
 *     Otherwise the conflict is explained and fully recalculated tradeoff
 *     options are offered. A result is never adjusted to look like a success.
 *
 * Each lever keeps its ingredients in their original proportions, and each
 * lever stays within limits per meal (by default ½× to 2½× the original).
 */
import { calculateRecipe, type CalcResult } from "./calculate.ts";
import type { FoodDb } from "./fooddb.ts";
import {
  kcalRange,
  optionalRange,
  presetProblems,
  proteinRange,
  type MacroPreset,
  type TargetRange,
} from "./presets.ts";
import type { IngredientLine, Quantity, Recipe } from "./recipe.ts";
import { LEAN_SWAPS } from "./swaps.ts";

export type Lever = "protein" | "carb" | "fat";
export type LineLever = Lever | "fixed";
const LEVERS: Lever[] = ["protein", "carb", "fat"];

export interface LeverBounds {
  /** Smallest amount per meal, as a multiple of the original (0.5 = half). */
  min: number;
  /** Largest amount per meal, as a multiple of the original. */
  max: number;
}
export type Bounds = Record<Lever, LeverBounds>;
export const DEFAULT_BOUNDS: Bounds = {
  protein: { min: 0.05, max: 10 },
  carb: { min: 0.05, max: 10 },
  fat: { min: 0.05, max: 10 },
};
/** A dairy ingredient with at least this much protein per 100 kcal counts as a main protein. */
export const PROTEIN_RICH_PER_100_KCAL = 10;
/** Changes per meal outside this range are called out, and alternatives are offered. */
export const BIG_CHANGE = { below: 0.6, above: 2.0 };

type MacroKey = "kcal" | "protein" | "carbs" | "fat";
const MACROS: MacroKey[] = ["kcal", "protein", "carbs", "fat"];
type Macros = Record<MacroKey, number>;
const zero = (): Macros => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

export interface TargetResult {
  key: MacroKey;
  label: string;
  range: TargetRange;
  value: number;
  ok: boolean;
}

export interface LineChange {
  lineId: string;
  name: string;
  lever: LineLever;
  before: Quantity;
  after: Quantity;
  /** Grams per meal, original recipe. */
  beforeGramsPerMeal: number;
  /** Grams per meal, optimized recipe. */
  afterGramsPerMeal: number;
  /** afterGramsPerMeal ÷ beforeGramsPerMeal. */
  factor: number;
  /** Set when the ingredient was swapped for a leaner version. */
  swappedFrom?: string;
}

export type Relaxation =
  | { kind: "swap"; labels: string[] }
  | { kind: "carb_floor"; min: number }
  | { kind: "kcal"; kcal: number }
  | { kind: "protein"; grams: number };

export interface OptimizedPlan {
  /** The rebalanced recipe, with portions = the preset's meals. */
  recipe: Recipe;
  calc: CalcResult;
  /** The preset this plan meets (a changed copy for calorie or protein tradeoffs). */
  preset: MacroPreset;
  perMeal: Macros;
  targets: TargetResult[];
  changes: LineChange[];
  /** True when a lever moved outside BIG_CHANGE per meal. */
  bigChange: boolean;
  /** Notes for following the original instructions with the new amounts. */
  stepNotes: string[];
  /** Which levers were solved, and which were held at a limit. */
  method: string;
  relaxation?: Relaxation;
}

export interface TradeoffOption {
  title: string;
  detail: string;
  /** True when the option still meets every target of the preset you chose. */
  keepsTargets: boolean;
  plan: OptimizedPlan;
}

export type OptimizeResult =
  | { ok: true; plan: OptimizedPlan; alternatives: TradeoffOption[] }
  | { ok: false; conflicts: string[]; options: TradeoffOption[] };

// ---------- lever assignment ----------

export function leverFor(line: IngredientLine, calcLine: { grams: number; nutrients: { kcal: number | null; protein: number | null } }): LineLever {
  if (!(calcLine.grams > 0)) return "fixed";
  if (line.role === "protein") return "protein";
  if (line.role === "carb") return "carb";
  if (line.role === "fat") return "fat";
  if (line.role === "dairy") {
    const kcal = calcLine.nutrients.kcal ?? 0;
    const protein = calcLine.nutrients.protein ?? 0;
    if (kcal > 0 && (protein / kcal) * 100 >= PROTEIN_RICH_PER_100_KCAL) return "protein";
  }
  return "fixed";
}

// ---------- rounding ----------

const step = (amount: number, size: number) => Math.max(size, Math.round(amount / size) * size);

/** The kitchen-friendly increment for a quantity, in its own unit. */
export function stepSize(q: Quantity, wholeCounts = false): number {
  if (q.kind === "count") return wholeCounts || q.amount >= 10 ? 1 : 0.5;
  if (q.kind === "volume") return q.unit === "cup" ? 0.125 : q.unit === "ml" ? 1 : q.unit === "l" ? 0.01 : 0.25;
  return q.unit === "g" ? (q.amount < 10 ? 0.5 : 1) : q.unit === "kg" ? 0.005 : q.unit === "oz" ? 0.25 : 0.05;
}

/**
 * Kitchen-friendly amount in the line's own unit. Counts go to the nearest
 * half (whole numbers from 10 up, or always with `wholeCounts`, used for
 * adjusted proteins such as eggs).
 */
export function practicalQuantity(q: Quantity, wholeCounts = false): Quantity {
  if (q.amount === 0) return q;
  return { ...q, amount: step(q.amount, stepSize(q, wholeCounts)) };
}

/**
 * Rounds an adjusted ingredient to a kitchen-friendly size without leaving
 * its limits: if the nearest size falls outside, the nearest size inside is
 * used; if no size fits, the exact amount is kept.
 */
function practicalWithin(q: Quantity, baseAmount: number, b: LeverBounds): Quantity {
  const size = stepSize(q, true);
  const lo = baseAmount * b.min;
  const hi = baseAmount * b.max;
  let a = step(q.amount, size);
  if (a < lo - 1e-9) a = Math.ceil(lo / size - 1e-9) * size;
  if (a > hi + 1e-9) a = Math.floor(hi / size + 1e-9) * size;
  if (a < lo - 1e-9 || a > hi + 1e-9 || a <= 0) a = q.amount;
  return { ...q, amount: a };
}

const roundGrams = (g: number) => (g < 10 ? step(g, 0.5) : step(g, 1));

// ---------- linear model ----------

interface Model {
  fixed: Macros;
  levers: Record<Lever, Macros>;
}

interface Equation {
  key: MacroKey;
  aim: number;
}

interface Candidate {
  free: Lever[];
  hold: Partial<Record<Lever, number>>;
  label: string;
}

/**
 * Where to aim, best first. The first aims are the preset's own numbers
 * (protein just above a minimum); later ones move within the preset's
 * tolerance, which is only needed when the first aims can't be met.
 */
function aimSets(preset: MacroPreset): Equation[][] {
  const k = kcalRange(preset);
  const pr = proteinRange(preset);
  const c = optionalRange(preset.carbs);
  const f = optionalRange(preset.fat);
  const proteinAims = preset.protein.mode === "minimum" ? [pr.aim, pr.min + 0.5, pr.min + 0.2] : [pr.aim];
  const halfK = (k.max - k.aim) / 2;
  const kcalAims = [k.aim, k.aim + halfK, k.aim - halfK, k.aim + 1.8 * halfK, k.aim - 1.8 * halfK];
  const sets: Equation[][] = [];
  for (const kcal of kcalAims) {
    for (const protein of proteinAims) {
      const eqs: Equation[] = [{ key: "protein", aim: protein }];
      if (c) eqs.push({ key: "carbs", aim: c.aim });
      if (f) eqs.push({ key: "fat", aim: f.aim });
      // With both carbs and fat set, calories follow from the macros and are checked afterwards.
      if (!(c && f)) eqs.push({ key: "kcal", aim: kcal });
      sets.push(eqs);
    }
    if (c && f) break;
  }
  return sets;
}

function candidatesFor(eqCount: number, bounds: Bounds, present: Set<Lever>): Candidate[] {
  const all: Candidate[] =
    eqCount === 3
      ? [{ free: ["protein", "carb", "fat"], hold: {}, label: "protein, carbs and fats solved together" }]
      : [
          { free: ["protein", "carb"], hold: { fat: 1 }, label: "protein and carbs adjusted; fats as in the original" },
          { free: ["protein", "carb"], hold: { fat: bounds.fat.min }, label: "protein and carbs adjusted; fats at their minimum" },
          { free: ["protein", "carb"], hold: { fat: bounds.fat.max }, label: "protein and carbs adjusted; fats at their maximum" },
          { free: ["protein", "fat"], hold: { carb: bounds.carb.min }, label: "protein and fats adjusted; carbs at their minimum" },
          { free: ["protein", "fat"], hold: { carb: bounds.carb.max }, label: "protein and fats adjusted; carbs at their maximum" },
        ];
  // A lever with no ingredients can't be solved for, and holding it changes nothing.
  return all
    .filter((c) => c.free.every((l) => present.has(l)))
    .filter((c, i, arr) => {
      const heldPresent = Object.keys(c.hold).filter((l) => present.has(l as Lever));
      if (heldPresent.length > 0) return true;
      // Holding an empty lever: keep only the first candidate with this free set.
      return arr.findIndex((o) => o.free.join() === c.free.join()) === i;
    });
}

/** Solves A·x = b by Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

type Factors = Record<Lever, number>;

/** Factors for one candidate, or null if unsolvable. Factors may be out of bounds. */
function solveCandidate(model: Model, eqs: Equation[], cand: Candidate): Factors | null {
  const factors: Factors = { protein: 1, carb: 1, fat: 1, ...cand.hold };
  const rhs = eqs.map((e) => {
    let v = e.aim - model.fixed[e.key];
    for (const l of LEVERS) if (!cand.free.includes(l)) v -= factors[l] * model.levers[l][e.key];
    return v;
  });
  // Use as many equations as free levers (equationsFor puts the most important first,
  // but kcal is last; with 2 free levers and 2 equations this is exact).
  const used = eqs.slice(0, cand.free.length);
  if (used.length < cand.free.length) return null;
  const a = used.map((e) => cand.free.map((l) => model.levers[l][e.key]));
  const x = solveLinear(a, rhs.slice(0, cand.free.length));
  if (!x) return null;
  cand.free.forEach((l, i) => (factors[l] = x[i]!));
  return factors;
}

function withinBounds(f: Factors, cand: Candidate, bounds: Bounds, present: Set<Lever>): boolean {
  return cand.free.every((l) => !present.has(l) || (f[l] >= bounds[l].min - 1e-9 && f[l] <= bounds[l].max + 1e-9));
}

// ---------- building the recipe ----------

interface Prepared {
  /** Preference-applied recipe scaled to the preset's meal count (unrounded). */
  base: Recipe;
  baseCalc: CalcResult;
  original: Recipe;
  originalCalc: CalcResult;
  levers: Map<string, LineLever>;
}

function prepare(recipe: Recipe, preset: MacroPreset, db: FoodDb): Prepared {
  const originalCalc = calculateRecipe(recipe, db);
  const b = preset.meals / recipe.portions;
  const { measuredCookedBatchGrams: _measured, ...rest } = recipe;
  const base: Recipe = {
    ...rest,
    id: `${recipe.id}--${preset.id}`,
    portions: preset.meals,
    lines: recipe.lines.map((l) => ({ ...l, quantity: { ...l.quantity, amount: l.quantity.amount * b } })),
  };
  const baseCalc = calculateRecipe(base, db);
  const levers = new Map<string, LineLever>();
  base.lines.forEach((l, i) => levers.set(l.id, leverFor(l, baseCalc.lines[i]!)));
  return { base, baseCalc, original: recipe, originalCalc, levers };
}

function modelFrom(p: Prepared, isContinuous: (line: IngredientLine) => boolean, lockedCalc?: CalcResult): Model {
  const model: Model = { fixed: zero(), levers: { protein: zero(), carb: zero(), fat: zero() } };
  p.base.lines.forEach((line, i) => {
    const lever = p.levers.get(line.id)!;
    const continuous = lever !== "fixed" && isContinuous(line);
    const src = continuous ? p.baseCalc.lines[i]! : (lockedCalc ?? p.baseCalc).lines[i]!;
    const target = continuous ? model.levers[lever as Lever] : model.fixed;
    for (const k of MACROS) target[k] += (src.nutrients[k] ?? 0) / p.base.portions;
  });
  return model;
}

const isMass = (line: IngredientLine) => line.quantity.kind === "mass";

/** The recipe with lever factors applied. Locked lines come from `locked` as-is. */
function applyFactors(p: Prepared, f: Factors, locked: Recipe | null, bounds: Bounds): Recipe {
  return {
    ...p.base,
    lines: p.base.lines.map((line, i) => {
      const lever = p.levers.get(line.id)!;
      if (locked && !(lever !== "fixed" && isMass(line))) return locked.lines[i]!;
      if (lever === "fixed") return { ...line, quantity: practicalQuantity(line.quantity) };
      if (isMass(line)) {
        const grams = p.baseCalc.lines[i]!.grams * f[lever];
        return { ...line, quantity: { kind: "mass", amount: locked ? roundGrams(grams) : grams, unit: "g" } };
      }
      return { ...line, quantity: practicalWithin({ ...line.quantity, amount: line.quantity.amount * f[lever] }, line.quantity.amount, bounds[lever]) };
    }),
  };
}

function targetResults(perMeal: Macros, preset: MacroPreset): TargetResult[] {
  const rows: TargetResult[] = [];
  const add = (key: MacroKey, label: string, range: TargetRange | null) => {
    if (!range) return;
    const v = perMeal[key];
    rows.push({ key, label, range, value: v, ok: v >= range.min - 1e-9 && v <= range.max + 1e-9 });
  };
  add("kcal", "Calories", kcalRange(preset));
  add("protein", "Protein", proteinRange(preset));
  add("carbs", "Carbs", optionalRange(preset.carbs));
  add("fat", "Fat", optionalRange(preset.fat));
  return rows;
}

function perMealOf(calc: CalcResult): Macros {
  return { kcal: calc.perPortion.kcal.value, protein: calc.perPortion.protein.value, carbs: calc.perPortion.carbs.value, fat: calc.perPortion.fat.value };
}

// ---------- one attempt ----------

interface Diagnosis {
  conflicts: string[];
}

function names(p: Prepared, lever: Lever): string {
  const list = p.base.lines.filter((l) => p.levers.get(l.id) === lever).map((l) => l.name);
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

const times = (x: number) => `${Math.round(x * 100) / 100}×`;
const pctOf = (x: number) => `${Math.round(x * 100)}%`;

function diagnose(p: Prepared, preset: MacroPreset, model: Model, eqs: Equation[], bounds: Bounds, present: Set<Lever>): Diagnosis {
  const conflicts: string[] = [];
  if (!present.has("protein")) {
    conflicts.push("This recipe has no main protein ingredient the app can adjust (such as chicken, beef, eggs or cottage cheese).");
    return { conflicts };
  }
  if (!present.has("carb") && !present.has("fat") && eqs.length > 1) {
    conflicts.push("This recipe has no carb or added fat the app can adjust to reach the calorie target.");
    return { conflicts };
  }
  const k = kcalRange(preset);
  if (model.fixed.kcal > k.max) {
    conflicts.push(`The sauces, vegetables and other ingredients the app keeps as they are already come to ${Math.round(model.fixed.kcal)} kcal per meal, more than the ${preset.kcal} kcal target.`);
  }
  const cands = candidatesFor(eqs.length, bounds, present);
  const f = cands[0] ? solveCandidate(model, eqs, cands[0]) : null;
  const proteinText = preset.protein.mode === "minimum" ? `at least ${preset.protein.grams} g` : `${preset.protein.grams} g`;
  const withFat = (hold: number) => {
    const c = cands.find((x) => x.free.includes("carb") && x.hold.fat === hold);
    return (c && present.has("fat") ? solveCandidate(model, eqs, c) : null) ?? f;
  };
  if (f) {
    if (f.protein > bounds.protein.max) {
      conflicts.push(`Reaching ${proteinText} protein per meal would take ${times(f.protein)} the original ${names(p, "protein")} per meal, more than the ${times(bounds.protein.max)} limit.`);
    } else if (f.protein < bounds.protein.min) {
      conflicts.push(`The protein target would need the ${names(p, "protein")} cut below ${pctOf(bounds.protein.min)} of the original per meal.`);
    }
    const oils = present.has("fat") ? "even with the oils at their minimum" : "";
    if (present.has("carb") && f.carb < bounds.carb.min) {
      const g = withFat(bounds.fat.min)!;
      conflicts.push(
        g.carb < 0.05
          ? `With that much ${names(p, "protein")}, the other ingredients already reach ${preset.kcal} kcal, leaving almost no room for the ${names(p, "carb")}${oils ? ` (${oils})` : ""}.`
          : `With that much ${names(p, "protein")}, staying at ${preset.kcal} kcal would cut the ${names(p, "carb")} to ${pctOf(g.carb)} of the original per meal, below the ${pctOf(bounds.carb.min)} limit${oils ? `, ${oils}` : ""}.`,
      );
    } else if (present.has("carb") && f.carb > bounds.carb.max) {
      const g = withFat(bounds.fat.max)!;
      conflicts.push(`Reaching ${preset.kcal} kcal would take ${times(g.carb)} the original ${names(p, "carb")} per meal, more than the ${times(bounds.carb.max)} limit${present.has("fat") ? ", even with the oils at their maximum" : ""}.`);
    }
  }
  if (conflicts.length === 0) conflicts.push(`No combination of ${LEVERS.filter((l) => present.has(l)).map((l) => names(p, l)).join("; ")} within the limits meets every target.`);
  return { conflicts };
}

function attempt(recipe: Recipe, preset: MacroPreset, db: FoodDb, bounds: Bounds): { plan: OptimizedPlan } | { diagnosis: Diagnosis } {
  const problems = presetProblems(preset);
  if (problems.length > 0) return { diagnosis: { conflicts: problems } };
  const p = prepare(recipe, preset, db);
  const present = new Set<Lever>(LEVERS.filter((l) => p.base.lines.some((line) => p.levers.get(line.id) === l)));
  const sets = aimSets(preset);
  const model1 = modelFrom(p, () => true);

  for (const eqs of sets) for (const cand of candidatesFor(eqs.length, bounds, present)) {
    const f1 = solveCandidate(model1, eqs, cand);
    if (!f1 || !withinBounds(f1, cand, bounds, present)) continue;

    // Pass 2: lock rounded counts/volumes, re-solve the weighed lever ingredients.
    const locked = applyFactors(p, f1, null, bounds);
    const lockedCalc = calculateRecipe(locked, db);
    const model2 = modelFrom(p, isMass, lockedCalc);
    const present2 = new Set<Lever>(LEVERS.filter((l) => p.base.lines.some((line) => p.levers.get(line.id) === l && isMass(line))));
    const cand2: Candidate = { ...cand, free: cand.free.filter((l) => present2.has(l)) };
    const f2 = cand2.free.length === cand.free.length ? solveCandidate(model2, eqs, cand2) : f1;
    if (!f2 || !withinBounds(f2, cand2, bounds, present2)) continue;

    const final = applyFactors(p, f2, locked, bounds);
    const calc = calculateRecipe(final, db);
    const perMeal = perMealOf(calc);
    const targets = targetResults(perMeal, preset);
    if (!targets.every((t) => t.ok)) continue;

    const changes: LineChange[] = final.lines.map((line, i) => {
      const before = p.originalCalc.lines[i]!.grams / p.original.portions;
      const after = calc.lines[i]!.grams / final.portions;
      const orig = p.original.lines[i]!;
      const change: LineChange = {
        lineId: line.id,
        name: line.name,
        lever: p.levers.get(line.id)!,
        before: orig.quantity,
        after: line.quantity,
        beforeGramsPerMeal: before,
        afterGramsPerMeal: after,
        factor: before > 0 ? after / before : 1,
      };
      if (orig.name !== line.name) change.swappedFrom = orig.name;
      return change;
    });
    const bigChange = changes.some((c) => c.lever !== "fixed" && (c.factor < BIG_CHANGE.below || c.factor > BIG_CHANGE.above));
    const stepNotes: string[] = [];
    if (preset.meals !== recipe.portions) {
      stepNotes.push(`Divide into ${preset.meals} containers (the original recipe makes ${recipe.portions} servings).`);
    }
    for (const c of changes) if (c.swappedFrom) stepNotes.push(`Use ${c.name} wherever the steps say ${c.swappedFrom}.`);
    return { plan: { recipe: final, calc, preset, perMeal, targets, changes, bigChange, stepNotes, method: cand.label } };
  }
  return { diagnosis: diagnose(p, preset, model1, sets[0]!, bounds, present) };
}

// ---------- tradeoffs ----------

function swapRecipe(recipe: Recipe): { recipe: Recipe; labels: string[]; from: Map<string, string> } {
  const labels: string[] = [];
  const from = new Map<string, string>();
  const lines = recipe.lines.map((l) => {
    if (l.food.kind !== "usda" || l.role !== "protein") return l;
    const fdcId = l.food.fdcId;
    const swap = LEAN_SWAPS.find((s) => s.fromFdcId === fdcId);
    if (!swap) return l;
    labels.push(swap.label);
    from.set(l.id, l.name);
    const { substituteFor: _s, ...rest } = l;
    return { ...rest, name: swap.name, food: { kind: "usda" as const, fdcId: swap.toFdcId }, cook: swap.cook };
  });
  return { recipe: { ...recipe, lines }, labels, from };
}

const KCAL_SEARCH = { step: 5, range: 400 };

function tradeoffs(recipe: Recipe, preset: MacroPreset, db: FoodDb, bounds: Bounds, feasible: boolean): TradeoffOption[] {
  const out: TradeoffOption[] = [];
  const carbNames = recipe.lines.filter((l) => l.role === "carb").map((l) => l.name).join(" and ");

  // 1. Leaner version of the same protein.
  const swapped = swapRecipe(recipe);
  if (swapped.labels.length > 0) {
    const r = attempt(swapped.recipe, preset, db, bounds);
    if ("plan" in r) {
      for (const c of r.plan.changes) {
        const old = swapped.from.get(c.lineId);
        if (old) {
          c.swappedFrom = old;
          r.plan.stepNotes.push(`Use ${c.name} wherever the steps say ${old}.`);
        }
      }
      r.plan.relaxation = { kind: "swap", labels: swapped.labels };
      out.push({ title: `Use ${swapped.labels.join(" and ")}`, detail: "Meets all your targets with a leaner version of the same protein.", keepsTargets: true, plan: r.plan });
    }
  }
  if (feasible) return out;

  // 2. Less carbs than the usual limit.
  if (carbNames) {
    const floor = 0.25;
    const r = attempt(recipe, preset, db, { ...bounds, carb: { ...bounds.carb, min: floor } });
    if ("plan" in r) {
      const f = Math.min(...r.plan.changes.filter((c) => c.lever === "carb").map((c) => c.factor));
      r.plan.relaxation = { kind: "carb_floor", min: floor };
      out.push({ title: `Use less ${carbNames}`, detail: `Meets all your targets, but each meal has ${pctOf(f)} of the original ${carbNames}.`, keepsTargets: true, plan: r.plan });
    }
  }

  // 3. Nearest calorie target that works.
  for (let d = KCAL_SEARCH.step; d <= KCAL_SEARCH.range; d += KCAL_SEARCH.step) {
    const found = [preset.kcal + d, preset.kcal - d].filter((k) => k > 0).map((kcal) => {
      const p2: MacroPreset = { ...preset, kcal };
      const r = attempt(recipe, p2, db, bounds);
      return "plan" in r ? { kcal, plan: r.plan } : null;
    }).find((x) => x !== null);
    if (found) {
      found.plan.relaxation = { kind: "kcal", kcal: found.kcal };
      out.push({
        title: `Change to ${found.kcal} kcal per meal`,
        detail: `Keeps your protein ${preset.protein.mode === "minimum" ? "minimum" : "target"}; comes to ${Math.round(found.plan.perMeal.kcal)} kcal per meal (your preset: ${preset.kcal}).`,
        keepsTargets: false,
        plan: found.plan,
      });
      break;
    }
  }

  // 4. Most protein that works at your calories.
  for (let g = Math.floor(preset.protein.grams) - 1; g >= Math.ceil(preset.protein.grams / 2); g--) {
    const p2: MacroPreset = { ...preset, protein: { ...preset.protein, grams: g } };
    const r = attempt(recipe, p2, db, bounds);
    if ("plan" in r) {
      r.plan.relaxation = { kind: "protein", grams: g };
      out.push({
        title: `Lower protein to ${g} g per meal`,
        detail: `Keeps about ${preset.kcal} kcal; comes to ${Math.round(r.plan.perMeal.protein * 10) / 10} g protein per meal, below your ${preset.protein.mode === "minimum" ? "minimum" : "target"} of ${preset.protein.grams} g.`,
        keepsTargets: false,
        plan: r.plan,
      });
      break;
    }
  }
  return out;
}

/**
 * Rebalances `recipe` (with your preferences already applied) to `preset`.
 * Returns a plan only when the recalculated recipe meets every target.
 */
export function optimizeRecipe(recipe: Recipe, preset: MacroPreset, db: FoodDb, options: { bounds?: Bounds } = {}): OptimizeResult {
  const bounds = options.bounds ?? DEFAULT_BOUNDS;
  const r = attempt(recipe, preset, db, bounds);
  if ("plan" in r) {
    return { ok: true, plan: r.plan, alternatives: r.plan.bigChange ? tradeoffs(recipe, preset, db, bounds, true) : [] };
  }
  if (presetProblems(preset).length > 0) return { ok: false, conflicts: r.diagnosis.conflicts, options: [] };
  return { ok: false, conflicts: r.diagnosis.conflicts, options: tradeoffs(recipe, preset, db, bounds, false) };
}
