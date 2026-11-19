// Import a recipe: paste text, open a file, or use the optional AI shortcut.
// Then review every line (amount, unit, USDA food) before it becomes a recipe.
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  AI_PROMPT,
  approximateNote,
  findRecipes,
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
  type BookRecipe,
  type Food,
  type ImportFlag,
  type ParsedIngredient,
  type ParsedRecipe,
  type ParsedUnit,
  type Quantity,
  type RecipeSource,
  type ReviewedLine,
} from "../engine/index.ts";
import { bookIdFor, deleteBook, getBook, listBooks, saveBook, type SavedBook } from "./books.ts";
import { textFromFile } from "./fileText.ts";
import { getImport, setDraft, setImport } from "./importState.ts";
import { useUserData } from "./store.tsx";
import { BackLink, Field, NumberInput, Section, go, useEngine, type Engine } from "./ui.tsx";

// ---------- Import ----------

/** Puts a recipe's text through the reader and opens the review screen. Returns problems, if any. */
function startReview(text: string, src: { kind: RecipeSource["kind"]; fileName?: string }): string[] {
  const isAi = looksLikeAiBlock(text);
  let parsed: ParsedRecipe;
  if (isAi) {
    const r = parseAiBlock(text);
    if (!r.ok) return r.problems;
    parsed = r.recipe;
  } else {
    parsed = parseRecipeText(text);
    if (parsed.ingredients.length === 0 && parsed.steps.length === 0) {
      return ["No recipe found in this text. Paste the whole recipe, including the ingredient list."];
    }
  }
  const source: RecipeSource = { kind: isAi ? "ai" : src.kind, text, importedAt: new Date().toISOString() };
  if (src.fileName) source.fileName = src.fileName;
  setImport({ parsed, source });
  go("/import/review");
  return [];
}

