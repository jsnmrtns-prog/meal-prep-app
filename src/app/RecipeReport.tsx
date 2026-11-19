import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { Block, Run } from "./packagePdf.ts";
import {
  BIG_CHANGE,
  applyPreferences,
  auditRecipe,
  buildShoppingList,
  calculateRecipe,
  cookingSteps,
  describePreset,
  stepsDivide,
  summarizeSaved,
  summaryDetails,
  optimizeRecipe,
  portionRecipe,
  type AuditReport,
  type IngredientLine,
  type CalcResult,
  type MacroPreset,
  type OptimizedPlan,
  type Portioning,
  type PreferenceChange,
  type Quantity,
  type Recipe,
  type RecipeStatus,
  type SavedRecipe,
  type Settings,
  type ShoppingItem,
  type ShoppingList,
  type TargetResult,
  type TradeoffOption,
} from "../engine/index.ts";
import { grams, imperial, weight } from "./format.ts";
import { shareText, useShopping } from "./ShoppingScreen.tsx";
import { useUserData } from "./store.tsx";
import { BackLink, go, useEngine, type Engine } from "./ui.tsx";

export const STATUS_TEXT: Record<RecipeStatus, { label: string; tone: "good" | "ok" | "warn" | "bad"; detail: string }> = {
  verified: { label: "Verified", tone: "good", detail: "Every check passed with no assumptions." },
  verified_with_assumptions: { label: "Verified with assumptions", tone: "ok", detail: "Every check passed; some amounts or sizes are assumed (listed below)." },
  checks_pending: { label: "Checks pending", tone: "ok", detail: "Nothing failed, but not every check has run yet." },
  estimate: { label: "Estimate", tone: "warn", detail: "Some ingredients use stand-in foods, so the totals can't be verified. Add product labels to fix this." },
  needs_review: { label: "Needs review", tone: "bad", detail: "A check failed. See the findings below." },
};

export interface Computed {
  recipe: Recipe;
  calc: CalcResult;
  report: AuditReport;
  shopping: ShoppingList;
  portioning: Portioning;
}

export function analyse(recipe: Recipe, { db, yields }: Engine, settings: Settings, targets?: MacroPreset, calc = calculateRecipe(recipe, db)): Computed {
  const shopping = buildShoppingList(recipe, calc, db, yields, settings.packages);
  const portioning = portionRecipe(recipe, calc, yields);
  const plan = { yields, packages: settings.packages, shopping, portioning };
  const report = auditRecipe(recipe, calc, db, settings.profile, targets ? { plan, targets } : { plan });
  return { recipe, calc, report, shopping, portioning };
}

export function prepared(recipe: Recipe, settings: Settings): { recipe: Recipe; changes: PreferenceChange[] } {
  return applyPreferences(recipe, settings.profile.preferences);
}

