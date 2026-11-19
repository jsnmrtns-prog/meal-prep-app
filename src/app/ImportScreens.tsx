// Import a recipe: paste text, open a file, or use the optional AI shortcut.
// Then review every line (amount, unit, USDA food) before it becomes a recipe.
import { useMemo, useState, type ReactElement } from "react";
import {
  AI_PROMPT,
  guessRole,
  guessState,
  looksLikeAiBlock,
  parseAiBlock,
  parseRecipeText,
  quantityFor,
  recipeFromImport,
  recipeIdFor,
  stepsMentioning,
  suggestFoods,
  wantFor,
  type Food,
  type ImportFlag,
  type ParsedIngredient,
  type ParsedRecipe,
  type ParsedUnit,
  type Quantity,
  type RecipeSource,
  type ReviewedLine,
} from "../engine/index.ts";
import { textFromFile } from "./fileText.ts";
import { getImport, setDraft, setImport } from "./importState.ts";
import { useUserData } from "./store.tsx";
import { BackLink, Field, NumberInput, Section, go, useEngine, type Engine } from "./ui.tsx";

// ---------- Import ----------

export function ImportScreen(): ReactElement {
  const [text, setText] = useState("");
  const [source, setSource] = useState<{ kind: RecipeSource["kind"]; fileName?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const read = () => {
    setError([]);
    const isAi = looksLikeAiBlock(text);
    let parsed: ParsedRecipe;
    if (isAi) {
      const r = parseAiBlock(text);
      if (!r.ok) return setError(r.problems);
      parsed = r.recipe;
    } else {
      parsed = parseRecipeText(text);
      if (parsed.ingredients.length === 0 && parsed.steps.length === 0) {
        return setError(["No recipe found in this text. Paste the whole recipe, including the ingredient list."]);
      }
    }
    const src: RecipeSource = { kind: isAi ? "ai" : source?.kind ?? "paste", text, importedAt: new Date().toISOString() };
    if (source?.fileName) src.fileName = source.fileName;
    setImport({ parsed, source: src });
    go("/import/review");
  };

  const openFile = async (f: File) => {
    setBusy(true);
    setError([]);
    try {
      const r = await textFromFile(f);
      setText(r.text);
      setSource({ kind: r.kind, fileName: f.name });
    } catch (e) {
      setError([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const pasteClipboard = async () => {
    setError([]);
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return setError(["The clipboard is empty. Copy the recipe first."]);
      setText(t);
      setSource(null);
    } catch {
      setError(["Couldn't read the clipboard. Press and hold in the box below and choose Paste."]);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT);
      setCopied(true);
    } catch {
      setError(["Couldn't copy automatically. Press and hold the prompt text below to copy it."]);
    }
  };

  return (
    <>
      <p className="lead">The app reads recipes itself. You'll check every line before anything is saved.</p>
      <section className="section" data-testid="import-paste">
        <h2 className="section__title">Paste or open a recipe</h2>
        <div className="card card--form">
          <Field label="Recipe text" hint={source?.fileName ? `Read from ${source.fileName}. Fix anything here, then tap Read recipe.` : "From a website, notes, a photo (Live Text) or an AI reply."}>
            <textarea className="input input--area input--tall" aria-label="Recipe text" value={text} rows={10} onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value) setSource(null);
            }} placeholder={"Paste the recipe here: title, servings, ingredients and steps."} />
          </Field>
          <button className="small-button" onClick={() => void pasteClipboard()}>Paste from clipboard</button>
          <label className="small-button file-button">
            {busy ? "Reading file…" : "Open a PDF, Word or text file"}
            <input type="file" accept=".pdf,.docx,.txt,.text,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Recipe file" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openFile(f);
              e.target.value = "";
            }} />
          </label>
        </div>
      </section>
      {error.length > 0 && <div className="warning-box" data-testid="import-error">{error.map((p) => <p key={p}>{p}</p>)}</div>}
      <button className="primary-action" disabled={!text.trim() || busy} onClick={read}>Read recipe</button>

      <Section title="From a photo (Live Text)">
        <ol className="steps">
          <li>Open the photo in Photos (or point the Camera at the recipe).</li>
          <li>Tap the Live Text button (the lines-in-a-box icon), then <strong>Select All</strong> and <strong>Copy</strong>.</li>
          <li>Paste it in the box above and tap <strong>Read recipe</strong>. Handwriting may need a few fixes.</li>
        </ol>
      </Section>

      <section className="section" data-testid="ai-shortcut">
        <h2 className="section__title">AI shortcut (optional)</h2>
        <div className="card">
          <ol className="steps">
            <li>Tap <strong>Copy the AI prompt</strong>.</li>
            <li>In ChatGPT or Claude, paste it and attach the recipe photo, PDF or text.</li>
            <li>Copy the AI's whole reply, paste it in the box above, and tap <strong>Read recipe</strong>.</li>
          </ol>
          <button className="row-button" onClick={() => void copyPrompt()}>{copied ? "Prompt copied ✓" : "Copy the AI prompt"}</button>
          <details className="more more--padded">
            <summary>Show the prompt</summary>
            <pre className="prompt" data-testid="ai-prompt">{AI_PROMPT}</pre>
          </details>
        </div>
        <p className="footnote">The AI only copies the recipe out. The app checks its reply line by line against its own reading and flags any difference. All the nutrition math is done by the app.</p>
      </section>
    </>
  );
}

