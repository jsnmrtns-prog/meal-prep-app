// Type in a recipe by hand: ingredients matched to USDA foods (or your label
// foods), instructions, and live checks that show what still needs fixing.
import { useMemo, useState, type ReactElement } from "react";
import {
  RecipeInputError,
  gramsForAmount,
  recipeIdFor,
  recipeProblems,
  type Food,
  type FoodRef,
  type IngredientLine,
  type IngredientRole,
  type LineCook,
  type MeasuredState,
  type Quantity,
  type Recipe,
  type Settings,
} from "../engine/index.ts";
import { takeDraft } from "./importState.ts";
import { STATUS_TEXT, analyse, prepared } from "./RecipeReport.tsx";
import { useUserData } from "./store.tsx";
import { BackLink, Field, NumberInput, go, useEngine, type Engine } from "./ui.tsx";

const ROLE_TEXT: Record<IngredientRole, string> = {
  protein: "Main protein",
  carb: "Carb",
  fat: "Added fat",
  vegetable: "Vegetable/fruit",
  dairy: "Dairy",
  sauce: "Sauce",
  seasoning: "Seasoning",
  other: "Other",
};
const STATE_TEXT: Record<MeasuredState, string> = {
  raw: "Raw",
  dry: "Dry",
  cooked: "Cooked",
  frozen: "Frozen",
  as_packaged: "As packaged",
};
const MASS_UNITS = ["g", "oz", "lb", "kg"] as const;
const VOLUME_UNITS = ["tsp", "tbsp", "cup", "fl_oz", "ml"] as const;
const UNIT_LABEL: Record<string, string> = { g: "g", oz: "oz", lb: "lb", kg: "kg", tsp: "tsp", tbsp: "Tbsp", cup: "cup", fl_oz: "fl oz", ml: "mL", l: "L" };

const COOKED_WORDS = /\b(cooked|boiled|roasted|fried|baked|grilled|braised|broiled|stewed|steamed|microwaved|simmered|pan-browned)\b/i;

/** A sensible role for a USDA food, which you can change. */
function guessRole(food: Food): IngredientRole {
  const c = food.category;
  const d = food.description.toLowerCase();
  if (/^egg/.test(d)) return "protein";
  if (["Poultry Products", "Beef Products", "Pork Products", "Finfish and Shellfish Products", "Lamb, Veal, and Game Products", "Sausages and Luncheon Meats"].includes(c)) return "protein";
  if (c === "Cereal Grains and Pasta") return "carb";
  if (c === "Fats and Oils") return "fat";
  if (c === "Vegetables and Vegetable Products" || c === "Fruits and Fruit Juices") return /potato/.test(d) ? "carb" : "vegetable";
  if (c === "Dairy and Egg Products") return "dairy";
  if (c === "Spices and Herbs") return "seasoning";
  if (c === "Soups, Sauces, and Gravies") return "sauce";
  return "other";
}

/** Amount choices for a food: weights always; volumes and counts from its USDA portions. */
function unitOptions(food: FoodRef, db: Engine["db"]): { key: string; label: string; make: (amount: number) => Quantity }[] {
  const opts: { key: string; label: string; make: (amount: number) => Quantity }[] = MASS_UNITS.map((u) => ({
    key: u, label: UNIT_LABEL[u]!, make: (amount) => ({ kind: "mass", amount, unit: u }),
  }));
  if (food.kind === "builtin" && food.id === "water") {
    for (const u of VOLUME_UNITS) opts.push({ key: u, label: UNIT_LABEL[u]!, make: (amount) => ({ kind: "volume", amount, unit: u }) });
  }
  if (food.kind !== "usda" || !db.has(food.fdcId)) return opts;
  const f = db.get(food.fdcId);
  for (const u of VOLUME_UNITS) {
    const r = gramsForAmount(f, 1, u);
    if (r.ok) opts.push({ key: u, label: `${UNIT_LABEL[u]} (USDA: ${round(r.grams)} g each)`, make: (amount) => ({ kind: "volume", amount, unit: u }) });
    else if (r.reason === "ambiguous") {
      for (const p of r.options) {
        opts.push({ key: `${u}|${p.label}`, label: `${UNIT_LABEL[u]}, as in "${p.amount} ${p.label}" (${round(p.grams)} g)`, make: (amount) => ({ kind: "volume", amount, unit: u, portionLabel: p.label }) });
      }
    }
  }
  for (const p of f.portions) {
    if (p.unit !== null && (VOLUME_UNITS as readonly string[]).concat(MASS_UNITS, ["l"]).includes(p.unit)) continue;
    if (!(p.grams > 0)) continue;
    opts.push({ key: `count|${p.label}`, label: `${p.label} (${round(p.grams / p.amount)} g each)`, make: (amount) => ({ kind: "count", amount, portionLabel: p.label }) });
  }
  return opts;
}

