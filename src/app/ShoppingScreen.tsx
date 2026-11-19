// The combined shopping list: the recipes you've added (each at the plan you
// picked), merged into one list by store section, ticked off as you shop.
import { useMemo, type ReactElement } from "react";
import {
  buildShoppingList,
  calculateRecipe,
  combineRecipes,
  optimizeRecipe,
  type Recipe,
  type Settings,
  type ShoppingItem,
  type ShoppingSelection,
} from "../engine/index.ts";
import { imperial, weight } from "./format.ts";
import { CookView, analyse, buyText, cookText, perPortionOf, prepared } from "./RecipeReport.tsx";
import { useUserData } from "./store.tsx";
import { BackLink, useEngine, type Engine } from "./ui.tsx";

const EMPTY: ShoppingSelection = { entries: [], checked: [] };

export function useShopping(): {
  selection: ShoppingSelection;
  has: (recipeId: string) => ShoppingSelection["entries"][number] | undefined;
  add: (recipeId: string, presetId: string | null) => Promise<void>;
  remove: (recipeId: string) => Promise<void>;
  toggle: (key: string) => Promise<void>;
  clearTicks: () => Promise<void>;
  clearAll: () => Promise<void>;
} {
  const { settings, saveSettings } = useUserData();
  const selection = settings.shopping ?? EMPTY;
  const save = (s: ShoppingSelection) => saveSettings({ ...settings, shopping: s });
  return {
    selection,
    has: (id) => selection.entries.find((e) => e.recipeId === id),
    // One entry per recipe: adding it again with another plan replaces the plan.
    add: (id, presetId) => save({ ...selection, entries: [...selection.entries.filter((e) => e.recipeId !== id), { recipeId: id, presetId }] }),
    remove: (id) => save({ ...selection, entries: selection.entries.filter((e) => e.recipeId !== id) }),
    toggle: (key) => save({ ...selection, checked: selection.checked.includes(key) ? selection.checked.filter((k) => k !== key) : [...selection.checked, key] }),
    clearTicks: () => save({ ...selection, checked: [] }),
    clearAll: () => save(EMPTY),
  };
}

interface Planned {
  recipeId: string;
  name: string;
  planLabel: string;
  containers: number;
  recipe: Recipe;
  note: string | null;
  /** Notes for following the steps, e.g. a swap ("Use chicken breast wherever the steps say thighs"). */
  stepNotes: string[];
}

/** Each entry's recipe at its plan's amounts (preferences applied); the original if the plan can't be met. */
export function plannedRecipes(selection: ShoppingSelection, recipes: { id: string; recipe: Recipe }[], settings: Settings, engine: Engine): Planned[] {
  return selection.entries.flatMap((e) => {
    const saved = recipes.find((r) => r.id === e.recipeId);
    if (!saved) return [];
    const base = prepared(saved.recipe, settings).recipe;
    const preset = e.presetId ? settings.presets.find((p) => p.id === e.presetId) : undefined;
    if (!preset) return [{ recipeId: saved.id, name: saved.recipe.name, planLabel: "Original amounts", containers: base.portions, recipe: base, note: null, stepNotes: [] }];
    try {
      const r = optimizeRecipe(base, preset, engine.db, { bounds: settings.bounds });
      const plan = r.ok ? r.plan : r.options.find((o) => o.keepsTargets)?.plan;
      if (plan) {
        const note = r.ok ? null : `Uses the option "${r.options.find((o) => o.plan === plan)?.title}" to meet the plan.`;
        return [{ recipeId: saved.id, name: saved.recipe.name, planLabel: `${preset.kcal} kcal`, containers: plan.recipe.portions, recipe: plan.recipe, note, stepNotes: plan.stepNotes.filter((n) => !/^Divide into /.test(n)) }];
      }
      return [{ recipeId: saved.id, name: saved.recipe.name, planLabel: "Original amounts", containers: base.portions, recipe: base, note: `Can't meet the ${preset.kcal} kcal plan, so the original amounts are used.`, stepNotes: [] }];
    } catch {
      return [{ recipeId: saved.id, name: saved.recipe.name, planLabel: "Original amounts", containers: base.portions, recipe: base, note: "Couldn't scale this one, so the original amounts are used.", stepNotes: [] }];
    }
  });
}