export function ImportScreen(): ReactElement {
  const [text, setText] = useState("");
  const [showText, setShowText] = useState(false);
  const [progress, setProgress] = useState<{ name: string; page: number; pages: number } | null>(null);
  const [error, setError] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [books, setBooks] = useState<SavedBook[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void listBooks().then(setBooks).catch(() => setBooks([]));
    return () => abort.current?.abort();
  }, []);

  const read = (t: string, src: { kind: RecipeSource["kind"]; fileName?: string }) => {
    const problems = startReview(t, src);
    if (problems.length) {
      setError(problems);
      setText(t);
      setShowText(true);
    }
  };

  const openFile = async (f: File) => {
    setError([]);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress({ name: f.name, page: 0, pages: 0 });
    try {
      const r = await textFromFile(f, (p) => setProgress({ name: f.name, page: p.page, pages: p.pages }), ctl.signal);
      if (r.kind !== "pdf") return read(r.text, { kind: r.kind, fileName: f.name });
      const found = findRecipes(r.pages);
      if (found.length === 1) return read(found[0]!.text, { kind: "pdf", fileName: f.name });
      if (found.length === 0) return read(r.pages.join("\n\n"), { kind: "pdf", fileName: f.name });
      // A cookbook: keep the list of its recipes and show it.
      const book: SavedBook = { id: bookIdFor(f), name: f.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim(), fileName: f.name, pageCount: r.pages.length, scannedAt: new Date().toISOString(), recipes: found };
      await saveBook(book);
      go(`/import/book/${encodeURIComponent(book.id)}`);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError([e instanceof Error ? e.message : String(e)]);
    } finally {
      setProgress(null);
    }
  };

  const pasteClipboard = async () => {
    setError([]);
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) {
        setShowText(true);
        return setError(["The clipboard is empty. Copy the recipe first, or paste it in the box below."]);
      }
      read(t, { kind: "paste" });
    } catch {
      setShowText(true);
      setError(["Couldn't read the clipboard here. Press and hold in the box below and choose Paste."]);
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
      <p className="lead">Bring in a recipe. You'll check every line before anything is saved.</p>
      <div className="import-options" data-testid="import-paste">
        <button className="import-option" onClick={() => void pasteClipboard()} disabled={progress !== null}>
          <span className="import-option__title">Paste a recipe</span>
          <span className="import-option__hint">Copied from a website, notes, a social post or Live Text</span>
        </button>
        <label className={`import-option${progress ? " import-option--busy" : ""}`}>
          <span className="import-option__title">Open a file</span>
          <span className="import-option__hint">A recipe or a whole cookbook (PDF), Word or text file</span>
          <input type="file" accept=".pdf,.docx,.txt,.text,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Recipe file" disabled={progress !== null} onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = "";
          }} />
        </label>
      </div>

      {progress && (
        <div className="card import-progress" role="status" data-testid="import-progress">
          <p>{progress.pages > 1 ? `Reading page ${progress.page} of ${progress.pages}…` : `Opening ${progress.name}…`}</p>
          <progress max={progress.pages || 1} value={progress.page} />
          {progress.pages > 20 && <p className="footnote">A whole cookbook takes a minute or so. The list of its recipes is kept, so this only happens once.</p>}
          <button className="small-button" onClick={() => abort.current?.abort()}>Stop</button>
        </div>
      )}

      {error.length > 0 && <div className="warning-box" data-testid="import-error">{error.map((p) => <p key={p}>{p}</p>)}</div>}

      {showText || text ? (
        <section className="section">
          <div className="card card--form">
            <Field label="Recipe text" hint="Paste or type the recipe: name, servings, ingredients and steps.">
              <textarea className="input input--area input--tall" aria-label="Recipe text" value={text} rows={10} autoFocus onChange={(e) => setText(e.target.value)} />
            </Field>
            <button className="primary-action" disabled={!text.trim()} onClick={() => read(text, { kind: "paste" })}>Read recipe</button>
          </div>
        </section>
      ) : (
        <button className="link-button import-type-link" onClick={() => setShowText(true)}>Type or paste the text yourself</button>
      )}

      {books.length > 0 && (
        <section className="section" data-testid="cookbooks">
          <h2 className="section__title">Your cookbooks</h2>
          <div className="card">
            {books.map((b) => (
              <a key={b.id} className="row row--link" href={`#/import/book/${encodeURIComponent(b.id)}`}>
                <span className="row__label">{b.name}<span className="row__sub">{b.recipes.length} recipes</span></span>
                <span className="chevron" aria-hidden="true">›</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <details className="help-fold">
        <summary>From a photo (Live Text)</summary>
        <ol className="steps">
          <li>Open the photo in Photos (or point the Camera at the recipe).</li>
          <li>Tap the Live Text button (the lines-in-a-box icon), then <strong>Select All</strong> and <strong>Copy</strong>.</li>
          <li>Come back here and tap <strong>Paste a recipe</strong>. Handwriting may need a few fixes.</li>
        </ol>
      </details>

      <details className="help-fold" data-testid="ai-shortcut">
        <summary>Use ChatGPT or Claude (optional)</summary>
        <ol className="steps">
          <li>Tap <strong>Copy the AI prompt</strong>.</li>
          <li>In ChatGPT or Claude, paste it and attach the recipe photo, PDF or text.</li>
          <li>Copy the AI's whole reply, come back here and tap <strong>Paste a recipe</strong>.</li>
        </ol>
        <button className="row-button" onClick={() => void copyPrompt()}>{copied ? "Prompt copied ✓" : "Copy the AI prompt"}</button>
        <details className="more more--padded">
          <summary>Show the prompt</summary>
          <pre className="prompt" data-testid="ai-prompt">{AI_PROMPT}</pre>
        </details>
        <p className="footnote">The AI only copies the recipe out. The app checks its reply line by line against its own reading and flags any difference. All the nutrition math is done by the app.</p>
      </details>
    </>
  );
}

// ---------- Cookbook ----------

export function BookScreen({ id }: { id: string }): ReactElement {
  const [book, setBook] = useState<SavedBook | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string[]>([]);
  const { recipes } = useUserData();
  useEffect(() => {
    void getBook(id).then((b) => setBook(b ?? null)).catch(() => setBook(null));
  }, [id]);
  if (book === undefined) return <p className="lead">Loading…</p>;
  if (book === null) {
    return (
      <>
        <BackLink href="#/import">Import</BackLink>
        <p className="lead">This cookbook isn't saved on this phone. Open the PDF again from the Import tab.</p>
      </>
    );
  }
  const imported = new Set(recipes.map((r) => `${r.recipe.source?.fileName ?? ""}|${r.recipe.name.toLowerCase()}`));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = book.recipes.filter((r) => words.every((w) => r.title.toLowerCase().includes(w)));
  const pick = (r: BookRecipe) => {
    const problems = startReview(r.text, { kind: "pdf", fileName: book.fileName });
    if (problems.length) setError(problems);
  };
  return (
    <>
      <BackLink href="#/import">Import</BackLink>
      <p className="lead">{book.recipes.length} recipes found in {book.pageCount} pages. Tap one to import it.</p>
      <input className="input search" type="search" aria-label="Search recipes" placeholder="Search recipes" value={query} onChange={(e) => setQuery(e.target.value)} />
      {error.length > 0 && <div className="warning-box">{error.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="card" data-testid="book-recipes">
        {shown.map((r) => (
          <button key={r.pages.join("-")} className="row row--link row--button" onClick={() => pick(r)}>
            <span className="row__label">
              {r.title}
              <span className="row__sub">
                {r.pages.length > 1 ? `Pages ${r.pages[0]}–${r.pages.at(-1)}` : `Page ${r.pages[0]}`}
                {r.printed ? ` · book says ${r.printed.kcal} kcal${r.printed.per === "recipe" ? " in total" : " per serving"}` : ""}
                {imported.has(`${book.fileName}|${r.title.toLowerCase()}`) ? " · ✓ in My Recipes" : ""}
              </span>
            </span>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
        ))}
        {shown.length === 0 && <p className="empty">No recipe matches “{query}”.</p>}
      </div>
      <p className="footnote">Only the recipe text is kept on this phone, not the PDF.</p>
      <button className="link-button link-button--danger" onClick={() => void deleteBook(book.id).then(() => go("/import"))}>Remove this cookbook from the list</button>
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

function resolveRow(r: Row, engine: Engine) {
  const food = typeof r.choice === "number" && engine.db.has(r.choice) ? engine.db.get(r.choice) : null;
  const q = r.choice === "out" ? null : quantityFor(r.parsed, food);
  const quantity = r.override ?? q?.quantity ?? null;
  return { food, q, quantity };
}

/** A line the app is sure about: food and amount found, nothing to fix, not a stand-in. These start ticked. */
function isSure(r: Row, engine: Engine): boolean {
  const res = resolveRow(r, engine);
  return r.choice !== "out" && !r.parsed.flags.some((f) => f.severity === "fix") && !approximateNote(r.parsed.name) && !!res.food && !!res.quantity;
}

function initialRows(parsed: ParsedRecipe, engine: Engine): Row[] {
  return parsed.ingredients.map((p) => {
    const top = p.name ? suggestFoods(p.name, engine.db, 1, wantFor(p))[0] : undefined;
    const row: Row = { parsed: p, choice: top ? top.fdcId : null, override: null, confirmed: false, search: "" };
    return { ...row, confirmed: isSure(row, engine) };
  });
}

/** Check notes that only describe how the text was tidied; not worth showing on a line that looks right. */
const QUIET_FLAGS = new Set(["joined_line", "combined", "ocr_fix", "letter_unit", "split_line"]);

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

  const resolved = rows.map((r) => resolveRow(r, engine));
  const [showSure, setShowSure] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const included = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.choice !== "out");
  const blockers: string[] = [];
  if (!title.trim()) blockers.push("Enter the recipe name.");
  if (!(servings !== null && Number.isInteger(servings) && servings >= 1)) blockers.push("Enter how many servings the recipe makes (a whole number).");
  if (steps.filter((s) => s.trim()).length === 0) blockers.push("Add at least one step.");
  if (included.length === 0) blockers.push("Keep at least one ingredient.");
  const isDone = (r: Row, i: number) => (r.choice === "out" ? r.confirmed : r.confirmed && !!resolved[i]!.food && !!resolved[i]!.quantity);
  const needIdx = rows.map((_, i) => i).filter((i) => !isDone(rows[i]!, i));
  const doneIdx = rows.map((_, i) => i).filter((i) => isDone(rows[i]!, i));
  const assumed = doneIdx.filter((i) => rows[i]!.choice !== "out" && rows[i]!.parsed.flags.some((f) => !QUIET_FLAGS.has(f.code))).length;
  if (needIdx.length > 0) blockers.push(`${needIdx.length} ${needIdx.length === 1 ? "line needs" : "lines need"} you above.`);

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
        usedInSteps: stepsMentioning(r.parsed.name, cleanSteps, r.parsed.group),
        confirmed: notes,
      }];
    });
    const id = recipeIdFor(title.trim(), new Set(recipes.map((r) => r.id)));
    const draft = recipeFromImport({ id, title: title.trim(), servings: servings!, lines, steps: cleanSteps, notes: parsed.notes, source });
    // What the recipe says about itself, shown next to the app's numbers on the report.
    const pr = parsed.printed;
    if (pr && pr.protein !== null && pr.carbs !== null && pr.fat !== null) {
      const div = pr.per === "recipe" ? servings! : 1;
      draft.printedPerServing = { kcal: Math.round(pr.kcal / div), protein: Math.round((pr.protein / div) * 10) / 10, carbs: Math.round((pr.carbs / div) * 10) / 10, fat: Math.round((pr.fat / div) * 10) / 10 };
    }
    setDraft(draft);
    setImport(null);
    go("/recipes/new");
  };

  return (
    <>
      <BackLink href="#/import">Import</BackLink>
      <p className="lead">{needIdx.length === 0 ? "Everything was read. Glance over it and continue." : `${needIdx.length} ${needIdx.length === 1 ? "line needs" : "lines need"} you. The rest look right.`}</p>
      {parsed.flags.length > 0 && <FlagList flags={parsed.flags} testId="recipe-flags" />}
      <div className="card card--form review-head">
        <Field label="Name"><input className="input" aria-label="Recipe name" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Servings the recipe makes"><NumberInput label="Servings" inputMode="numeric" value={servings} onChange={setServings} /></Field>
      </div>

      <section className="section" data-testid="review-ingredients">
        {needIdx.length > 0 && (
          <>
            <h2 className="section__title">Needs you ({needIdx.length})</h2>
            <div className="card" data-testid="review-needs">
              {needIdx.map((i) => (
                <ReviewRow key={i} index={i} row={rows[i]!} resolved={resolved[i]!} engine={engine} onChange={(p) => setRow(i, p)} />
              ))}
            </div>
          </>
        )}
        {doneIdx.length > 0 && (
          <div className="card sure" data-testid="review-sure">
            <button className="row row--button fold-head" aria-expanded={showSure} onClick={() => setShowSure(!showSure)}>
              <span className="fold-head__title">✓ {doneIdx.length} {doneIdx.length === 1 ? "line looks" : "lines look"} right</span>
              <span className="fold-head__sub">{assumed > 0 ? `${assumed} with a standard amount or a note · ` : ""}{showSure ? "Hide" : "Show"}</span>
            </button>
            {showSure && doneIdx.map((i) => {
              const r = rows[i]!;
              const out = r.choice === "out";
              const notes = out ? [] : r.parsed.flags.filter((f) => !QUIET_FLAGS.has(f.code));
              return (
                <button key={i} className="sure-row" data-testid={`review-row-${i}`} onClick={() => setRow(i, { confirmed: false, ...(out ? { choice: null } : {}) })}>
                  <span className="sure-row__line">{r.parsed.raw}</span>
                  <span className="sure-row__food">{out ? "Left out" : resolved[i]!.food!.description}</span>
                  {notes.map((f, k) => <span key={k} className="sure-row__note">{f.message}</span>)}
                </button>
              );
            })}
            {showSure && <p className="footnote sure__foot">Tap a line to change it.</p>}
          </div>
        )}
      </section>

      <section className="section" data-testid="review-steps">
        <div className="card">
          <button className="row row--button fold-head" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}>
            <span className="fold-head__title">Instructions ({steps.filter((x) => x.trim()).length} {steps.filter((x) => x.trim()).length === 1 ? "step" : "steps"})</span>
            <span className="fold-head__sub">{showSteps ? "Hide" : "Show or edit"}</span>
          </button>
        </div>
        {showSteps && (
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
        )}
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
  return (
    <div className="review-row" data-testid={`review-row-${index}`}>
      <p className="review-row__raw">{p.group ? <span className="badge badge--muted badge--inline-left">{p.group}</span> : null}{p.raw}</p>
      {p.flags.length > 0 && <FlagList flags={p.flags} />}
      {!out && approximateNote(p.name) && <FlagList flags={[{ code: "unusual", severity: "check", message: approximateNote(p.name)! }]} />}
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
              {resolved.q.options.length > 0 && resolved.q.options.length <= 6 && (
                <div className="chips" role="group" aria-label={`Size ${index + 1}`}>
                  {resolved.q.options.map((o, k) => <button key={k} className="chip" onClick={() => onChange({ override: o.quantity, confirmed: true })}>{o.label}</button>)}
                </div>
              )}
              {resolved.q.options.length > 6 && (
                <select className="input" aria-label={`Size ${index + 1}`} value="" onChange={(e) => {
                  const o = resolved.q!.options[Number(e.target.value)];
                  if (o) onChange({ override: o.quantity, confirmed: true });
                }}>
                  <option value="">Choose a USDA size</option>
                  {resolved.q.options.map((o, k) => <option key={k} value={k}>{o.label}</option>)}
                </select>
              )}
              <GramsEntry index={index} onSet={(g) => onChange({ override: { kind: "mass", amount: g, unit: "g" }, confirmed: true })} />
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