function unitKey(q: Quantity): string {
  if (q.kind === "mass") return q.unit;
  if (q.kind === "volume") return q.portionLabel ? `${q.unit}|${q.portionLabel}` : q.unit;
  return `count|${q.portionLabel}`;
}

const round = (n: number) => Math.round(n * 10) / 10;

function emptyRecipe(): Recipe {
  return { id: "", name: "", portions: 4, lines: [], steps: [{ text: "" }] };
}

function lineSummary(line: IngredientLine, settings: Settings, engine: Engine | null): string {
  const q = line.quantity;
  const amount = q.kind === "mass" || q.kind === "volume" ? `${q.amount} ${UNIT_LABEL[q.unit] ?? q.unit}` : `${q.amount} × ${q.portionLabel}`;
  const food =
    line.food.kind === "usda"
      ? engine?.db.has(line.food.fdcId) ? engine.db.get(line.food.fdcId).description : `USDA ${line.food.fdcId}`
      : line.food.kind === "label"
        ? `Label: ${line.food.name}`
        : line.food.id === "water" ? "Water" : "Zero-calorie sweetener";
  void settings;
  return `${amount} · ${food}`;
}

export function RecipeEditorScreen({ id }: { id: string | null }): ReactElement {
  const { recipes, settings, saveRecipe } = useUserData();
  const { engine } = useEngine();
  const existing = id ? recipes.find((r) => r.id === id) : undefined;
  // A new recipe may start from an import that was just reviewed.
  const [draft, setDraft] = useState<Recipe>(() => (existing ? JSON.parse(JSON.stringify(existing.recipe)) as Recipe : takeDraft() ?? emptyRecipe()));
  const fromImport = !existing && draft.source !== undefined;
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const set = (patch: Partial<Recipe>) => setDraft((d) => ({ ...d, ...patch }));
  const setLine = (i: number, line: IngredientLine) => setDraft((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? line : l)) }));
  const removeLine = (i: number) => {
    setDraft((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));
    setEditing(null);
  };
  const addLine = () => {
    const taken = new Set(draft.lines.map((l) => l.id));
    const line: IngredientLine = {
      id: recipeIdFor("ingredient", taken),
      name: "",
      food: { kind: "usda", fdcId: 0 }, // 0 = not chosen yet
      quantity: { kind: "mass", amount: 0, unit: "g" },
      state: "raw",
      role: "other",
      cook: { kind: "unchanged" },
      usedInSteps: draft.steps.length === 1 ? [1] : [],
    };
    setDraft((d) => ({ ...d, lines: [...d.lines, line] }));
    setEditing(draft.lines.length);
  };
  const setStep = (i: number, text: string) => setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { text } : s)) }));
  const removeStep = (i: number) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.filter((_, j) => j !== i),
      // Step numbers after the removed one move up by one.
      lines: d.lines.map((l) => ({ ...l, usedInSteps: (l.usedInSteps ?? []).filter((n) => n !== i + 1).map((n) => (n > i + 1 ? n - 1 : n)) })),
    }));

  const toSave: Recipe = useMemo(() => {
    const idFor = existing ? existing.id : recipeIdFor(draft.name, new Set(recipes.map((r) => r.id)));
    return { ...draft, id: idFor, name: draft.name.trim() };
  }, [draft, existing, recipes]);

  const problems = useMemo(() => {
    const p = recipeProblems(toSave);
    if (toSave.lines.length === 0) p.push("Add at least one ingredient.");
    toSave.steps.forEach((st, i) => {
      if (!st.text.trim()) p.push(`Step ${i + 1} is empty: write it or remove it.`);
    });
    return p;
  }, [toSave]);

  const check = useMemo(() => {
    if (!engine || problems.length > 0) return null;
    try {
      const data = analyse(prepared(toSave, settings).recipe, engine, settings);
      return { data, error: null };
    } catch (e) {
      return { data: null, error: e instanceof RecipeInputError || e instanceof Error ? e.message : String(e) };
    }
  }, [engine, problems, toSave, settings]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const savedId = await saveRecipe(toSave, existing?.origin ?? (fromImport ? "imported" : "manual"));
      go(`/recipes/${encodeURIComponent(savedId)}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  if (id && !existing) return <p className="lead">Recipe not found.</p>;
  return (
    <>
      <BackLink href={existing ? `#/recipes/${encodeURIComponent(existing.id)}` : "#/recipes"}>{existing ? "Cancel" : "My Recipes"}</BackLink>
      {fromImport && <p className="lead" data-testid="from-import">Imported and checked. Look over the result below, then tap Save recipe.</p>}
      <section className="section">
        <h2 className="section__title">Recipe</h2>
        <div className="card card--form">
          <Field label="Name">
            <input className="input" aria-label="Recipe name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Chicken and Rice" />
          </Field>
          <Field label="Servings the recipe makes">
            <NumberInput label="Servings" inputMode="numeric" value={draft.portions} onChange={(v) => set({ portions: v === null ? 0 : v })} />
          </Field>
        </div>
      </section>

      <section className="section" data-testid="editor-steps">
        <h2 className="section__title">Instructions</h2>
        <div className="card card--form">
          {draft.steps.map((s, i) => (
            <div key={i} className="step-edit">
              <Field label={`Step ${i + 1}`}>
                <textarea className="input input--area" aria-label={`Step ${i + 1}`} value={s.text} rows={3} onChange={(e) => setStep(i, e.target.value)} />
              </Field>
              {draft.steps.length > 1 && <button className="small-button small-button--danger" onClick={() => removeStep(i)}>Remove step {i + 1}</button>}
            </div>
          ))}
          <button className="small-button" onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, { text: "" }] }))}>Add a step</button>
        </div>
        <p className="footnote">Write the steps in your own words. Each ingredient is linked to the steps that use it, and every step must mention it by name.</p>
      </section>

      <section className="section" data-testid="editor-ingredients">
        <h2 className="section__title">Ingredients</h2>
        <div className="card">
          {draft.lines.map((line, i) =>
            editing === i ? (
              <IngredientForm
                key={line.id}
                line={line}
                steps={draft.steps}
                engine={engine}
                settings={settings}
                takenIds={new Set(draft.lines.filter((_, j) => j !== i).map((l) => l.id))}
                onChange={(l) => setLine(i, l)}
                onDone={() => setEditing(null)}
                onRemove={() => removeLine(i)}
              />
            ) : (
              <button key={line.id} className="option" onClick={() => setEditing(i)}>
                <span className="option__title">{line.name || "(unnamed ingredient)"}</span>
                <span className="option__meta">{lineSummary(line, settings, engine)}{line.usedInSteps?.length ? ` · step ${line.usedInSteps.join(", ")}` : " · not linked to a step"}</span>
              </button>
            ),
          )}
          {editing === null && <button className="row-button" onClick={addLine}>Add an ingredient</button>}
        </div>
      </section>

      <section className="section" data-testid="editor-check">
        <h2 className="section__title">Checks</h2>
        <div className="card">
          {problems.length > 0 && <div className="empty">{problems.map((p) => <p key={p} className="note">{p}</p>)}</div>}
          {problems.length === 0 && !engine && <div className="empty"><p>Loading USDA data…</p></div>}
          {check?.error && <div className="empty"><p className="note">{check.error}</p></div>}
          {check?.data && <CheckSummary data={check.data} />}
        </div>
      </section>

      {saveError && <p className="warning">Couldn't save: {saveError}</p>}
      <button className="primary-action" disabled={problems.length > 0 || saving || editing !== null} onClick={() => void save()}>
        {saving ? "Saving…" : editing !== null ? "Finish the ingredient first" : "Save recipe"}
      </button>
      <p className="footnote">Saved on this phone. A recipe that needs review can be saved and fixed later.</p>
    </>
  );
}

