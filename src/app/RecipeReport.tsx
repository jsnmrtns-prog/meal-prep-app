import { useEffect, useState, type ReactElement } from "react";
import {
  applyPreferences,
  auditRecipe,
  calculateRecipe,
  type AuditReport,
  type CalcResult,
  type PreferenceChange,
  type Recipe,
  type RecipeStatus,
  type UserProfile,
} from "../engine/index.ts";
import { loadFoodDb } from "./foodData.ts";
import teriyaki from "../../tests/fixtures/recipes/teriyaki-fried-rice.json";
import taco from "../../tests/fixtures/recipes/taco-mac-and-cheese.json";
import testProfile from "../../tests/fixtures/profile.json";

/** Reference recipes used to check the math (M2). Real saved recipes arrive in M5. */
export const SAMPLE_RECIPES = [teriyaki.recipe, taco.recipe] as unknown as Recipe[];
const PROFILE = testProfile as unknown as UserProfile;

export const STATUS_TEXT: Record<RecipeStatus, { label: string; tone: "good" | "ok" | "warn" | "bad"; detail: string }> = {
  verified: { label: "Verified", tone: "good", detail: "Every check passed with no assumptions." },
  verified_with_assumptions: { label: "Verified with assumptions", tone: "ok", detail: "Every check passed; some amounts are assumed (listed below)." },
  checks_pending: { label: "Checks pending", tone: "ok", detail: "Nothing failed, but the instruction and shopping checks arrive in milestone M3." },
  estimate: { label: "Estimate", tone: "warn", detail: "Some ingredients use stand-in foods, so the totals can't be verified. Add product labels to fix this." },
  needs_review: { label: "Needs review", tone: "bad", detail: "A check failed. See the findings below." },
};

interface Computed {
  recipe: Recipe;
  changes: PreferenceChange[];
  calc: CalcResult;
  report: AuditReport;
}