export function listText(planned: Planned[], items: ShoppingItem[]): string {
  const out: string[] = ["Shopping list", "", ...planned.map((p) => `• ${p.name} (${p.planLabel}, ${p.containers} containers)`), ""];
  let last = "";
  for (const i of items.filter((x) => x.buy.kind !== "pantry")) {
    if (i.category !== last) out.push("", i.category);
    last = i.category;
    out.push(`☐ ${i.name}: ${buyText(i)}`);
  }
  const pantry = items.filter((x) => x.buy.kind === "pantry");
  if (pantry.length) out.push("", "Check you have", ...pantry.map((i) => `☐ ${i.name}`));
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function shareText(title: string, text: string): Promise<"shared" | "copied" | "failed"> {
  try {
    if (navigator.share) {
      await navigator.share({ title, text });
      return "shared";
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "shared";
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

export function ShoppingScreen(): ReactElement {
  const { settings, recipes } = useUserData();
  const { engine } = useEngine();
  const shop = useShopping();
  const { selection } = shop;
  const built = useMemo(() => {
    if (!engine || selection.entries.length === 0) return null;
    const planned = plannedRecipes(selection, recipes, settings, engine);
    if (planned.length === 0) return null;
    const merged = combineRecipes(planned.map((p) => p.recipe));
    const list = buildShoppingList(merged, calculateRecipe(merged, engine.db), engine.db, engine.yields, settings.packages);
    return { planned, items: list.items };
  }, [engine, selection, recipes, settings]);

  if (selection.entries.length === 0) {
    return (
      <div className="empty-state" data-testid="shopping-empty">
        <p className="lead">Your shopping list is empty.</p>
        <p className="lead">Open a recipe, pick a plan (like 750 kcal), and tap <strong>Add to shopping list</strong>. Add as many recipes as you're prepping, and their ingredients are combined here.</p>
        <a className="primary-action" href="#/recipes">Go to My Recipes</a>
      </div>
    );
  }
  if (!built) return <p className="lead">Making your list…</p>;
  const toBuy = built.items.filter((i) => i.buy.kind !== "pantry");
  const pantry = built.items.filter((i) => i.buy.kind === "pantry");
  const done = toBuy.filter((i) => selection.checked.includes(i.key)).length;
  let last = "";
  return (
    <>
      <section className="section" data-testid="shopping-recipes">
        <h2 className="section__title">Prepping ({built.planned.length})</h2>
        <div className="card">
          {built.planned.map((p) => (
            <div key={p.recipeId} className="row">
              <a className="row__label" href={`#/recipes/${encodeURIComponent(p.recipeId)}`}>
                {p.name}
                <span className="row__sub">{p.planLabel} · {p.containers} containers{p.note ? ` · ${p.note}` : ""}</span>
              </a>
              <button className="small-button" aria-label={`Remove ${p.name}`} onClick={() => void shop.remove(p.recipeId)}>Remove</button>
            </div>
          ))}
        </div>
      </section>

      <section className="section" data-testid="shopping-items">
        <h2 className="section__title">To buy ({done} of {toBuy.length} ticked)</h2>
        <div className="card">
          {toBuy.map((item) => {
            const head = item.category !== last ? <div className="list-head">{item.category}</div> : null;
            last = item.category;
            const on = selection.checked.includes(item.key);
            return (
              <div key={item.key}>
                {head}
                <label className={`shop-row${on ? " shop-row--done" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => void shop.toggle(item.key)} aria-label={item.name} />
                  <span className="shop-row__name">{item.name}<span className="shop-row__sub">uses {weight(item.usableGrams)}{item.buy.kind === "package" && item.buy.leftoverGrams > 0.5 ? ` · ${imperial(item.buy.leftoverGrams)} left over` : ""}</span></span>
                  <span className="shop-row__buy">{buyText(item)}</span>
                </label>
              </div>
            );
          })}
        </div>
      </section>

      {pantry.length > 0 && (
        <details className="more more--section fold" data-testid="shopping-pantry">
          <summary>Check you have these ({pantry.length})</summary>
          <div className="card">
            {pantry.map((item) => (
              <div key={item.key} className="row"><span className="row__label">{item.name}</span><span className="row__value">{buyText(item)}</span></div>
            ))}
          </div>
        </details>
      )}

      <a className="primary-action" href="#/shopping/package" data-testid="send-to-cook">Share recipe package</a>
      <p className="footnote footnote--tight">This shopping list plus every recipe with its amounts, in one PDF to print or send.</p>

      <div className="actions actions--center">
        <button className="action" onClick={() => void shareText("Shopping list", listText(built.planned, built.items)).then((r) => r === "copied" && alertCopied())}>Share list</button>
        {selection.checked.length > 0 && <button className="action" onClick={() => void shop.clearTicks()}>Untick all</button>}
        <button className="action action--danger" onClick={() => { if (window.confirm("Clear the shopping list? Your recipes stay saved.")) void shop.clearAll(); }}>Clear list</button>
      </div>
      <p className="footnote">Package sizes are typical U.S. sizes. Change them under Settings → Packages if your store's differ.</p>
    </>
  );
}

function alertCopied(): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = "Copied. Paste it into Notes or Messages.";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

/**
 * Everything someone else needs to shop and cook: what's being prepped, the
 * combined shopping list, then each recipe with its amounts written into the
 * steps. Send it as one message, or print / save it as a PDF.
 */
export function PackageScreen(): ReactElement {
  const { settings, recipes } = useUserData();
  const { engine } = useEngine();
  const { selection } = useShopping();
  const built = useMemo(() => {
    if (!engine || selection.entries.length === 0) return null;
    const planned = plannedRecipes(selection, recipes, settings, engine);
    if (planned.length === 0) return null;
    const merged = combineRecipes(planned.map((p) => p.recipe));
    const list = buildShoppingList(merged, calculateRecipe(merged, engine.db), engine.db, engine.yields, settings.packages);
    const cooked = planned.map((p) => {
      const data = analyse(p.recipe, engine, settings, undefined);
      return { p, data, perMeal: perPortionOf(data.calc) };
    });
    return { planned, items: list.items, cooked };
  }, [engine, selection, recipes, settings]);

  if (selection.entries.length === 0) return <><BackLink href="#/shopping">Shopping List</BackLink><p className="lead">Add recipes to your shopping list first.</p></>;
  if (!built) return <p className="lead">Putting it together…</p>;
  const text = () =>
    [
      `Meal prep: ${built.planned.length} ${built.planned.length === 1 ? "recipe" : "recipes"}`,
      "",
      listText(built.planned, built.items),
      ...built.cooked.flatMap(({ p, data, perMeal }) => ["", "────────", "", cookText(data, perMeal, p.stepNotes)]),
    ].join("\n");
  const toBuy = built.items.filter((i) => i.buy.kind !== "pantry");
  const pantry = built.items.filter((i) => i.buy.kind === "pantry");
  let last = "";
  return (
    <div className="package" data-testid="package">
      <div className="no-print">
        <BackLink href="#/shopping">Shopping List</BackLink>
        <p className="lead">Everything needed to shop and cook: the shopping list, then each recipe with your amounts in the steps, each on its own page.</p>
        <button className="primary-action" data-testid="package-print" onClick={() => window.print()}>Print or save as PDF</button>
        <p className="footnote footnote--tight">On iPhone, tap the Share button at the top of the print screen to send the PDF in Messages, Mail or WhatsApp, or Save to Files.</p>
        <button className="link-button" data-testid="package-share" onClick={() => void shareText("Meal prep", text()).then((r) => r === "copied" && alertCopied())}>Or send it as a text message instead</button>
      </div>

      <section className="section package__part">
        <h2 className="package__title">Prepping</h2>
        <div className="card">
          {built.planned.map((p) => (
            <div key={p.recipeId} className="row"><span className="row__label">{p.name}<span className="row__sub">{p.containers} containers{p.planLabel !== "Original amounts" ? ` · ${p.planLabel} each` : ""}</span></span></div>
          ))}
        </div>
      </section>

      <section className="section package__part" data-testid="package-list">
        <h2 className="package__title">Shopping list</h2>
        <div className="card">
          {toBuy.map((item) => {
            const head = item.category !== last ? <div className="list-head">{item.category}</div> : null;
            last = item.category;
            return (
              <div key={item.key}>
                {head}
                <div className="row"><span className="row__label">☐ {item.name}</span><span className="row__value">{buyText(item)}</span></div>
              </div>
            );
          })}
          {pantry.length > 0 && <div className="list-head">Check you have these</div>}
          {pantry.map((item) => <div key={item.key} className="row"><span className="row__label">☐ {item.name}</span><span className="row__value">{buyText(item)}</span></div>)}
        </div>
      </section>

      {built.cooked.map(({ p, data, perMeal }) => (
        <section key={p.recipeId} className="section package__part package__recipe" data-testid="package-recipe">
          <h2 className="package__title">{p.name}</h2>
          <CookView data={data} perMeal={perMeal} notes={p.stepNotes} forPrint />
        </section>
      ))}
    </div>
  );
}
