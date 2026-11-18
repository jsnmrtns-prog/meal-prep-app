import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  BIG_CHANGE,
  DEFAULT_PRESETS,
  SEED_PACKAGES,
  applyPreferences,
  auditRecipe,
  buildShoppingList,
  calculateRecipe,
  describePreset,
  optimizeRecipe,
  portionRecipe,
  type AuditReport,
  type CalcResult,
  type FoodDb,
  type MacroPreset,
  type OptimizedPlan,
  type Portioning,
  type PreferenceChange,
  type Quantity,
  type Recipe,
  type RecipeStatus,
  type ShoppingItem,
  type ShoppingList,
  type TargetResult,
  type TradeoffOption,
  type UserProfile,
  type YieldDb,
} from "../engine/index.ts";
import { loadFoodDb, loadYields } from "./foodData.ts";
import { grams, imperial, weight } from "./format.ts";
import teriyaki from "../../tests/fixtures/recipes/teriyaki-fried-rice.json";
import taco from "../../tests/fixtures/recipes/taco-mac-and-cheese.json";
import testProfile from "../../tests/fixtures/profile.json";

/** Reference recipes used to check the math (M2). Real saved recipes arrive in M5. */
export const SAMPLE_RECIPES = [teriyaki.recipe, taco.recipe] as unknown as Recipe[];
const PROFILE = testProfile as unknown as UserProfile;

export const STATUS_TEXT: Record<RecipeStatus, { label: string; tone: "good" | "ok" | "warn" | "bad"; detail: string }> = {
  verified: { label: "Verified", tone: "good", detail: "Every check passed with no assumptions." },
  verified_with_assumptions: { label: "Verified with assumptions", tone: "ok", detail: "Every check passed; some amounts are assumed (listed below)." },
  checks_pending: { label: "Checks pending", tone: "ok", detail: "Nothing failed, but not every check has run yet." },
  estimate: { label: "Estimate", tone: "warn", detail: "Some ingredients use stand-in foods, so the totals can't be verified. Add product labels to fix this." },
  needs_review: { label: "Needs review", tone: "bad", detail: "A check failed. See the findings below." },
};

interface Engine {
  db: FoodDb;
  yields: YieldDb;
}