/** Status and per-serving values for a library row; null while loading or if it can't be calculated. */
export function quickSummary(recipe: Recipe, engine: Engine, settings: Settings): { status: RecipeStatus; kcal: number; protein: number; carbs: number; fat: number } | null {
  try {
    const c = analyse(prepared(recipe, settings).recipe, engine, settings);
    const pp = c.calc.perPortion;
    return { status: c.report.status, kcal: pp.kcal.value, protein: pp.protein.value, carbs: pp.carbs.value, fat: pp.fat.value };
  } catch {
    return null;
  }
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

export function RecipeLibrary(): ReactElement {
  const { recipes, settings } = useUserData();
  const { engine } = useEngine();
  return (
    <>
      <button className="primary-action" onClick={() => go("/recipes/new")}>New recipe</button>
      <section className="section" data-testid="library">
        <h2 className="section__title">Library</h2>
        <div className="card">
          {recipes.length === 0 && <div className="empty"><p>No recipes yet. Tap New recipe to add one.</p></div>}
          {recipes.map((r) => <LibraryRow key={r.id} saved={r} engine={engine} settings={settings} />)}
        </div>
        <p className="footnote">Values are per serving at the recipe's own amounts, with your preferences applied. Open a recipe and pick a preset to scale it.</p>
      </section>
    </>
  );
}

function LibraryRow({ saved, engine, settings }: { saved: SavedRecipe; engine: Engine | null; settings: Settings }): ReactElement {
  const sum = useMemo(() => (engine ? quickSummary(saved.recipe, engine, settings) : null), [engine, saved, settings]);
  const s = sum ? STATUS_TEXT[sum.status] : null;
  const dish = useMemo(() => summarizeSaved(saved.recipe).dish, [saved]);
  return (
    <a className="food-row" href={`#/recipes/${encodeURIComponent(saved.id)}`}>
      <span className="food-row__name">{saved.favorite ? "★ " : ""}{saved.recipe.name}</span>
      {dish && <span className="food-row__summary">{dish}</span>}
      <span className="food-row__meta">
        {sum
          ? `${r0(sum.kcal)} kcal · P ${r0(sum.protein)} g · C ${r0(sum.carbs)} g · F ${r0(sum.fat)} g per serving · `
          : engine ? "Can't calculate yet · " : "Calculating… "}
        {s && <span className={`badge badge--${s.tone}`}>{s.label}</span>}
        {saved.origin === "reference" && <span className="badge badge--muted">Reference</span>}
      </span>
    </a>
  );
}

/** What the recipe is, in a sentence or two, worked out from its ingredients and steps. */
function RecipeSummaryCard({ recipe }: { recipe: Recipe }): ReactElement | null {
  const sum = useMemo(() => summarizeSaved(recipe), [recipe]);
  const details = summaryDetails(sum);
  if (!sum.dish && !details && !sum.intro) return null;
  return (
    <div className="recipe-summary" data-testid="recipe-summary">
      {sum.dish && <p className="recipe-summary__dish">{sum.dish}</p>}
      {details && <p className="recipe-summary__details">{details}</p>}
      {sum.intro && <p className="recipe-summary__intro">“{sum.intro}”</p>}
    </div>
  );
}

function PresetPicker({ recipeId, presetId, presets }: { recipeId: string; presetId: string | null; presets: MacroPreset[] }): ReactElement {
  const base = `#/recipes/${encodeURIComponent(recipeId)}`;
  if (presets.length > 2) {
    return (
      <label className="field field--inline" data-testid="preset-picker">
        <span className="field__label">Scale to</span>
        <select className="input" value={presetId ?? ""} onChange={(e) => go(e.target.value ? `/recipes/${encodeURIComponent(recipeId)}/${e.target.value}` : `/recipes/${encodeURIComponent(recipeId)}`)}>
          <option value="">Original amounts</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kcal} kcal)</option>)}
        </select>
      </label>
    );
  }
  const items = [{ id: null as string | null, label: "Original" }, ...presets.map((p) => ({ id: p.id as string | null, label: `${p.kcal} kcal` }))];
  return (
    <nav className="seg" aria-label="Scale to a preset" data-testid="preset-picker">
      {items.map((it) => (
        <a
          key={it.id ?? "original"}
          className={`seg__item${it.id === presetId ? " seg__item--active" : ""}`}
          href={`${base}${it.id ? `/${it.id}` : ""}`}
          aria-current={it.id === presetId ? "page" : undefined}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

function RecipeActions({ saved }: { saved: SavedRecipe }): ReactElement {
  const { deleteRecipe, duplicateRecipe, toggleFavorite } = useUserData();
  const id = encodeURIComponent(saved.id);
  return (
    <div className="actions" data-testid="recipe-actions">
      <a className="action" href={`#/recipes/${id}/edit`}>Edit</a>
      <button className="action" onClick={() => void duplicateRecipe(saved.id).then((nid) => go(`/recipes/${encodeURIComponent(nid)}/edit`))}>Duplicate</button>
      <button className="action" onClick={() => void toggleFavorite(saved.id)}>{saved.favorite ? "★ Favorite" : "☆ Favorite"}</button>
      {saved.versions.length > 0 && <a className="action" href={`#/recipes/${id}/versions`}>Versions ({saved.versions.length})</a>}
      <button
        className="action action--danger"
        onClick={() => {
          if (window.confirm(`Delete "${saved.recipe.name}"? This can't be undone (unless you have a backup).`)) void deleteRecipe(saved.id).then(() => go("/recipes"));
        }}
      >
        Delete
      </button>
    </div>
  );
}

export function RecipeVersionsScreen({ id }: { id: string }): ReactElement {
  const { recipes, revertRecipe } = useUserData();
  const saved = recipes.find((r) => r.id === id);
  if (!saved) return <p className="lead">Recipe not found.</p>;
  return (
    <>
      <BackLink href={`#/recipes/${encodeURIComponent(id)}`}>{saved.recipe.name}</BackLink>
      <p className="lead">Earlier versions of this recipe, newest first. Restoring one keeps the current version here too.</p>
      <section className="section">
        <div className="card">
          {saved.versions.map((v, i) => (
            <div key={v.savedAt + i} className="row">
              <span className="row__label">
                {new Date(v.savedAt).toLocaleString()}
                <span className="row__sub">{v.recipe.name} · {v.recipe.portions} servings · {v.recipe.lines.length} ingredients</span>
              </span>
              <button className="small-button" onClick={() => void revertRecipe(id, i).then(() => go(`/recipes/${encodeURIComponent(id)}`))}>Restore</button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function RecipeReportScreen({ id, presetId }: { id: string; presetId: string | null }): ReactElement {
  const { recipes, settings } = useUserData();
  const saved = recipes.find((r) => r.id === id);
  const recipe = saved?.recipe;
  const { engine, error } = useEngine();
  const [choice, setChoice] = useState(-1);
  const preset = presetId ? settings.presets.find((p) => p.id === presetId) ?? null : null;
  const prep = useMemo(() => (recipe ? prepared(recipe, settings) : null), [recipe, settings]);
  const view = useMemo(() => {
    if (!engine || !prep) return null;
    try {
      if (!preset) return { kind: "original" as const, data: analyse(prep.recipe, engine, settings) };
      return { kind: "scaled" as const, result: optimizeRecipe(prep.recipe, preset, engine.db, { bounds: settings.bounds }) };
    } catch (e) {
      return { kind: "error" as const, message: e instanceof Error ? e.message : String(e) };
    }
  }, [engine, prep, preset, settings]);

  if (!saved || !recipe || !prep) return <><BackLink href="#/recipes">My Recipes</BackLink><p className="lead">Recipe not found.</p></>;
  if (presetId && !preset) return <p className="lead">Preset not found.</p>;
  if (error) return <p className="warning">Couldn't load the nutrition data: {error}</p>;

  const header = (
    <>
      <BackLink href="#/recipes">My Recipes</BackLink>
      <h2 className="food-title">{saved.favorite ? "★ " : ""}{recipe.name}</h2>
      <RecipeSummaryCard recipe={saved.recipe} />
      <RecipeActions saved={saved} />
      <PresetPicker recipeId={saved.id} presetId={presetId} presets={settings.presets} />
      <AddToList recipeId={saved.id} presetId={presetId} />
    </>
  );
  if (!view || !engine) return <>{header}<p className="lead">Calculating…</p></>;
  if (view.kind === "error") return <>{header}<p className="warning">Couldn't calculate this recipe: {view.message}</p></>;

  if (view.kind === "original") {
    const { data } = view;
    return (
      <>
        {header}
        <CookView data={data} perMeal={perPortionOf(data.calc)} notes={[]} />
        <Fold title="Shopping list" testId="shopping-fold"><ShoppingSection shopping={data.shopping} titled={false} /></Fold>
        <Fold title="Nutrition & checks" testId="details-fold">
          <p className="lead">{recipe.portions} servings · {r0(data.calc.batchGrams)} g of ingredients (raw/dry)</p>
          <StatusCard report={data.report} />
          <PerPortion calc={data.calc} printed={recipe.printedPerServing} title="Per serving" />
          <PreferenceSection changes={prep.changes} />
          <IngredientSection data={data} />
          <ContainerSection portioning={data.portioning} />
          <AuditSection report={data.report} />
        </Fold>
        <NotesSection notes={recipe.notes} />
        <SourceSection recipe={recipe} />
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
  const { settings } = useUserData();
  const data = useMemo(() => analyse(plan.recipe, engine, settings, plan.preset, plan.calc), [plan, engine, settings]);
  const moved = plan.changes.filter((c) => c.lever !== "fixed");
  const big = moved.filter((c) => c.factor < BIG_CHANGE.below || c.factor > BIG_CHANGE.above);
  return (
    <>
      {big.length > 0 && (
        <div className="status status--warn" data-testid="big-change">
          <strong>Big change from the original</strong>
          {big.map((c) => <span key={c.lineId}>{cap(c.name)}: {pctChange(c.factor)} per meal.</span>)}
          <span>{options ? "The options below change the dish less." : "No option that changes the dish less was found."}</span>
        </div>
      )}
      {options}
      <CookView data={data} perMeal={plan.perMeal} notes={plan.stepNotes.filter((n) => !/^Divide into /.test(n))} targets={plan.targets} />
      <Fold title="Shopping list" testId="shopping-fold"><ShoppingSection shopping={data.shopping} titled={false} /></Fold>
      <Fold title="Nutrition & checks" testId="details-fold">
        <StatusCard report={data.report} />
        <section className="section" data-testid="targets">
          <h3 className="section__title">Per meal vs. your targets</h3>
          <div className="card">
            {plan.targets.map((t) => <TargetRow key={t.key} t={t} />)}
            {!plan.targets.some((t) => t.key === "carbs") && <div className="row"><span className="row__label">Carbs</span><span className="row__value">{r1(plan.perMeal.carbs)} g</span></div>}
            <div className="row"><span className="row__label">Fat</span><span className="row__value">{r1(plan.perMeal.fat)} g</span></div>
          </div>
          <p className="footnote">Recalculated from USDA data after rounding to kitchen amounts, then re-checked by audit 4.</p>
        </section>
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
        <IngredientSection data={data} title={`Ingredients (${plan.recipe.portions} meals)`} />
        <ContainerSection portioning={data.portioning} />
        <AuditSection report={data.report} />
      </Fold>
      <NotesSection notes={recipe.notes} />
    </>
  );
}

function AddToList({ recipeId, presetId }: { recipeId: string; presetId: string | null }): ReactElement {
  const shop = useShopping();
  const { settings } = useUserData();
  const on = shop.has(recipeId);
  const label = (id: string | null) => (id ? `${settings.presets.find((p) => p.id === id)?.kcal ?? "?"} kcal` : "original amounts");
  if (on && on.presetId === presetId) {
    return (
      <div className="add-list add-list--on" data-testid="add-to-list">
        <span>✓ On your shopping list ({label(presetId)})</span>
        <button className="link-button" onClick={() => void shop.remove(recipeId)}>Remove</button>
      </div>
    );
  }
  return (
    <button className="secondary-action add-list" data-testid="add-to-list" onClick={() => void shop.add(recipeId, presetId)}>
      {on ? `Use ${label(presetId)} on the shopping list` : `Add to shopping list (${label(presetId)})`}
    </button>
  );
}

function Fold({ title, testId, children }: { title: string; testId: string; children: ReactNode }): ReactElement {
  return (
    <details className="more more--section fold" data-testid={testId}>
      <summary>{title}</summary>
      <div className="fold__body">{children}</div>
    </details>
  );
}

export const perPortionOf = (calc: CalcResult) => ({ kcal: calc.perPortion.kcal.value, protein: calc.perPortion.protein.value, carbs: calc.perPortion.carbs.value, fat: calc.perPortion.fat.value });

/** A count label as you'd say it: "1 lime yields" → "lime", "slice (2/3 oz)" → "slices". */
function countLabel(label: string, n: number): string {
  let l = label.replace(/\s*\(.*$/, "").replace(/^1\s+/, "").replace(/\s+yields?$/i, "").replace(/,.*$/, "").trim();
  if (n !== 1) {
    if (/^(?:slice|piece|clove|lime|lemon|orange|bun|tortilla|wrap|strip|fillet|breast|thigh|can|stalk|sprig|pepper|onion|carrot|apple|banana|avocado|egg|cucumber|zucchini|shallot|scallion|jalapeño|jalapeno|bagel|muffin|patty|link|sausage)$/i.test(l)) l = l === "patty" ? "patties" : `${l}s`;
    else if (/^(?:potato|tomato)$/i.test(l)) l += "es";
    else if (/^leaf$/i.test(l)) l = "leaves";
  }
  return l;
}

/** The amount as written into a cooking step or the ingredient list. */
function cookAmount(line: IngredientLine, g: number, inStep = false): string {
  const q = line.quantity;
  // In a step that says "cooked rice", say the amount is uncooked; the list already names it.
  const dry = inStep && /\b(?:uncooked|dry|dried)\b/i.test(line.name) && /\b(?:rice|pasta|noodles|quinoa|oats|couscous|lentils|beans)\b/i.test(line.name) ? " uncooked" : "";
  if (q.kind === "mass") return `${g >= 100 ? (inStep ? `${imperial(g)} / ${grams(g)}` : weight(g)) : grams(g)}${dry}`.replace(/\.0 oz/g, " oz");
  if (q.kind === "volume") return `${amountText(q.amount)} ${UNIT_TEXT[q.unit] ?? q.unit}`;
  return `${amountText(q.amount)} ${countLabel(q.portionLabel, q.amount)}`;
}

type PerMeal = { kcal: number; protein: number; carbs: number; fat: number };

/** The cooking view as plain text, for sharing. */
export function cookText(data: Computed, perMeal: PerMeal, notes: string[] = []): string {
  const recipe = data.recipe;
  const gramsOf = new Map(data.calc.lines.map((l) => [l.lineId, l.grams]));
  const lineOf = new Map(recipe.lines.map((l) => [l.id, l]));
  const amt = (id: string, inStep = false) => cookAmount(lineOf.get(id)!, gramsOf.get(id) ?? 0, inStep);
  const steps = cookingSteps(recipe, data.portioning.portions);
  const stepText = (st: (typeof steps)[number]) =>
    st.parts.map((p) => (p.kind === "text" ? p.text : ` (${amt(p.lineId, true)})`)).join("") + (st.also.length ? ` Also: ${st.also.map((id) => `${lineOf.get(id)!.name} (${amt(id)})`).join(", ")}.` : "");
  return [
    recipe.name,
    `Makes ${data.portioning.portions} containers, about ${weight(data.portioning.perContainerGrams)} each · ${r0(perMeal.kcal)} kcal · P ${r0(perMeal.protein)} g · C ${r0(perMeal.carbs)} g · F ${r0(perMeal.fat)} g per container`,
    ...notes,
    "",
    "Ingredients",
    ...recipe.lines.map((l) => `• ${l.name}: ${amt(l.id)}`),
    "",
    "Steps",
    ...steps.map((st, i) => `${i + 1}. ${stepText(st)}`),
    ...(stepsDivide(recipe) ? [] : [`${steps.length + 1}. Divide into ${data.portioning.portions} containers, about ${weight(data.portioning.perContainerGrams)} each.`]),
  ].join("\n");
}

/** The cooking view as PDF blocks, for the recipe package. */
export function cookBlocks(data: Computed, perMeal: PerMeal, notes: string[] = []): Block[] {
  const recipe = data.recipe;
  const gramsOf = new Map(data.calc.lines.map((l) => [l.lineId, l.grams]));
  const lineOf = new Map(recipe.lines.map((l) => [l.id, l]));
  const amt = (id: string, inStep = false) => cookAmount(lineOf.get(id)!, gramsOf.get(id) ?? 0, inStep);
  const steps = cookingSteps(recipe, data.portioning.portions);
  const out: Block[] = [
    { t: "title", text: recipe.name },
    { t: "sub", text: `Makes ${data.portioning.portions} containers, about ${weight(data.portioning.perContainerGrams)} each` },
    { t: "sub", text: `Per container: ${r0(perMeal.kcal)} kcal · Protein ${r0(perMeal.protein)} g · Carbs ${r0(perMeal.carbs)} g · Fat ${r0(perMeal.fat)} g` },
    { t: "heading", text: "Ingredients" },
  ];
  let lastGroup: string | undefined = "\u0000";
  for (const l of recipe.lines) {
    if (l.group !== lastGroup && l.group) out.push({ t: "group", text: l.group });
    lastGroup = l.group;
    out.push({ t: "row", left: l.name, right: amt(l.id), sub: l.optional ? "optional" : undefined });
  }
  for (const n of notes) out.push({ t: "note", text: n });
  out.push({ t: "heading", text: "Steps" });
  steps.forEach((st, i) => {
    const runs: Run[] = st.parts.map((p) => (p.kind === "text" ? { text: p.text } : { text: ` (${amt(p.lineId, true)})`, bold: true }));
    if (st.also.length) runs.push({ text: ` Also: ${st.also.map((id) => `${lineOf.get(id)!.name} (${amt(id)})`).join(", ")}.` });
    out.push({ t: "step", n: i + 1, runs });
  });
  if (!stepsDivide(recipe))
    out.push({ t: "step", n: steps.length + 1, runs: [{ text: "Divide into " }, { text: `${data.portioning.portions} containers`, bold: true }, { text: `, about ${weight(data.portioning.perContainerGrams)} each. Weigh the finished batch for exact portions.` }] });
  return out;
}

export function CookView({ data, perMeal, notes, targets, forPrint = false }: { data: Computed; perMeal: PerMeal; notes: string[]; targets?: TargetResult[]; forPrint?: boolean }): ReactElement {
  const recipe = data.recipe;
  const gramsOf = new Map(data.calc.lines.map((l) => [l.lineId, l.grams]));
  const lineOf = new Map(recipe.lines.map((l) => [l.id, l]));
  const amt = (id: string) => cookAmount(lineOf.get(id)!, gramsOf.get(id) ?? 0);
  const steps = cookingSteps(recipe, data.portioning.portions);
  const s = STATUS_TEXT[data.report.status];
  const ok = (key: string) => targets?.find((t) => t.key === key)?.ok;
  const tick = (key: string) => (ok(key) === true ? " ✓" : ok(key) === false ? " ✗" : "");
  let lastGroup: string | undefined = "\u0000";
  return (
    <section className="section cook" data-testid="cook">
      <div className="card cook__summary" data-testid="cook-summary">
        <p className="cook__makes">Makes {data.portioning.portions} containers · about {weight(data.portioning.perContainerGrams)} each</p>
        <p className="cook__macros">
          <strong>{r0(perMeal.kcal)} kcal{tick("kcal")}</strong> · P {r0(perMeal.protein)} g{tick("protein")} · C {r0(perMeal.carbs)} g{tick("carbs")} · F {r0(perMeal.fat)} g <span className="cook__per">per container</span>
        </p>
        {!forPrint && <span className={`badge badge--${s.tone}`}>{s.label}</span>}
      </div>

      <h3 className="section__title">Ingredients</h3>
      <div className="card" data-testid="cook-ingredients">
        {recipe.lines.map((l) => {
          const head = l.group !== lastGroup && l.group ? <div className="list-head">{l.group}</div> : null;
          lastGroup = l.group;
          return (
            <div key={l.id}>
              {head}
              <div className="row cook__ing">
                <span className="row__label">{l.name}{l.optional ? <span className="row__sub">optional</span> : null}</span>
                <span className="row__value">{amt(l.id)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {notes.length > 0 && <div className="cook__notes">{notes.map((n) => <p key={n} className="note">{n}</p>)}</div>}

      <h3 className="section__title">Steps</h3>
      <div className="card">
        <ol className="steps steps--card cook__steps" data-testid="cook-steps">
          {steps.map((st, i) => (
            <li key={i}>
              {st.parts.map((p, k) => (p.kind === "text" ? <span key={k}>{p.text}</span> : <strong key={k} className="amt"> ({cookAmount(lineOf.get(p.lineId)!, gramsOf.get(p.lineId) ?? 0, true)})</strong>))}
              {st.also.length > 0 && <span className="cook__also">Also: {st.also.map((id) => `${lineOf.get(id)!.name} (${amt(id)})`).join(", ")}</span>}
            </li>
          ))}
          {!stepsDivide(recipe) && <li>Divide into <strong className="amt">{data.portioning.portions} containers</strong>, about {weight(data.portioning.perContainerGrams)} each. Weigh the finished batch for exact portions.</li>}
        </ol>
      </div>
      {!forPrint && (
        <div className="actions actions--center">
          <button className="action" data-testid="share-recipe" onClick={() => void shareText(recipe.name, cookText(data, perMeal))}>Share recipe</button>
        </div>
      )}
    </section>
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
        <span className="row__sub">{t.atLeast ? `At least ${r1(t.range.min)} ${unit}` : `Target ${r1(t.range.min)}–${r1(t.range.max)} ${unit}`}</span>
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
        {report.audits.filter((a) => a.status === "fail").flatMap((a) => a.findings.slice(0, a.problems).map((f) => <div key={`${a.id}-${f}`} className="ingredient__assumption finding">{a.id}: {f}</div>))}
      </div>
      <p className="footnote">USDA data releases: Foundation Foods and SR Legacy · engine {report.engineVersion}</p>
    </section>
  );
}

function SourceSection({ recipe }: { recipe: Recipe }): ReactElement | null {
  const src = recipe.source;
  if (!src) return null;
  const how = { paste: "Pasted", pdf: "From a PDF", docx: "From a Word file", "text-file": "From a text file", ai: "From the AI shortcut" }[src.kind];
  return (
    <details className="more more--section" data-testid="source">
      <summary>Original recipe ({how}{src.fileName ? `: ${src.fileName}` : ""}, {new Date(src.importedAt).toLocaleDateString()})</summary>
      <pre className="prompt">{src.text}</pre>
    </details>
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

export function buyText(item: ShoppingItem): string {
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

function ShoppingSection({ shopping, titled = true }: { shopping: ShoppingList; titled?: boolean }): ReactElement {
  const toBuy = shopping.items.filter((i) => i.buy.kind !== "pantry");
  const pantry = shopping.items.filter((i) => i.buy.kind === "pantry");
  const unverified = toBuy.some((i) => (i.buy.kind === "package" || i.buy.kind === "each" || i.buy.kind === "by_weight") && !i.buy.verified);
  let lastCategory = "";
  return (
    <section className="section" data-testid="shopping">
      {titled && <h3 className="section__title">Shopping list</h3>}
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
      {unverified && <p className="footnote">Package sizes are typical U.S. sizes. Change them under Settings → Packages if your store's differ.</p>}
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