// ---------- Review ----------

const UNIT_OPTIONS: { key: string; label: string; unit: ParsedUnit | null }[] = [
  { key: "g", label: "g", unit: { kind: "mass", unit: "g" } },
  { key: "oz", label: "oz", unit: { kind: "mass", unit: "oz" } },
  { key: "lb", label: "lb", unit: { kind: "mass", unit: "lb" } },
  { key: "kg", label: "kg", unit: { kind: "mass", unit: "kg" } },
  { key: "tsp", label: "tsp", unit: { kind: "volume", unit: "tsp" } },
  { key: "tbsp", label: "Tbsp", unit: { kind: "volume", unit: "tbsp" } },
  { key: "cup", label: "cup", unit: { kind: "volume", unit: "cup" } },
  { key: "fl_oz", label: "fl oz", unit: { kind: "volume", unit: "fl_oz" } },
  { key: "ml", label: "mL", unit: { kind: "volume", unit: "ml" } },
  { key: "each", label: "each / count", unit: null },
];
const unitKeyOf = (u: ParsedUnit | null) => (u === null || u.kind === "count" ? "each" : u.unit);

interface Row {
  parsed: ParsedIngredient;
  /** Chosen USDA food, or "out" to leave the line out. */
  choice: number | "out" | null;
  /** A USDA size or grams you picked when the app couldn't tell. */
  override: Quantity | null;
  confirmed: boolean;
  search: string;
}

function initialRows(parsed: ParsedRecipe, engine: Engine): Row[] {
  return parsed.ingredients.map((p) => {
    const top = p.name ? suggestFoods(p.name, engine.db, 1, wantFor(p))[0] : undefined;
    return { parsed: p, choice: top ? top.fdcId : null, override: null, confirmed: false, search: "" };
  });
}

export function ImportReviewScreen(): ReactElement {
  const session = useMemo(() => getImport(), []);
  const { engine, error } = useEngine();
  if (!session) {
    return (
      <>
        <BackLink href="#/import">Import</BackLink>
        <p className="lead">Nothing to review. Start from the Import tab.</p>
      </>
    );
  }
  if (error) return <p className="warning">Couldn't load the nutrition data: {error}</p>;
  if (!engine) return <p className="lead">Loading USDA foods…</p>;
  return <Review key={session.source.importedAt} parsed={session.parsed} source={session.source} engine={engine} />;
}

