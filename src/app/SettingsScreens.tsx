// Settings you can edit: allergies, ingredient preferences, macro presets,
// adjustment limits, package sizes, label foods and backups.
import { useState, type ReactElement, type ReactNode } from "react";
import {
  DEFAULT_BOUNDS,
  MAJOR_ALLERGENS,
  NUTRIENT_KEYS,
  checkBackup,
  describePreset,
  newId,
  presetProblems,
  type Allergen,
  type Backup,
  type Bounds,
  type CustomAllergen,
  type IngredientPreference,
  type LabelFood,
  type MacroPreset,
  type NutrientKey,
  type PackageEntry,
  type Settings,
} from "../engine/index.ts";
import { useUserData } from "./store.tsx";
import { BackLink, Field, LinkRow, NumberInput, Section, go } from "./ui.tsx";

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  milk: "Milk", egg: "Egg", fish: "Fish", crustacean_shellfish: "Shellfish (crab, lobster, shrimp)",
  tree_nuts: "Tree nuts", peanuts: "Peanuts", wheat: "Wheat", soy: "Soy", sesame: "Sesame",
};

const words = (text: string) => text.split(",").map((w) => w.trim()).filter(Boolean);

/** Edits a copy of the settings; nothing is saved until you tap Save. */
function useDraft<T>(pick: (s: Settings) => T): { draft: T; setDraft: (t: T) => void; dirty: boolean; save: (merge: (s: Settings, t: T) => Settings) => Promise<void>; saved: boolean } {
  const { settings, saveSettings } = useUserData();
  const [draft, setDraftState] = useState<T>(() => JSON.parse(JSON.stringify(pick(settings))) as T);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  return {
    draft,
    setDraft: (t) => {
      setDraftState(t);
      setDirty(true);
      setSaved(false);
    },
    dirty,
    saved,
    save: async (merge) => {
      await saveSettings(merge(settings, draft));
      setDirty(false);
      setSaved(true);
    },
  };
}