function useComputed(recipe: Recipe | undefined): { data: Computed | null; error: string | null } {
  const [data, setData] = useState<Computed | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!recipe) return;
    loadFoodDb()
      .then((db) => {
        const { recipe: adjusted, changes } = applyPreferences(recipe, PROFILE.preferences);
        const calc = calculateRecipe(adjusted, db);
        setData({ recipe: adjusted, changes, calc, report: auditRecipe(adjusted, calc, db, PROFILE) });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [recipe]);
  return { data, error };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r0 = (v: number) => Math.round(v);

export function SampleRecipeList(): ReactElement {
  return (
    <section className="section">
      <h2 className="section__title">Reference recipes (math check)</h2>
      <div className="card">
        {SAMPLE_RECIPES.map((r) => <SampleRow key={r.id} recipe={r} />)}
      </div>
      <p className="footnote">Your two recipes, calculated at their original amounts with your preferences applied. Scaling to your macros arrives in M4.</p>
    </section>
  );
}

function SampleRow({ recipe }: { recipe: Recipe }): ReactElement {
  const { data } = useComputed(recipe);
  const s = data ? STATUS_TEXT[data.report.status] : null;
  return (
    <a className="food-row" href={`#/recipes/${recipe.id}`}>
      <span className="food-row__name">{recipe.name}</span>
      <span className="food-row__meta">
        {data
          ? `${r0(data.calc.perPortion.kcal.value)} kcal · P ${r0(data.calc.perPortion.protein.value)} g · C ${r0(data.calc.perPortion.carbs.value)} g · F ${r0(data.calc.perPortion.fat.value)} g per serving · `
          : "Calculating… "}
        {s && <span className={`badge badge--${s.tone}`}>{s.label}</span>}
      </span>
    </a>
  );
}

export function RecipeReportScreen({ id }: { id: string }): ReactElement {
  const recipe = SAMPLE_RECIPES.find((r) => r.id === id);
  const { data, error } = useComputed(recipe);
  if (!recipe) return <p className="lead">Recipe not found.</p>;
  if (error) return <p className="warning">Couldn't calculate this recipe: {error}</p>;
  if (!data) return <p className="lead">Calculating…</p>;
  const { calc, report, changes } = data;
  const s = STATUS_TEXT[report.status];
  const pp = calc.perPortion;
  const printed = recipe.printedPerServing;

  return (
    <>
      <a className="back-link" href="#/recipes">‹ My Recipes</a>
      <h2 className="food-title">{recipe.name}</h2>
      <p className="lead">{recipe.portions} servings · {r0(calc.batchGrams)} g of ingredients (raw/dry)</p>
      <div className={`status status--${s.tone}`} data-testid="recipe-status">
        <strong>{s.label}</strong>
        <span>{s.detail}</span>
      </div>

      <section className="section">
        <h3 className="section__title">Per serving</h3>
        <div className="card">
          <div className="row row--head"><span className="row__label" /><span className="cols"><span>Calculated</span><span>Recipe says</span></span></div>
          <MacroRow label="Calories" unit="kcal" value={pp.kcal.value} printed={printed?.kcal} digits={0} />
          <MacroRow label="Protein" unit="g" value={pp.protein.value} printed={printed?.protein} />
          <MacroRow label="Carbs" unit="g" value={pp.carbs.value} printed={printed?.carbs} />
          <MacroRow label="Fat" unit="g" value={pp.fat.value} printed={printed?.fat} />
        </div>
        <p className="footnote">Calculated from USDA data with full precision; rounded only for display.</p>
      </section>

      {changes.length > 0 && (
        <section className="section">
          <h3 className="section__title">Your preferences applied</h3>
          <div className="card">
            {changes.map((c) => <div key={c.lineId} className="row"><span className="row__label">{c.ingredient}</span><span className="row__value">{c.action === "removed" ? "Left out" : c.detail}</span></div>)}
          </div>
        </section>
      )}

      <section className="section">
        <h3 className="section__title">Ingredients (batch)</h3>
        <div className="card">
          {calc.lines.map((l) => (
            <div key={l.lineId} className="ingredient">
              <div className="ingredient__top">
                <span>{l.name}</span>
                <span className="ingredient__grams">{r1(l.grams)} g</span>
              </div>
              <div className="ingredient__meta">
                {r0(l.nutrients.kcal ?? 0)} kcal · P {r1(l.nutrients.protein ?? 0)} · C {r1(l.nutrients.carbs ?? 0)} · F {r1(l.nutrients.fat ?? 0)}
              </div>
              <div className="ingredient__source">
                {l.substituteFor ? `Stand-in: ${l.food.description} for ${l.substituteFor}` : l.food.description}
                {l.food.fdcId ? ` · ${l.food.sourceText}` : ` · ${l.food.trust === "builtin" ? "App assumption" : l.food.sourceText}`}
                {` · ${l.gramsBasis}`}
              </div>
              {l.assumptions.map((a) => <div key={a} className="ingredient__assumption">Assumed: {a}</div>)}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h3 className="section__title">Verification checks</h3>
        <div className="card">
          {report.audits.map((a) => (
            <div key={a.id} className="row" data-testid={`audit-${a.id}`}>
              <span className="row__label">{a.id}. {a.name}</span>
              <span className={`badge badge--${a.status === "pass" ? "good" : a.status === "warn" ? "ok" : a.status === "pending" ? "muted" : "bad"}`}>
                {a.status === "pass" ? "Passed" : a.status === "warn" ? "Passed, notes" : a.status === "pending" ? "Coming in M3" : "Failed"}
              </span>
            </div>
          ))}
        </div>
        <p className="footnote">USDA data releases: Foundation Foods and SR Legacy · engine {report.engineVersion}</p>
      </section>

      {recipe.notes && recipe.notes.length > 0 && (
        <section className="section">
          <h3 className="section__title">Notes</h3>
          <div className="card"><div className="empty">{recipe.notes.map((n) => <p key={n} className="note">{n}</p>)}</div></div>
        </section>
      )}
    </>
  );
}

function MacroRow({ label, unit, value, printed, digits = 1 }: { label: string; unit: string; value: number; printed: number | undefined; digits?: number }): ReactElement {
  const shown = digits === 0 ? r0(value) : r1(value);
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className="cols">
        <span>{shown} {unit}</span>
        <span className="cols__muted">{printed === undefined ? "—" : `${printed} ${unit}`}</span>
      </span>
    </div>
  );
}