function Review({ parsed, source, engine }: { parsed: ParsedRecipe; source: RecipeSource; engine: Engine }): ReactElement {
  const { recipes } = useUserData();
  const [title, setTitle] = useState(parsed.title ?? "");
  const [servings, setServings] = useState<number | null>(parsed.servings);
  const [steps, setSteps] = useState<string[]>(parsed.steps.length ? parsed.steps : [""]);
  const [rows, setRows] = useState<Row[]>(() => initialRows(parsed, engine));
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const resolved = rows.map((r) => {
    const food = typeof r.choice === "number" && engine.db.has(r.choice) ? engine.db.get(r.choice) : null;
    const q = r.choice === "out" ? null : quantityFor(r.parsed, food);
    const quantity = r.override ?? q?.quantity ?? null;
    return { food, q, quantity };
  });
  const included = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.choice !== "out");
  const blockers: string[] = [];
  if (!title.trim()) blockers.push("Enter the recipe name.");
  if (!(servings !== null && Number.isInteger(servings) && servings >= 1)) blockers.push("Enter how many servings the recipe makes (a whole number).");
  if (steps.filter((s) => s.trim()).length === 0) blockers.push("Add at least one step.");
  if (included.length === 0) blockers.push("Keep at least one ingredient.");
  const waiting = rows.filter((r, i) => !(r.choice === "out" ? r.confirmed : r.confirmed && resolved[i]!.food && resolved[i]!.quantity));
  // Lines with nothing to fix and a food and amount found: one tap accepts them all (their Check notes stay visible).
  const easy = rows.map((r, i) => i).filter((i) => {
    const r = rows[i]!;
    return !r.confirmed && r.choice !== "out" && !r.parsed.flags.some((f) => f.severity === "fix") && resolved[i]!.food && resolved[i]!.quantity;
  });
  if (waiting.length > 0) blockers.push(`${waiting.length} ${waiting.length === 1 ? "line needs" : "lines need"} checking below.`);

  const finish = () => {
    const cleanSteps = steps.map((s) => s.trim()).filter(Boolean);
    const lines: ReviewedLine[] = rows.flatMap((r, i) => {
      const res = resolved[i]!;
      if (r.choice === "out" || !res.food || !res.quantity) return [];
      const notes = r.parsed.flags.map((f) => `Checked on import: ${f.message}`);
      return [{
        name: r.parsed.name,
        food: res.food,
        quantity: res.quantity,
        state: guessState(res.food, r.parsed.name),
        role: guessRole(res.food, r.parsed.name),
        optional: r.parsed.optional,
        group: r.parsed.group,
        usedInSteps: stepsMentioning(r.parsed.name, cleanSteps),
        confirmed: notes,
      }];
    });
    const id = recipeIdFor(title.trim(), new Set(recipes.map((r) => r.id)));
    setDraft(recipeFromImport({ id, title: title.trim(), servings: servings!, lines, steps: cleanSteps, notes: parsed.notes, source }));
    setImport(null);
    go("/recipes/new");
  };

  return (
    <>
      <BackLink href="#/import">Import</BackLink>
      <p className="lead">Check each line. Anything the app wasn't sure about is marked. Nothing is saved until the last step.</p>
      {parsed.flags.length > 0 && <FlagList flags={parsed.flags} testId="recipe-flags" />}
      <section className="section">
        <h2 className="section__title">Recipe</h2>
        <div className="card card--form">
          <Field label="Name"><input className="input" aria-label="Recipe name" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Servings the recipe makes"><NumberInput label="Servings" inputMode="numeric" value={servings} onChange={setServings} /></Field>
        </div>
      </section>

      <section className="section" data-testid="review-ingredients">
        <h2 className="section__title">Ingredients ({rows.length - waiting.length} of {rows.length} checked)</h2>
        {easy.length > 0 && (
          <div className="bulk-accept">
            <button className="row-button" data-testid="accept-easy" onClick={() => setRows((rs) => rs.map((r, j) => (easy.includes(j) ? { ...r, confirmed: true } : r)))}>
              Accept the {easy.length} {easy.length === 1 ? "line" : "lines"} with nothing to fix
            </button>
            <p className="footnote">Then read down the list: each line shows the food picked and any Check note. Tap Change on any that's wrong.</p>
          </div>
        )}
        <div className="card">
          {rows.map((r, i) => (
            <ReviewRow key={i} index={i} row={r} resolved={resolved[i]!} engine={engine} onChange={(p) => setRow(i, p)} />
          ))}
        </div>
      </section>

      <section className="section" data-testid="review-steps">
        <h2 className="section__title">Instructions</h2>
        <div className="card card--form">
          {steps.map((s, i) => (
            <div key={i} className="step-edit">
              <Field label={`Step ${i + 1}`}>
                <textarea className="input input--area" aria-label={`Step ${i + 1}`} rows={3} value={s} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? e.target.value : x)))} />
              </Field>
              {steps.length > 1 && <button className="small-button small-button--danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove step {i + 1}</button>}
            </div>
          ))}
          <button className="small-button" onClick={() => setSteps([...steps, ""])}>Add a step</button>
        </div>
      </section>

      <details className="more more--section" data-testid="original-text">
        <summary>Original recipe text</summary>
        <pre className="prompt">{source.text}</pre>
      </details>

      {blockers.length > 0 && <div className="warning-box" data-testid="review-blockers">{blockers.map((b) => <p key={b}>{b}</p>)}</div>}
      <button className="primary-action" disabled={blockers.length > 0} onClick={finish}>Continue to the recipe</button>
      <p className="footnote">Next you'll see the full recipe with its checks, and save it.</p>
    </>
  );
}