function SaveBar({ disabled, onSave, saved, problems = [] }: { disabled: boolean; onSave: () => void; saved: boolean; problems?: string[] }): ReactElement {
  return (
    <>
      {problems.length > 0 && <div className="warning-box">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <button className="primary-action" disabled={disabled || problems.length > 0} onClick={onSave}>Save</button>
      {saved && <p className="footnote" role="status">Saved on this phone.</p>}
    </>
  );
}

export function SettingsMenu(): ReactElement {
  const { settings, recipes } = useUserData();
  const allergies = settings.profile.allergies.length + (settings.profile.customAllergens?.length ?? 0);
  const checked = settings.packages.filter((p) => p.verified).length;
  return (
    <>
      <Section title="Your profile">
        <LinkRow href="#/settings/allergies" label="Allergies and foods to avoid" value={allergies === 0 ? "None" : `${allergies}`} />
        <LinkRow href="#/settings/preferences" label="Ingredient preferences" value={`${settings.profile.preferences.length}`} />
      </Section>
      <Section title="Scaling">
        <LinkRow href="#/settings/presets" label="Macro presets" value={`${settings.presets.length}`} />
        <LinkRow href="#/settings/limits" label="Adjustment limits" value={`${settings.bounds.protein.min}×–${settings.bounds.protein.max}×`} />
      </Section>
      <Section title="Foods and shopping">
        <LinkRow href="#/settings/labels" label="Label foods" value={`${settings.labelFoods.length}`} />
        <LinkRow href="#/settings/packages" label="Package sizes" value={`${checked} of ${settings.packages.length} checked`} />
      </Section>
      <Section title="Your data">
        <LinkRow href="#/settings/backup" label="Backup and restore" value={`${recipes.length} recipes`} />
      </Section>
    </>
  );
}

// ---------- allergies ----------

export function AllergiesScreen(): ReactElement {
  const { draft, setDraft, dirty, save, saved } = useDraft((s) => ({ allergies: s.profile.allergies, custom: s.profile.customAllergens ?? [] }));
  const toggle = (a: Allergen, on: boolean) => setDraft({ ...draft, allergies: on ? [...draft.allergies, a] : draft.allergies.filter((x) => x !== a) });
  const setCustom = (i: number, c: CustomAllergen) => setDraft({ ...draft, custom: draft.custom.map((x, j) => (j === i ? c : x)) });
  const problems = draft.custom.flatMap((c, i) => (!c.label.trim() || c.matches.length === 0 ? [`Avoid-list item ${i + 1} needs a name and at least one word to look for.`] : []));
  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <Section title="Major allergens" footnote="Recipes with a matching ingredient fail the ingredient check. USDA has no allergen data, so the app screens food names conservatively; always check product labels.">
        {MAJOR_ALLERGENS.map((a) => (
          <label key={a} className="check check--row">
            <input type="checkbox" checked={draft.allergies.includes(a)} onChange={(e) => toggle(a, e.target.checked)} />
            {ALLERGEN_LABEL[a]}
          </label>
        ))}
      </Section>
      <Section title="Other foods to avoid" footnote="For anything not on the list above, such as mollusks (clams, oysters, scallops). The app looks for these words in ingredient names and USDA food names.">
        {draft.custom.map((c, i) => (
          <div key={i} className="card-form-item">
            <Field label="Name">
              <input className="input" aria-label={`Avoid item ${i + 1} name`} value={c.label} onChange={(e) => setCustom(i, { ...c, label: e.target.value })} placeholder="e.g. Mollusks" />
            </Field>
            <Field label="Words to look for (comma-separated)">
              <input className="input" aria-label={`Avoid item ${i + 1} words`} defaultValue={c.matches.join(", ")} onChange={(e) => setCustom(i, { ...c, matches: words(e.target.value) })} placeholder="clam, oyster, scallop, mussel" />
            </Field>
            <button className="small-button small-button--danger" onClick={() => setDraft({ ...draft, custom: draft.custom.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button className="row-button" onClick={() => setDraft({ ...draft, custom: [...draft.custom, { label: "", matches: [] }] })}>Add a food to avoid</button>
      </Section>
      <SaveBar disabled={!dirty} saved={saved} problems={problems} onSave={() => void save((s, d) => ({ ...s, profile: { ...s.profile, allergies: MAJOR_ALLERGENS.filter((a) => d.allergies.includes(a)), customAllergens: d.custom } }))} />
    </>
  );
}

// ---------- ingredient preferences ----------

export function PreferencesScreen(): ReactElement {
  const { draft, setDraft, dirty, save, saved } = useDraft((s) => s.profile.preferences);
  const setPref = (i: number, p: IngredientPreference) => setDraft(draft.map((x, j) => (j === i ? p : x)));
  const problems = draft.flatMap((p, i) => {
    const out: string[] = [];
    if (!p.label.trim() || p.matches.length === 0) out.push(`Preference ${i + 1} needs a name and at least one word.`);
    if (p.mode === "reduce" && !((p.keepPercent ?? 0) > 0 && (p.keepPercent ?? 0) <= 100)) out.push(`"${p.label}": keep between 1% and 100%.`);
    return out;
  });
  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <p className="lead">Applied to every recipe before it's calculated. "Leave out" removes the ingredient; "Use less" keeps the percent you set.</p>
      <section className="section" data-testid="preferences">
        <div className="card">
          {draft.map((p, i) => (
            <div key={i} className="card-form-item">
              <Field label="Name">
                <input className="input" aria-label={`Preference ${i + 1} name`} value={p.label} onChange={(e) => setPref(i, { ...p, label: e.target.value })} />
              </Field>
              <Field label="Matches ingredients named (comma-separated)">
                <input className="input" aria-label={`Preference ${i + 1} words`} defaultValue={p.matches.join(", ")} onChange={(e) => setPref(i, { ...p, matches: words(e.target.value) })} />
              </Field>
              <div className="field-row">
                <Field label="Action">
                  <select className="input" aria-label={`Preference ${i + 1} action`} value={p.mode} onChange={(e) => setPref(i, e.target.value === "reduce" ? { ...p, mode: "reduce", keepPercent: p.keepPercent ?? 50 } : { ...p, mode: e.target.value as IngredientPreference["mode"] })}>
                    <option value="exclude">Leave out</option>
                    <option value="reduce">Use less</option>
                    <option value="allow">Allow (turned off)</option>
                  </select>
                </Field>
                {p.mode === "reduce" && (
                  <Field label="Keep %">
                    <NumberInput label={`Preference ${i + 1} keep percent`} value={p.keepPercent ?? null} onChange={(v) => setPref(i, { ...p, keepPercent: v ?? 0 })} />
                  </Field>
                )}
              </div>
              {p.unless && p.unless.length > 0 && <p className="field__hint">Doesn't apply to: {p.unless.join(", ")}</p>}
              <button className="small-button small-button--danger" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button className="row-button" onClick={() => setDraft([...draft, { label: "", matches: [], mode: "exclude" }])}>Add a preference</button>
        </div>
      </section>
      <SaveBar disabled={!dirty} saved={saved} problems={problems} onSave={() => void save((s, d) => ({ ...s, profile: { ...s.profile, preferences: d } }))} />
    </>
  );
}

// ---------- presets ----------

export function PresetsScreen(): ReactElement {
  const { settings, saveSettings } = useUserData();
  const add = async (from?: MacroPreset) => {
    const p: MacroPreset = from
      ? { ...JSON.parse(JSON.stringify(from)) as MacroPreset, id: newId("p"), name: `${from.name} (copy)` }
      : { id: newId("p"), name: "New preset", kcal: 700, kcalTolerancePct: 2, protein: { grams: 60, mode: "minimum" }, meals: 5 };
    await saveSettings({ ...settings, presets: [...settings.presets, p] });
    go(`/settings/presets/${p.id}`);
  };
  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <section className="section" data-testid="presets">
        <div className="card">
          {settings.presets.map((p) => (
            <LinkRow key={p.id} href={`#/settings/presets/${p.id}`} label={<>{p.name}{p.id === settings.defaultPresetId ? <span className="badge badge--ok badge--inline">Default</span> : null}<span className="row__sub">{describePreset(p)} · ±{p.kcalTolerancePct}%</span></>} />
          ))}
          <button className="row-button" onClick={() => void add()}>New preset</button>
        </div>
      </section>
    </>
  );
}

export function PresetEditorScreen({ id }: { id: string }): ReactElement {
  const { settings, saveSettings } = useUserData();
  const original = settings.presets.find((p) => p.id === id);
  const [p, setP] = useState<MacroPreset | null>(() => (original ? JSON.parse(JSON.stringify(original)) as MacroPreset : null));
  const [saved, setSaved] = useState(false);
  if (!p || !original) return <><BackLink href="#/settings/presets">Presets</BackLink><p className="lead">Preset not found.</p></>;
  const upd = (patch: Partial<MacroPreset>) => {
    setP({ ...p, ...patch });
    setSaved(false);
  };
  const problems = [...(p.name.trim() ? [] : ["Give the preset a name."]), ...presetProblems(p)];
  const dirty = JSON.stringify(p) !== JSON.stringify(original);
  const isDefault = settings.defaultPresetId === p.id;
  const optional = (key: "carbs" | "fat", label: string): ReactNode => {
    const t = p[key];
    return (
      <div className="card-form-item">
        <label className="check">
          <input type="checkbox" checked={t !== undefined} onChange={(e) => {
            const next = { ...p };
            if (e.target.checked) next[key] = { grams: key === "carbs" ? 60 : 20, tolerancePct: 10 };
            else delete next[key];
            setP(next);
            setSaved(false);
          }} />
          Set an exact {label} target{key === "carbs" && p.carbsMin !== undefined ? " (replaces the minimum)" : ""}
        </label>
        {t && (
          <div className="field-row">
            <Field label={`${label[0]!.toUpperCase()}${label.slice(1)} per meal (g)`}>
              <NumberInput label={`${label} grams`} value={t.grams} onChange={(v) => upd({ [key]: { ...t, grams: v ?? 0 } } as Partial<MacroPreset>)} />
            </Field>
            <Field label="Within ±%">
              <NumberInput label={`${label} tolerance`} value={t.tolerancePct} onChange={(v) => upd({ [key]: { ...t, tolerancePct: v ?? 0 } } as Partial<MacroPreset>)} />
            </Field>
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <BackLink href="#/settings/presets">Presets</BackLink>
      <section className="section">
        <div className="card card--form" data-testid="preset-editor">
          <Field label="Name"><input className="input" aria-label="Preset name" value={p.name} onChange={(e) => upd({ name: e.target.value })} /></Field>
          <div className="field-row">
            <Field label="Calories per meal"><NumberInput label="Calories per meal" value={p.kcal} onChange={(v) => upd({ kcal: v ?? 0 })} /></Field>
            <Field label="Within ±%"><NumberInput label="Calorie tolerance" value={p.kcalTolerancePct} onChange={(v) => upd({ kcalTolerancePct: v ?? 0 })} /></Field>
          </div>
          <div className="field-row">
            <Field label="Protein per meal (g)"><NumberInput label="Protein grams" value={p.protein.grams} onChange={(v) => upd({ protein: { ...p.protein, grams: v ?? 0 } })} /></Field>
            <Field label="Protein is">
              <select className="input" aria-label="Protein mode" value={p.protein.mode} onChange={(e) => upd({ protein: e.target.value === "exact" ? { grams: p.protein.grams, mode: "exact", tolerancePct: p.protein.tolerancePct ?? 2 } : { grams: p.protein.grams, mode: "minimum" } })}>
                <option value="minimum">A minimum</option>
                <option value="exact">Exact (within ±%)</option>
              </select>
            </Field>
          </div>
          {p.protein.mode === "minimum" && (
            <Field label="Protein up to (g)" hint="The most protein a meal may have. Leave empty for 5 g over the minimum.">
              <NumberInput label="Protein up to" value={p.protein.max ?? null} onChange={(v) => {
                const { max: _m, ...rest } = p.protein;
                upd({ protein: v === null ? rest : { ...rest, max: v } });
              }} />
            </Field>
          )}
          {!p.carbs && (
            <Field label="Carbs at least (g per meal)" hint="About 45 g is 1 cup of cooked white rice. Leave empty for no minimum.">
              <NumberInput label="Carbs at least" value={p.carbsMin ?? null} onChange={(v) => {
                const { carbsMin: _c, ...rest } = p;
                setP(v === null ? rest : { ...rest, carbsMin: v });
                setSaved(false);
              }} />
            </Field>
          )}
          {p.protein.mode === "exact" && (
            <Field label="Protein within ±%"><NumberInput label="Protein tolerance" value={p.protein.tolerancePct ?? 2} onChange={(v) => upd({ protein: { ...p.protein, tolerancePct: v ?? 0 } })} /></Field>
          )}
          <Field label="Number of meals"><NumberInput label="Meals" inputMode="numeric" value={p.meals} onChange={(v) => upd({ meals: v ?? 0 })} /></Field>
        </div>
      </section>
      <Section title="Optional targets" footnote="Each target you add makes a recipe harder to match. With both carbs and fat set, calories follow from them and are checked against your calorie range.">
        {optional("carbs", "carb")}
        {optional("fat", "fat")}
      </Section>
      <SaveBar disabled={!dirty} saved={saved} problems={problems} onSave={() => void saveSettings({ ...settings, presets: settings.presets.map((x) => (x.id === p.id ? p : x)) }).then(() => setSaved(true))} />
      <div className="actions actions--center">
        {!isDefault && <button className="action" onClick={() => void saveSettings({ ...settings, defaultPresetId: p.id })}>Make default</button>}
        <button className="action" onClick={() => {
          const copy: MacroPreset = { ...JSON.parse(JSON.stringify(p)) as MacroPreset, id: newId("p"), name: `${p.name} (copy)` };
          void saveSettings({ ...settings, presets: [...settings.presets, copy] }).then(() => go(`/settings/presets/${copy.id}`));
        }}>Duplicate</button>
        {settings.presets.length > 1 && (
          <button className="action action--danger" onClick={() => {
            if (!window.confirm(`Delete the preset "${original.name}"?`)) return;
            const presets = settings.presets.filter((x) => x.id !== p.id);
            void saveSettings({ ...settings, presets, defaultPresetId: isDefault ? presets[0]!.id : settings.defaultPresetId }).then(() => go("/settings/presets"));
          }}>Delete</button>
        )}
      </div>
    </>
  );
}

// ---------- limits ----------

const LEVER_TEXT: Record<keyof Bounds, string> = { protein: "Main proteins", carb: "Carbs (rice, pasta…)", fat: "Added fats (oils…)" };

export function LimitsScreen(): ReactElement {
  const { draft, setDraft, dirty, save, saved } = useDraft((s) => s.bounds);
  const problems = (Object.keys(draft) as (keyof Bounds)[]).flatMap((k) => {
    const b = draft[k];
    return b.min > 0 && b.max >= b.min && b.max <= 10 ? [] : [`${LEVER_TEXT[k]}: the smallest must be more than 0 and no bigger than the largest (largest up to 10×).`];
  });
  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <p className="lead">How far the app may change each group per meal when scaling to a preset, as a multiple of the original amount. Tighter limits keep recipes closer to the original but match fewer presets.</p>
      <section className="section" data-testid="limits">
        <div className="card card--form">
          {(Object.keys(draft) as (keyof Bounds)[]).map((k) => (
            <div key={k} className="field-row">
              <Field label={`${LEVER_TEXT[k]}: smallest ×`}>
                <NumberInput label={`${k} smallest`} value={draft[k].min} onChange={(v) => setDraft({ ...draft, [k]: { ...draft[k], min: v ?? 0 } })} />
              </Field>
              <Field label="largest ×">
                <NumberInput label={`${k} largest`} value={draft[k].max} onChange={(v) => setDraft({ ...draft, [k]: { ...draft[k], max: v ?? 0 } })} />
              </Field>
            </div>
          ))}
          <button className="small-button" onClick={() => setDraft(JSON.parse(JSON.stringify(DEFAULT_BOUNDS)) as Bounds)}>Reset to 0.05× – 10×</button>
        </div>
      </section>
      <SaveBar disabled={!dirty} saved={saved} problems={problems} onSave={() => void save((s, d) => ({ ...s, bounds: d }))} />
    </>
  );
}

// ---------- package sizes ----------

function ruleText(p: PackageEntry): string {
  const r = p.rule;
  if (r.kind === "package") return r.label;
  if (r.kind === "each") return `sold individually (${r.label})`;
  if (r.kind === "by_weight") return "sold by weight";
  return "pantry item";
}

const PACKAGE_NAMES: Record<string, string> = {
  "chicken-thighs": "Chicken thighs", "chicken-breast": "Chicken breast", "ground-beef-1lb": "Ground beef",
  "white-rice-2lb": "White rice", "brown-rice-2lb": "Brown rice", "pasta-16oz": "Pasta", "frozen-veg-12oz": "Frozen vegetables",
  "eggs-dozen": "Eggs", "egg-whites-16oz": "Egg whites", "cottage-cheese-16oz": "Cottage cheese", "cheddar-8oz": "Cheddar",
  "milk-half-gallon": "Milk", "yellow-pepper-each": "Yellow bell pepper", "red-pepper-each": "Red bell pepper",
  "onion-each": "Onion", "enchilada-sauce-10oz": "Enchilada sauce", "taco-seasoning-packet": "Taco seasoning",
};

export function PackagesScreen(): ReactElement {
  const { draft, setDraft, dirty, save, saved } = useDraft((s) => s.packages);
  const set = (i: number, p: PackageEntry) => setDraft(draft.map((x, j) => (j === i ? p : x)));
  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <p className="lead">Sizes start as typical U.S. sizes. Change any that differ at your store, then mark them checked so shopping lists stop flagging them.</p>
      <section className="section" data-testid="packages">
        <div className="card">
          {draft.map((p, i) => (
            <div key={p.key} className="card-form-item">
              <div className="row row--flush">
                <span className="row__label">{PACKAGE_NAMES[p.key] ?? p.key}<span className="row__sub">{ruleText(p)}</span></span>
                <label className="check">
                  <input type="checkbox" aria-label={`${PACKAGE_NAMES[p.key] ?? p.key} checked at my store`} checked={p.verified} onChange={(e) => set(i, { ...p, verified: e.target.checked })} />
                  Checked
                </label>
              </div>
              {p.rule.kind === "package" && p.rule.size.kind === "mass" && (
                <div className="field-row">
                  <Field label="Package size">
                    <NumberInput label={`${p.key} size`} value={p.rule.size.amount} onChange={(v) => {
                      if (p.rule.kind !== "package" || p.rule.size.kind !== "mass") return;
                      const size = { ...p.rule.size, amount: v ?? 0 };
                      set(i, { ...p, verified: true, rule: { ...p.rule, size, label: `${v ?? 0} ${size.unit} package` } });
                    }} />
                  </Field>
                  <Field label="Unit">
                    <select className="input" aria-label={`${p.key} unit`} value={p.rule.size.unit} onChange={(e) => {
                      if (p.rule.kind !== "package" || p.rule.size.kind !== "mass") return;
                      const size = { ...p.rule.size, unit: e.target.value as "g" | "oz" | "lb" | "kg" };
                      set(i, { ...p, verified: true, rule: { ...p.rule, size, label: `${size.amount} ${size.unit} package` } });
                    }}>
                      {["oz", "lb", "g", "kg"].map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </Field>
                </div>
              )}
              {p.rule.kind === "package" && p.rule.size.kind !== "mass" && (
                <Field label="Units per package">
                  <NumberInput label={`${p.key} count`} value={p.rule.size.amount} onChange={(v) => {
                    if (p.rule.kind !== "package" || p.rule.size.kind === "mass") return;
                    set(i, { ...p, verified: true, rule: { ...p.rule, size: { ...p.rule.size, amount: v ?? 0 } } });
                  }} />
                </Field>
              )}
            </div>
          ))}
        </div>
      </section>
      <SaveBar
        disabled={!dirty}
        saved={saved}
        problems={draft.flatMap((p) => (p.rule.kind === "package" && !(p.rule.size.amount > 0) ? [`${PACKAGE_NAMES[p.key] ?? p.key}: size must be more than 0.`] : []))}
        onSave={() => void save((s, d) => ({ ...s, packages: d }))}
      />
    </>
  );
}

// ---------- label foods ----------

export function LabelFoodsScreen(): ReactElement {
  const { settings } = useUserData();
  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <p className="lead">Products whose nutrition you copy from the package's Nutrition Facts label, for when USDA has no close match.</p>
      <section className="section" data-testid="label-foods">
        <div className="card">
          {settings.labelFoods.map((f) => (
            <LinkRow key={f.id} href={`#/settings/labels/${f.id}`} label={<>{f.food.name}<span className="row__sub">{f.food.perServing.kcal} kcal · P {f.food.perServing.protein} · C {f.food.perServing.carbs} · F {f.food.perServing.fat} per {f.food.servingGrams} g</span></>} />
          ))}
          <a className="row-button" href="#/settings/labels/new">Add a label food</a>
        </div>
      </section>
    </>
  );
}

const NUTRIENT_FIELDS: { key: NutrientKey; label: string; required: boolean }[] = [
  { key: "kcal", label: "Calories", required: true },
  { key: "fat", label: "Total fat (g)", required: true },
  { key: "satFat", label: "Saturated fat (g)", required: false },
  { key: "sodium", label: "Sodium (mg)", required: false },
  { key: "carbs", label: "Total carbohydrate (g)", required: true },
  { key: "fiber", label: "Dietary fiber (g)", required: false },
  { key: "sugars", label: "Total sugars (g)", required: false },
  { key: "protein", label: "Protein (g)", required: true },
];

export function LabelFoodEditorScreen({ id }: { id: string | null }): ReactElement {
  const { settings, saveSettings } = useUserData();
  const existing = id ? settings.labelFoods.find((f) => f.id === id) : undefined;
  const [food, setFood] = useState<LabelFood>(() =>
    existing
      ? JSON.parse(JSON.stringify(existing.food)) as LabelFood
      : { kind: "label", name: "", servingGrams: 0, perServing: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as unknown as LabelFood["perServing"], source: "" },
  );
  if (id && !existing) return <><BackLink href="#/settings/labels">Label foods</BackLink><p className="lead">Label food not found.</p></>;
  const problems = [
    ...(food.name.trim() ? [] : ["Give it a name."]),
    ...(food.servingGrams > 0 ? [] : ["Enter the serving size in grams (printed next to the serving size)."]),
    ...NUTRIENT_FIELDS.filter((f) => f.required && food.perServing[f.key] === null).map((f) => `${f.label} is required.`),
  ];
  const saveIt = async () => {
    const f: LabelFood = { ...food, name: food.name.trim(), source: food.source.trim() || `Label, entered ${new Date().toLocaleDateString()}` };
    const labelFoods = existing ? settings.labelFoods.map((x) => (x.id === existing.id ? { ...x, food: f } : x)) : [...settings.labelFoods, { id: newId("l"), food: f }];
    await saveSettings({ ...settings, labelFoods });
    go("/settings/labels");
  };
  return (
    <>
      <BackLink href="#/settings/labels">Label foods</BackLink>
      <section className="section">
        <div className="card card--form" data-testid="label-editor">
          <Field label="Product name"><input className="input" aria-label="Product name" value={food.name} onChange={(e) => setFood({ ...food, name: e.target.value })} placeholder="e.g. Lakanto brown sweetener" /></Field>
          <Field label="Serving size (g)" hint="Use the grams printed on the label, e.g. “1 tsp (4 g)” → 4.">
            <NumberInput label="Serving grams" value={food.servingGrams || null} onChange={(v) => setFood({ ...food, servingGrams: v ?? 0 })} />
          </Field>
          {NUTRIENT_FIELDS.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`}>
              <NumberInput label={f.label} value={food.perServing[f.key]} onChange={(v) => setFood({ ...food, perServing: { ...food.perServing, [f.key]: v } })} />
            </Field>
          ))}
          <Field label="Where it's from (optional)"><input className="input" aria-label="Label source" value={food.source} onChange={(e) => setFood({ ...food, source: e.target.value })} placeholder="e.g. Label photo, H-E-B, Nov 2026" /></Field>
        </div>
      </section>
      <SaveBar disabled={false} saved={false} problems={problems} onSave={() => void saveIt()} />
      {existing && (
        <div className="actions actions--center">
          <button className="action action--danger" onClick={() => {
            if (!window.confirm(`Delete "${existing.food.name}"? Recipes that use it keep their own copy of its values.`)) return;
            void saveSettings({ ...settings, labelFoods: settings.labelFoods.filter((x) => x.id !== existing.id) }).then(() => go("/settings/labels"));
          }}>Delete</button>
        </div>
      )}
    </>
  );
}

// ---------- backup ----------

export function BackupScreen(): ReactElement {
  const { exportBackup, restoreBackup, recipes } = useUserData();
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<Backup | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const exportNow = async () => {
    const backup = exportBackup();
    const name = `meal-prep-backup-${backup.exportedAt.slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" });
    const file = new File([blob], name, { type: "application/json" });
    // On iPhone the share sheet offers "Save to Files"; elsewhere the file downloads.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Meal Prep backup" });
        setStatus("Backup shared. Keep it somewhere safe, such as Files or iCloud Drive.");
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setStatus(`Backup saved as ${name}.`);
  };

  const readFile = async (f: File) => {
    setPending(null);
    setProblems([]);
    setStatus(null);
    let data: unknown;
    try {
      data = JSON.parse(await f.text());
    } catch {
      setProblems(["This file isn't a readable backup (not valid JSON)."]);
      return;
    }
    const check = checkBackup(data);
    if (check.ok) setPending(check.backup);
    else setProblems(check.problems.slice(0, 12));
  };

  return (
    <>
      <BackLink href="#/settings">Settings</BackLink>
      <Section title="Back up" footnote="A backup is one file with your settings, presets, label foods and every recipe with its versions. Nothing is uploaded anywhere.">
        <button className="row-button" onClick={() => void exportNow()}>Export a backup ({recipes.length} recipes)</button>
      </Section>
      <Section title="Restore" footnote="Restoring replaces everything on this phone with the backup. The file is checked first; a damaged file is never half-loaded.">
        <label className="row-button file-button">
          Choose a backup file
          <input type="file" accept="application/json,.json" aria-label="Backup file" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
            e.target.value = "";
          }} />
        </label>
      </Section>
      {problems.length > 0 && <div className="warning-box" data-testid="backup-problems"><p><strong>Can't restore this file:</strong></p>{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      {pending && (
        <div className="status status--ok" data-testid="backup-preview">
          <strong>Backup from {new Date(pending.exportedAt).toLocaleString()}</strong>
          <span>{pending.recipes.length} recipes · {pending.settings.presets.length} presets · {pending.settings.labelFoods.length} label foods</span>
          <button className="link-button" onClick={() => void restoreBackup(pending).then(() => {
            setPending(null);
            setStatus("Restored. Your recipes and settings now match the backup.");
          })}>Replace everything with this backup</button>
        </div>
      )}
      {status && <p className="lead" role="status">{status}</p>}
    </>
  );
}