function useEngine(): { engine: Engine | null; error: string | null } {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([loadFoodDb(), loadYields()])
      .then(([db, yields]) => setEngine({ db, yields }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return { engine, error };
}

interface Computed {
  recipe: Recipe;
  calc: CalcResult;
  report: AuditReport;
  shopping: ShoppingList;
  portioning: Portioning;
}

function analyse(recipe: Recipe, { db, yields }: Engine, targets?: MacroPreset, calc = calculateRecipe(recipe, db)): Computed {
  const shopping = buildShoppingList(recipe, calc, db, yields, SEED_PACKAGES);
  const portioning = portionRecipe(recipe, calc, yields);
  const plan = { yields, packages: SEED_PACKAGES, shopping, portioning };
  const report = auditRecipe(recipe, calc, db, PROFILE, targets ? { plan, targets } : { plan });
  return { recipe, calc, report, shopping, portioning };
}

function prepared(recipe: Recipe): { recipe: Recipe; changes: PreferenceChange[] } {
  return applyPreferences(recipe, PROFILE.preferences);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r0 = (v: number) => Math.round(v);

/** 1.25 → "1¼", 0.5 → "½", 2 → "2", 1.3 → "1.3". */
function amountText(n: number): string {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  const glyph = [[0, ""], [0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]].find(([v]) => Math.abs(frac - (v as number)) < 1e-6);
  if (glyph) return whole === 0 && glyph[1] ? (glyph[1] as string) : `${whole}${glyph[1]}`;
  return `${r1(n)}`;
}

const UNIT_TEXT: Record<string, string> = { tsp: "tsp", tbsp: "Tbsp", cup: "cup", fl_oz: "fl oz", ml: "mL", l: "L" };

/** How the recipe states an amount, e.g. "1¼ tsp", "4 large", "3 lb 4.5 oz (1489 g)". */
function quantityText(q: Quantity, g: number): string {
  if (q.kind === "mass") return weight(g);
  if (q.kind === "volume") return `${amountText(q.amount)} ${UNIT_TEXT[q.unit] ?? q.unit}`;
  const label = q.portionLabel.replace(/\s*\(.*$/, "");
  return `${amountText(q.amount)} ${label}`;
}

export function SampleRecipeList(): ReactElement {
  return (
    <section className="section">
      <h2 className="section__title">Reference recipes (math check)</h2>
      <div className="card">
        {SAMPLE_RECIPES.map((r) => <SampleRow key={r.id} recipe={r} />)}
      </div>
      <p className="footnote">Your two recipes at their original amounts, with your preferences applied. Open one and pick a preset to scale it to your macros.</p>
    </section>
  );
}

function SampleRow({ recipe }: { recipe: Recipe }): ReactElement {
  const { engine } = useEngine();
  const data = useMemo(() => (engine ? analyse(prepared(recipe).recipe, engine) : null), [engine, recipe]);
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

function PresetPicker({ recipeId, presetId }: { recipeId: string; presetId: string | null }): ReactElement {
  const items = [{ id: null as string | null, label: "Original" }, ...DEFAULT_PRESETS.map((p) => ({ id: p.id as string | null, label: `${p.kcal} kcal` }))];
  return (
    <nav className="seg" aria-label="Scale to a preset" data-testid="preset-picker">
      {items.map((it) => (
        <a
          key={it.id ?? "original"}
          className={`seg__item${it.id === presetId ? " seg__item--active" : ""}`}
          href={`#/recipes/${recipeId}${it.id ? `/${it.id}` : ""}`}
          aria-current={it.id === presetId ? "page" : undefined}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

export function RecipeReportScreen({ id, presetId }: { id: string; presetId: string | null }): ReactElement {
  const recipe = SAMPLE_RECIPES.find((r) => r.id === id);
  const { engine, error } = useEngine();
  const [choice, setChoice] = useState(-1);
  const preset = presetId ? DEFAULT_PRESETS.find((p) => p.id === presetId) ?? null : null;
  const prep = useMemo(() => (recipe ? prepared(recipe) : null), [recipe]);
  const view = useMemo(() => {
    if (!engine || !prep) return null;
    try {
      if (!preset) return { kind: "original" as const, data: analyse(prep.recipe, engine) };
      return { kind: "scaled" as const, result: optimizeRecipe(prep.recipe, preset, engine.db) };
    } catch (e) {
      return { kind: "error" as const, message: e instanceof Error ? e.message : String(e) };
    }
  }, [engine, prep, preset]);

  if (!recipe || !prep) return <p className="lead">Recipe not found.</p>;
  if (presetId && !preset) return <p className="lead">Preset not found.</p>;
  if (error) return <p className="warning">Couldn't load the nutrition data: {error}</p>;

  const header = (
    <>
      <a className="back-link" href="#/recipes">‹ My Recipes</a>
      <h2 className="food-title">{recipe.name}</h2>
      <PresetPicker recipeId={recipe.id} presetId={presetId} />
    </>
  );
  if (!view || !engine) return <>{header}<p className="lead">Calculating…</p></>;
  if (view.kind === "error") return <>{header}<p className="warning">Couldn't calculate this recipe: {view.message}</p></>;

  if (view.kind === "original") {
    const { data } = view;
    return (
      <>
        {header}
        <p className="lead">{recipe.portions} servings · {r0(data.calc.batchGrams)} g of ingredients (raw/dry)</p>
        <StatusCard report={data.report} />
        <PerPortion calc={data.calc} printed={recipe.printedPerServing} title="Per serving" />
        <PreferenceSection changes={prep.changes} />
        <IngredientSection data={data} />
        <ShoppingSection shopping={data.shopping} />
        <ContainerSection portioning={data.portioning} />
        <AuditSection report={data.report} />
        <NotesSection notes={recipe.notes} />
      </>
    );
  }

  const result = view.result;
  const choices: TradeoffOption[] = result.ok ? result.alternatives : result.options;
  const picked = choice >= 0 ? choices[choice] : undefined;
  const plan = result.ok && !picked ? result.plan : picked?.plan;
  const pick = (i: number) => {
    setChoice(i);
    window.scrollTo(0, 0);
  };

  return (
    <>
      {header}
      <p className="lead" data-testid="preset-line">{preset!.name}: {describePreset(preset!)} · calories ±{preset!.kcalTolerancePct}%</p>
      {!result.ok && !picked && (
        <>
          <div className="status status--bad" data-testid="conflict">
            <strong>Can't meet this preset within the limits</strong>
            {result.conflicts.map((c) => <span key={c}>{c}</span>)}
          </div>
          <p className="footnote footnote--tight">The app won't show a plan that misses your targets. Each option below has been fully recalculated and checked.</p>
        </>
      )}
      {picked && (
        <div className={`status status--${picked.keepsTargets ? "ok" : "warn"}`} data-testid="picked-option">
          <strong>Option: {picked.title}</strong>
          <span>{picked.detail}</span>
          {!picked.keepsTargets && <span>This changes your preset for this recipe only.</span>}
          <button className="link-button" onClick={() => pick(-1)}>{result.ok ? "‹ Back to the main plan" : "‹ Back to all options"}</button>
        </div>
      )}
      {!plan && choices.length > 0 && <OptionsSection options={choices} onPick={pick} heading="Options" />}
      {plan && (
        <PlanView
          plan={plan}
          engine={engine}
          recipe={recipe}
          options={!picked && choices.length > 0 ? <OptionsSection options={choices} onPick={pick} heading="Other options" /> : null}
        />
      )}
      {!result.ok && choices.length === 0 && <p className="lead">No option within the app's limits works for this recipe and preset.</p>}
    </>
  );
}

function PlanView({ plan, engine, recipe, options }: { plan: OptimizedPlan; engine: Engine; recipe: Recipe; options: ReactElement | null }): ReactElement {
  const data = useMemo(() => analyse(plan.recipe, engine, plan.preset, plan.calc), [plan, engine]);
  const moved = plan.changes.filter((c) => c.lever !== "fixed");
  const big = moved.filter((c) => c.factor < BIG_CHANGE.below || c.factor > BIG_CHANGE.above);
  return (
    <>
      <StatusCard report={data.report} />
      <section className="section" data-testid="targets">
        <h3 className="section__title">Per meal vs. your targets</h3>
        <div className="card">
          {plan.targets.map((t) => <TargetRow key={t.key} t={t} />)}
          <div className="row"><span className="row__label">Carbs</span><span className="row__value">{r1(plan.perMeal.carbs)} g</span></div>
          <div className="row"><span className="row__label">Fat</span><span className="row__value">{r1(plan.perMeal.fat)} g</span></div>
        </div>
        <p className="footnote">Recalculated from USDA data after rounding to kitchen amounts, then re-checked by audit 4.</p>
      </section>
      {big.length > 0 && (
        <div className="status status--warn" data-testid="big-change">
          <strong>Big change from the original</strong>
          {big.map((c) => <span key={c.lineId}>{cap(c.name)}: {pctChange(c.factor)} per meal.</span>)}
          <span>{options ? "The options below change the dish less." : "No option that changes the dish less was found."}</span>
        </div>
      )}
      {options}
      <section className="section" data-testid="changes">
        <h3 className="section__title">What changed, per meal</h3>
        <div className="card">
          {moved.map((c) => (
            <div key={c.lineId} className="ingredient">
              <div className="ingredient__top">
                <span>{cap(c.name)}</span>
                <span className="ingredient__grams">{pctChange(c.factor)}</span>
              </div>
              <div className="ingredient__meta">
                {c.afterGramsPerMeal < 28 && c.beforeGramsPerMeal < 28
                  ? `${grams(c.beforeGramsPerMeal)} → ${grams(c.afterGramsPerMeal)}`
                  : `${imperial(c.beforeGramsPerMeal)} → ${imperial(c.afterGramsPerMeal)} (${grams(c.beforeGramsPerMeal)} → ${grams(c.afterGramsPerMeal)})`}
              </div>
              <div className="ingredient__source">{REASON[c.lever]}{c.swappedFrom ? ` · swapped from ${c.swappedFrom}` : ""}</div>
            </div>
          ))}
        </div>
        <p className="footnote">Everything else keeps its original amount per meal, rounded to kitchen sizes. How it was solved: {plan.method}.</p>
      </section>
      {plan.stepNotes.length > 0 && (
        <section className="section" data-testid="step-notes">
          <h3 className="section__title">Following the original steps</h3>
          <div className="card"><div className="empty">{plan.stepNotes.map((n) => <p key={n} className="note">{n}</p>)}</div></div>
        </section>
      )}
      <IngredientSection data={data} title={`Ingredients (${plan.recipe.portions} meals)`} />
      <ShoppingSection shopping={data.shopping} />
      <ContainerSection portioning={data.portioning} />
      <AuditSection report={data.report} />
      <NotesSection notes={recipe.notes} />
    </>
  );
}

const REASON: Record<string, string> = {
  protein: "Main protein: adjusted first, to reach your protein target",
  carb: "Carb: adjusted to land on your calories",
  fat: "Added fat: adjusted only when the carbs alone can't land on your calories",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function pctChange(f: number): string {
  const p = Math.round((f - 1) * 100);
  return p === 0 ? "same" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`;
}

function TargetRow({ t }: { t: TargetResult }): ReactElement {
  const unit = t.key === "kcal" ? "kcal" : "g";
  const v = t.key === "kcal" ? r0(t.value) : r1(t.value);
  return (
    <div className="row" data-testid={`target-${t.key}`}>
      <span className="row__label">
        {t.label}
        <span className="row__sub">Target {r1(t.range.min)}–{r1(t.range.max)} {unit}</span>
      </span>
      <span className="row__value">
        {v} {unit} <span className={`badge badge--${t.ok ? "good" : "bad"}`}>{t.ok ? "Met" : "Missed"}</span>
      </span>
    </div>
  );
}

function OptionsSection({ options, onPick, heading }: { options: TradeoffOption[]; onPick: (i: number) => void; heading: string }): ReactElement {
  return (
    <section className="section" data-testid="options">
      <h3 className="section__title">{heading}</h3>
      <div className="card">
        {options.map((o, i) => (
          <button key={o.title} className="option" onClick={() => onPick(i)}>
            <span className="option__title">{o.title}</span>
            <span className="option__detail">{o.detail}</span>
            <span className="option__meta">
              {r0(o.plan.perMeal.kcal)} kcal · P {r1(o.plan.perMeal.protein)} · C {r1(o.plan.perMeal.carbs)} · F {r1(o.plan.perMeal.fat)} per meal
              {" "}<span className={`badge badge--${o.keepsTargets ? "good" : "warn"}`}>{o.keepsTargets ? "Meets your targets" : "Changes your preset"}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function StatusCard({ report }: { report: AuditReport }): ReactElement {
  const s = STATUS_TEXT[report.status];
  return (
    <div className={`status status--${s.tone}`} data-testid="recipe-status">
      <strong>{s.label}</strong>
      <span>{s.detail}</span>
    </div>
  );
}

function PerPortion({ calc, printed, title }: { calc: CalcResult; printed: Recipe["printedPerServing"]; title: string }): ReactElement {
  const pp = calc.perPortion;
  return (
    <section className="section">
      <h3 className="section__title">{title}</h3>
      <div className="card">
        <div className="row row--head"><span className="row__label" /><span className="cols"><span>Calculated</span><span>Recipe says</span></span></div>
        <MacroRow label="Calories" unit="kcal" value={pp.kcal.value} printed={printed?.kcal} digits={0} />
        <MacroRow label="Protein" unit="g" value={pp.protein.value} printed={printed?.protein} />
        <MacroRow label="Carbs" unit="g" value={pp.carbs.value} printed={printed?.carbs} />
        <MacroRow label="Fat" unit="g" value={pp.fat.value} printed={printed?.fat} />
      </div>
      <p className="footnote">Calculated from USDA data with full precision; rounded only for display.</p>
    </section>
  );
}

function PreferenceSection({ changes }: { changes: PreferenceChange[] }): ReactElement | null {
  if (changes.length === 0) return null;
  return (
    <section className="section">
      <h3 className="section__title">Your preferences applied</h3>
      <div className="card">
        {changes.map((c) => <div key={c.lineId} className="row"><span className="row__label">{c.ingredient}</span><span className="row__value">{c.action === "removed" ? "Left out" : c.detail}</span></div>)}
      </div>
    </section>
  );
}

function IngredientSection({ data, title = "Ingredients (batch)" }: { data: Computed; title?: string }): ReactElement {
  return (
    <section className="section" data-testid="ingredients">
      <h3 className="section__title">{title}</h3>
      <div className="card">
        {data.calc.lines.map((l, i) => {
          const line = data.recipe.lines[i]!;
          return (
            <div key={l.lineId} className="ingredient">
              <div className="ingredient__top">
                <span>{l.name}</span>
                <span className="ingredient__grams">{line.quantity.kind === "mass" ? `${r1(l.grams)} g` : quantityText(line.quantity, l.grams)}</span>
              </div>
              <div className="ingredient__meta">
                {line.quantity.kind === "mass" ? `${imperial(l.grams)} · ` : `${r1(l.grams)} g · `}
                {r0(l.nutrients.kcal ?? 0)} kcal · P {r1(l.nutrients.protein ?? 0)} · C {r1(l.nutrients.carbs ?? 0)} · F {r1(l.nutrients.fat ?? 0)}
              </div>
              <div className="ingredient__source">
                {l.substituteFor ? `Stand-in: ${l.food.description} for ${l.substituteFor}` : l.food.description}
                {l.food.fdcId ? ` · ${l.food.sourceText}` : ` · ${l.food.trust === "builtin" ? "App assumption" : l.food.sourceText}`}
                {` · ${l.gramsBasis}`}
              </div>
              {l.assumptions.map((a) => <div key={a} className="ingredient__assumption">Assumed: {a}</div>)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AuditSection({ report }: { report: AuditReport }): ReactElement {
  return (
    <section className="section">
      <h3 className="section__title">Verification checks</h3>
      <div className="card">
        {report.audits.map((a) => (
          <div key={a.id} className="row" data-testid={`audit-${a.id}`}>
            <span className="row__label">{a.id}. {a.name}</span>
            <span className={`badge badge--${a.status === "pass" ? "good" : a.status === "warn" ? "ok" : a.status === "pending" ? "muted" : "bad"}`}>
              {a.status === "pass" ? "Passed" : a.status === "warn" ? "Passed, notes" : a.status === "pending" ? "Not run" : "Failed"}
            </span>
          </div>
        ))}
        {report.audits.filter((a) => a.status === "fail").flatMap((a) => a.findings.map((f) => <div key={`${a.id}-${f}`} className="ingredient__assumption finding">{a.id}: {f}</div>))}
      </div>
      <p className="footnote">USDA data releases: Foundation Foods and SR Legacy · engine {report.engineVersion}</p>
    </section>
  );
}

function NotesSection({ notes }: { notes: string[] | undefined }): ReactElement | null {
  if (!notes || notes.length === 0) return null;
  return (
    <section className="section">
      <h3 className="section__title">Notes</h3>
      <div className="card"><div className="empty">{notes.map((n) => <p key={n} className="note">{n}</p>)}</div></div>
    </section>
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

function buyText(item: ShoppingItem): string {
  const b = item.buy;
  switch (b.kind) {
    case "package":
      return `${b.count} × ${b.label}`;
    case "each":
      return `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`;
    case "by_weight":
      return `${imperial(b.grams)} by weight`;
    case "pantry":
      return `${grams(b.grams)} used`;
    case "unknown_package":
      return `at least ${imperial(b.grams)}`;
  }
}

function ShoppingSection({ shopping }: { shopping: ShoppingList }): ReactElement {
  const toBuy = shopping.items.filter((i) => i.buy.kind !== "pantry");
  const pantry = shopping.items.filter((i) => i.buy.kind === "pantry");
  const unverified = toBuy.some((i) => (i.buy.kind === "package" || i.buy.kind === "each" || i.buy.kind === "by_weight") && !i.buy.verified);
  let lastCategory = "";
  return (
    <section className="section" data-testid="shopping">
      <h3 className="section__title">Shopping list</h3>
      <div className="card">
        {toBuy.map((item) => {
          const header = item.category !== lastCategory ? <div className="list-head">{item.category}</div> : null;
          lastCategory = item.category;
          const differs = Math.abs(item.purchaseGrams - item.usableGrams) > 0.05;
          return (
            <div key={item.key}>
              {header}
              <div className="ingredient">
                <div className="ingredient__top">
                  <span>{item.name}</span>
                  <span className="ingredient__grams">{buyText(item)}</span>
                </div>
                <div className="ingredient__meta">
                  Uses {weight(item.usableGrams)}
                  {differs ? ` · buy ${weight(item.purchaseGrams)} before prep` : ""}
                  {item.buy.kind === "package" && item.buy.leftoverGrams > 0.5 ? ` · ${imperial(item.buy.leftoverGrams)} left over` : ""}
                </div>
                {item.notes.map((n) => <div key={n} className="ingredient__assumption">{n}</div>)}
              </div>
            </div>
          );
        })}
        {pantry.length > 0 && <div className="list-head">Pantry: check you have these</div>}
        {pantry.map((item) => (
          <div key={item.key} className="row">
            <span className="row__label">{item.name}</span>
            <span className="row__value">{buyText(item)}</span>
          </div>
        ))}
      </div>
      {unverified && <p className="footnote">Package sizes are typical U.S. sizes, not verified for your store. You'll be able to edit them in Settings (M5).</p>}
    </section>
  );
}

function ContainerSection({ portioning: p }: { portioning: Portioning }): ReactElement {
  return (
    <section className="section" data-testid="containers">
      <h3 className="section__title">Containers</h3>
      <div className="card">
        <div className="row"><span className="row__label">{p.measured ? "Weighed batch" : "Expected cooked batch"}</span><span className="row__value">{weight(p.measured ? p.perContainerGrams * p.portions : p.batchCookedGrams)}</span></div>
        {!p.measured && <div className="row"><span className="row__label">Likely range</span><span className="row__value">{imperial(p.batchLow)} – {imperial(p.batchHigh)}</span></div>}
        <div className="row"><span className="row__label">Per container ({p.portions})</span><span className="row__value" data-testid="per-container">{weight(p.perContainerGrams)}</span></div>
        <div className="empty">
          <p className="empty__note">Weigh the finished batch, then divide it by {p.portions} for exact containers. Cooked weights vary with pans, heat and time; nutrition per container doesn't, as long as the batch is split evenly.</p>
          {p.assumptions.length > 0 && <p className="empty__note">Assumed unchanged by cooking: {p.lines.filter((l) => l.assumed && l.basis.startsWith("Weight assumed")).map((l) => l.name).join(", ")}.</p>}
          {p.lines.filter((l) => !l.basis.startsWith("Weight assumed") && l.rawGrams > 0).map((l) => (
            <p key={l.lineId} className="empty__note">{l.name}: {grams(l.rawGrams)} → {grams(l.cookedGrams)}. {l.basis}.</p>
          ))}
        </div>
      </div>
    </section>
  );
}