function FlagList({ flags, testId }: { flags: ImportFlag[]; testId?: string }): ReactElement {
  return (
    <ul className="flags" data-testid={testId}>
      {flags.map((f, k) => (
        <li key={k} className={`flag flag--${f.severity}`}>{f.severity === "fix" ? "Fix: " : "Check: "}{f.message}</li>
      ))}
    </ul>
  );
}

function ReviewRow({ index, row, resolved, engine, onChange }: {
  index: number;
  row: Row;
  resolved: { food: Food | null; q: ReturnType<typeof quantityFor> | null; quantity: Quantity | null };
  engine: Engine;
  onChange: (p: Partial<Row>) => void;
}): ReactElement {
  const p = row.parsed;
  const suggestions = useMemo(() => (p.name ? suggestFoods(p.name, engine.db, 6, wantFor(p)) : []), [p, engine]);
  const searchResults = useMemo(() => (row.search.trim().length >= 2 ? engine.db.search(row.search, 8).filter((f) => f.usableForMacros) : []), [row.search, engine]);
  const options = [...suggestions];
  if (resolved.food && !options.some((f) => f.fdcId === resolved.food!.fdcId)) options.unshift(resolved.food);
  const setParsed = (patch: Partial<ParsedIngredient>) => onChange({ parsed: { ...p, ...patch }, override: null, confirmed: false });
  const out = row.choice === "out";
  const done = row.confirmed && (out || (resolved.food && resolved.quantity));
  if (done) {
    // Checked lines fold up so the list stays short; tap Change to reopen one.
    return (
      <div className="review-row review-row--done" data-testid={`review-row-${index}`}>
        <p className="review-row__raw">{p.raw}</p>
        {!out && p.flags.length > 0 && <FlagList flags={p.flags} />}
        <div className="review-row__actions">
          <span className="option__meta">{out ? "Left out" : `✓ ${resolved.food!.description}`}</span>
          <button className="small-button" onClick={() => onChange({ confirmed: false, ...(out ? { choice: suggestions[0]?.fdcId ?? null } : {}) })}>Change</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`review-row${done ? " review-row--done" : ""}`} data-testid={`review-row-${index}`}>
      <p className="review-row__raw">{p.group ? <span className="badge badge--muted badge--inline-left">{p.group}</span> : null}{p.raw}</p>
      {p.flags.length > 0 && <FlagList flags={p.flags} />}
      {!out && (
        <>
          <div className="field-row">
            <Field label="Amount">
              <NumberInput label={`Amount ${index + 1}`} value={p.amount} onChange={(v) => setParsed({ amount: v, amountMax: null })} />
            </Field>
            <Field label="Unit">
              <select className="input" aria-label={`Unit ${index + 1}`} value={p.packageSize ? "pkg" : unitKeyOf(p.unit)} onChange={(e) => {
                const opt = UNIT_OPTIONS.find((o) => o.key === e.target.value);
                if (opt) setParsed({ unit: opt.unit, packageSize: null });
              }}>
                {p.packageSize && <option value="pkg">× {p.packageSize.amount} {p.packageSize.unit} each</option>}
                {UNIT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.key === "each" && p.unit?.kind === "count" ? p.unit.noun : o.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Name (as the steps call it)">
            <input className="input" aria-label={`Name ${index + 1}`} value={p.name} onChange={(e) => setParsed({ name: e.target.value })} />
          </Field>
          <Field label="USDA food" hint={resolved.food ? `${resolved.food.per100g.kcal} kcal · P ${resolved.food.per100g.protein} · C ${resolved.food.per100g.carbs} · F ${resolved.food.per100g.fat} per 100 g · ${resolved.food.dataset === "foundation" ? "Foundation" : "SR Legacy"} ${resolved.food.fdcId}` : null}>
            <select className="input" aria-label={`USDA food ${index + 1}`} value={typeof row.choice === "number" ? String(row.choice) : ""} onChange={(e) => onChange({ choice: e.target.value ? Number(e.target.value) : null, override: null, confirmed: false })}>
              {!resolved.food && <option value="">Choose a food</option>}
              {options.map((f) => <option key={f.fdcId} value={f.fdcId}>{f.description}</option>)}
            </select>
          </Field>
          <input className="search-field search-field--inline" type="search" aria-label={`Search USDA foods ${index + 1}`} placeholder="Not right? Search USDA foods" value={row.search} onChange={(e) => onChange({ search: e.target.value })} />
          {searchResults.map((f) => (
            <button key={f.fdcId} className="option" onClick={() => onChange({ choice: f.fdcId, search: "", override: null, confirmed: false })}>
              <span className="option__title option__title--plain">{f.description}</span>
              <span className="option__meta">{f.per100g.kcal} kcal · P {f.per100g.protein} per 100 g</span>
            </button>
          ))}
          {resolved.q?.problem && !row.override && (
            <div className="needs" data-testid={`needs-${index}`}>
              <p className="flag flag--fix">Fix: {resolved.q.problem}</p>
              {resolved.q.options.length > 0 && (
                <select className="input" aria-label={`Size ${index + 1}`} value="" onChange={(e) => {
                  const o = resolved.q!.options[Number(e.target.value)];
                  if (o) onChange({ override: o.quantity });
                }}>
                  <option value="">Choose a USDA size</option>
                  {resolved.q.options.map((o, k) => <option key={k} value={k}>{o.label}</option>)}
                </select>
              )}
              <GramsEntry index={index} onSet={(g) => onChange({ override: { kind: "mass", amount: g, unit: "g" } })} />
            </div>
          )}
          {row.override && (
            <p className="field__hint">Using {row.override.kind === "mass" ? `${row.override.amount} g` : row.override.kind === "count" ? `${row.override.amount} × ${row.override.portionLabel}` : `${row.override.amount} ${row.override.unit} (${row.override.portionLabel ?? ""})`}. <button className="link-button link-button--inline" onClick={() => onChange({ override: null, confirmed: false })}>Change</button></p>
          )}
        </>
      )}
      <div className="review-row__actions">
        <label className="check">
          <input type="checkbox" aria-label={`Line ${index + 1} checked`} checked={row.confirmed} disabled={!out && !(resolved.food && resolved.quantity)} onChange={(e) => onChange({ confirmed: e.target.checked })} />
          {out ? "Leave this out" : "Looks right"}
        </label>
        <button className="small-button" onClick={() => onChange(out ? { choice: suggestions[0]?.fdcId ?? null, confirmed: false } : { choice: "out", confirmed: true })}>{out ? "Include it" : "Leave out"}</button>
      </div>
    </div>
  );
}

function GramsEntry({ index, onSet }: { index: number; onSet: (g: number) => void }): ReactElement {
  const [g, setG] = useState<number | null>(null);
  return (
    <div className="field-row field-row--end">
      <Field label="Or enter grams">
        <NumberInput label={`Grams ${index + 1}`} value={g} onChange={setG} />
      </Field>
      <button className="small-button" disabled={!(g !== null && g > 0)} onClick={() => g !== null && onSet(g)}>Use grams</button>
    </div>
  );
}