function CheckSummary({ data }: { data: ReturnType<typeof analyse> }): ReactElement {
  const s = STATUS_TEXT[data.report.status];
  const pp = data.calc.perPortion;
  const findings = data.report.audits.flatMap((a) => (a.status === "fail" || a.status === "warn" ? a.findings.map((f) => ({ a: a.id, f, fail: a.status === "fail" })) : []));
  return (
    <>
      <div className={`status status--${s.tone} status--flat`} data-testid="editor-status">
        <strong>{s.label}</strong>
        <span>{Math.round(pp.kcal.value)} kcal · P {round(pp.protein.value)} g · C {round(pp.carbs.value)} g · F {round(pp.fat.value)} g per serving</span>
      </div>
      {findings.length > 0 && (
        <div className="empty">
          {findings.map(({ a, f, fail }) => <p key={`${a}${f}`} className={`note ${fail ? "note--bad" : ""}`}>{fail ? "Fix: " : "Note: "}{f}</p>)}
        </div>
      )}
    </>
  );
}

function IngredientForm({ line, steps, engine, settings, takenIds, onChange, onDone, onRemove }: {
  line: IngredientLine;
  steps: Recipe["steps"];
  engine: Engine | null;
  settings: Settings;
  takenIds: Set<string>;
  onChange: (l: IngredientLine) => void;
  onDone: () => void;
  onRemove: () => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [yieldFilter, setYieldFilter] = useState("");
  const db = engine?.db ?? null;
  const results = useMemo(() => (db && query.trim().length >= 2 ? db.search(query, 8).filter((f) => f.usableForMacros) : []), [db, query]);
  const upd = (patch: Partial<IngredientLine>) => onChange({ ...line, ...patch });
  const source = line.food.kind;
  const options = engine ? unitOptions(line.food, engine.db) : [];
  const currentKey = unitKey(line.quantity);
  const usdaFood = line.food.kind === "usda" && db?.has(line.food.fdcId) ? db.get(line.food.fdcId) : null;

  const pickFood = (f: Food) => {
    const name = line.name.trim() || f.description.split(",")[0]!.toLowerCase();
    const id = takenIds.has(line.id) || line.id.startsWith("ingredient") ? recipeIdFor(name, takenIds) : line.id;
    onChange({
      ...line,
      id,
      name,
      food: { kind: "usda", fdcId: f.fdcId },
      quantity: { kind: "mass", amount: line.quantity.amount, unit: line.quantity.kind === "mass" ? line.quantity.unit : "g" },
      state: COOKED_WORDS.test(f.description) ? "cooked" : /frozen/i.test(f.description) ? "frozen" : "raw",
      role: guessRole(f),
    });
    setQuery("");
  };

  const yieldsList = useMemo(() => {
    if (!engine) return [];
    const all = [...engine.yields.list("hydration"), ...engine.yields.list("cook")];
    const q = yieldFilter.trim().toLowerCase();
    return q ? all.filter((y) => `${y.description} ${y.method}`.toLowerCase().includes(q)).slice(0, 40) : all.slice(0, 40);
  }, [engine, yieldFilter]);
  const cookValue = line.cook?.kind === "yield" ? `yield|${line.cook.yieldId}|${line.cook.match}` : line.cook?.kind ?? "unchanged";
  const setCook = (v: string) => {
    const [kind, yieldId, match] = v.split("|");
    const cook: LineCook = kind === "yield" ? { kind: "yield", yieldId: yieldId!, match: match === "exact" ? "exact" : "closest" } : kind === "absorbed" ? { kind: "absorbed" } : { kind: "unchanged" };
    upd({ cook });
  };
  const currentYield = line.cook?.kind === "yield" && engine ? engine.yields.get(line.cook.yieldId) : null;

  return (
    <div className="ingredient-form" data-testid="ingredient-form">
      <Field label="Ingredient name (as the steps call it)">
        <input className="input" aria-label="Ingredient name" value={line.name} onChange={(e) => upd({ name: e.target.value })} placeholder="e.g. chicken breast" />
      </Field>

      <Field label="Nutrition comes from">
        <select
          className="input"
          aria-label="Nutrition source"
          value={source === "builtin" ? `builtin-${line.food.kind === "builtin" ? line.food.id : ""}` : source}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "usda") upd({ food: { kind: "usda", fdcId: 0 } });
            else if (v === "label") {
              const first = settings.labelFoods[0];
              if (first) upd({ food: first.food, quantity: { kind: "mass", amount: line.quantity.amount, unit: "g" }, state: "as_packaged" });
            } else if (v === "builtin-water") upd({ food: { kind: "builtin", id: "water" }, role: "other" });
            else if (v === "builtin-zero_calorie_sweetener") upd({ food: { kind: "builtin", id: "zero_calorie_sweetener" }, quantity: { kind: "mass", amount: line.quantity.amount, unit: "g" }, assumptions: ["Zero-calorie sweetener counted as 0 kcal (from the product's claim)."] });
          }}
        >
          <option value="usda">A USDA food</option>
          <option value="label" disabled={settings.labelFoods.length === 0}>One of my label foods{settings.labelFoods.length === 0 ? " (none yet)" : ""}</option>
          <option value="builtin-water">Water</option>
          <option value="builtin-zero_calorie_sweetener">Zero-calorie sweetener</option>
        </select>
      </Field>

      {source === "usda" && (
        <>
          {usdaFood ? (
            <p className="picked-food" data-testid="picked-food">{usdaFood.description} <span className="cols__muted">· {usdaFood.dataset === "foundation" ? "Foundation" : "SR Legacy"} {usdaFood.fdcId} · {usdaFood.per100g.kcal} kcal, P {usdaFood.per100g.protein} per 100 g</span></p>
          ) : (
            <p className="picked-food cols__muted">No USDA food chosen yet.</p>
          )}
          <input className="search-field" type="search" aria-label="Search USDA foods" placeholder={db ? "Search USDA foods" : "Loading foods…"} value={query} onChange={(e) => setQuery(e.target.value)} disabled={!db} />
          {results.map((f) => (
            <button key={f.fdcId} className="option" onClick={() => pickFood(f)}>
              <span className="option__title option__title--plain">{f.description}</span>
              <span className="option__meta">{f.per100g.kcal} kcal · P {f.per100g.protein} · C {f.per100g.carbs} · F {f.per100g.fat} per 100 g · {f.dataset === "foundation" ? "Foundation" : "SR Legacy"}</span>
            </button>
          ))}
        </>
      )}

      {source === "label" && (
        <Field label="Label food">
          <select
            className="input"
            aria-label="Label food"
            value={settings.labelFoods.find((x) => line.food.kind === "label" && x.food.name === line.food.name)?.id ?? ""}
            onChange={(e) => {
              const f = settings.labelFoods.find((x) => x.id === e.target.value);
              if (f) upd({ food: f.food });
            }}
          >
            {settings.labelFoods.map((x) => <option key={x.id} value={x.id}>{x.food.name}</option>)}
          </select>
        </Field>
      )}

      <div className="field-row">
        <Field label="Amount">
          <NumberInput label="Amount" value={line.quantity.amount} onChange={(v) => upd({ quantity: { ...line.quantity, amount: v ?? 0 } })} />
        </Field>
        <Field label="Unit">
          <select
            className="input"
            aria-label="Unit"
            value={options.some((o) => o.key === currentKey) ? currentKey : ""}
            onChange={(e) => {
              const o = options.find((x) => x.key === e.target.value);
              if (o) upd({ quantity: o.make(line.quantity.amount) });
            }}
          >
            {!options.some((o) => o.key === currentKey) && <option value="">Choose a unit</option>}
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="field-row">
        <Field label="Measured">
          <select className="input" aria-label="Measured state" value={line.state} onChange={(e) => upd({ state: e.target.value as MeasuredState })}>
            {Object.entries(STATE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Role" hint="Main proteins and carbs are what scaling adjusts.">
          <select className="input" aria-label="Role" value={line.role} onChange={(e) => upd({ role: e.target.value as IngredientRole })}>
            {Object.entries(ROLE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>

      <fieldset className="checks">
        <legend className="field__label">Used in</legend>
        {steps.map((s, i) => (
          <label key={i} className="check">
            <input
              type="checkbox"
              checked={(line.usedInSteps ?? []).includes(i + 1)}
              onChange={(e) => {
                const set = new Set(line.usedInSteps ?? []);
                if (e.target.checked) set.add(i + 1);
                else set.delete(i + 1);
                upd({ usedInSteps: [...set].sort((a, b) => a - b) });
              }}
            />
            Step {i + 1}{s.text ? `: ${s.text.slice(0, 40)}${s.text.length > 40 ? "…" : ""}` : ""}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={line.optional === true} onChange={(e) => upd({ optional: e.target.checked || undefined } as Partial<IngredientLine>)} />
          Optional ingredient
        </label>
      </fieldset>

      <details className="more">
        <summary>Cooking weight, prep and assumptions</summary>
        <Field label="When cooked, its weight…" hint={currentYield ? `USDA: ${currentYield.description}, ${currentYield.method}: ${round(currentYield.percent)}% of the starting weight` : "Only used for container weights, never for nutrition."}>
          <input className="input" aria-label="Filter cooking yields" placeholder="Filter USDA yields (e.g. chicken, rice)" value={yieldFilter} onChange={(e) => setYieldFilter(e.target.value)} />
          <select className="input" aria-label="Cooking weight" value={cookValue} onChange={(e) => setCook(e.target.value)}>
            <option value="unchanged">Stays the same (assumed)</option>
            <option value="absorbed">Cooked in water that's drained or absorbed elsewhere</option>
            {currentYield && !yieldsList.some((y) => cookValue.startsWith(`yield|${y.id}|`)) && <option value={cookValue}>{currentYield.description}, {currentYield.method}</option>}
            {yieldsList.flatMap((y) => [
              <option key={`${y.id}e`} value={`yield|${y.id}|exact`}>{y.description}, {y.method} ({round(y.percent)}%), exact match</option>,
              <option key={`${y.id}c`} value={`yield|${y.id}|closest`}>{y.description}, {y.method} ({round(y.percent)}%), closest match</option>,
            ])}
          </select>
        </Field>
        <Field label="Bone removed (bone-in cuts)">
          <select
            className="input"
            aria-label="Bone removal"
            value={line.prep?.boneYieldId ?? ""}
            onChange={(e) => {
              const prep = { ...line.prep };
              if (e.target.value) prep.boneYieldId = e.target.value;
              else delete prep.boneYieldId;
              upd(Object.keys(prep).length ? { prep } : ({ prep: undefined } as unknown as Partial<IngredientLine>));
            }}
          >
            <option value="">No bone</option>
            {engine?.yields.list("bone").map((y) => <option key={y.id} value={y.id}>{y.description} ({round(y.percent)}% usable)</option>)}
          </select>
        </Field>
        <Field label="Fat trimmed: percent kept (your measurement)" hint="Leave empty if you don't trim.">
          <NumberInput
            label="Percent kept after trimming"
            value={line.prep?.trimKeptPercent ?? null}
            onChange={(v) => {
              const prep = { ...line.prep };
              if (v === null) delete prep.trimKeptPercent;
              else prep.trimKeptPercent = v;
              upd(Object.keys(prep).length ? { prep } : ({ prep: undefined } as unknown as Partial<IngredientLine>));
            }}
          />
        </Field>
        <Field label="Stand-in for (if this food only approximates the real one)">
          <input className="input" aria-label="Stand-in for" value={line.substituteFor ?? ""} onChange={(e) => upd(e.target.value ? { substituteFor: e.target.value } : ({ substituteFor: undefined } as unknown as Partial<IngredientLine>))} />
        </Field>
        <Field label="Assumptions (one per line)">
          <textarea className="input input--area" aria-label="Assumptions" rows={2} value={(line.assumptions ?? []).join("\n")} onChange={(e) => {
            const a = e.target.value.split("\n");
            upd(a.some((x) => x.trim()) ? { assumptions: a } : ({ assumptions: undefined } as unknown as Partial<IngredientLine>));
          }} />
        </Field>
      </details>

      <div className="form-buttons">
        <button className="small-button small-button--danger" onClick={onRemove}>Remove</button>
        <button className="small-button small-button--primary" onClick={() => {
          // Drop blank assumption lines on the way out.
          if (line.assumptions) {
            const a = line.assumptions.map((x) => x.trim()).filter(Boolean);
            onChange(a.length ? { ...line, assumptions: a } : (({ assumptions: _a, ...rest }) => rest)(line));
          }
          onDone();
        }}>Done</button>
      </div>
    </div>
  );
}
