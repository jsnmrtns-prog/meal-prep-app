/**
 * Finds the recipes in a whole cookbook (one text per page) so the app can
 * list them and import one at a time. Handles the layouts seen in real meal
 * prep cookbooks:
 *   - one recipe per page;
 *   - a two-page spread, with the name, servings and nutrition on the left
 *     page and the ingredients and steps on the right;
 *   - a recipe whose steps carry on to the next page.
 * Pages that aren't recipes (introductions, contents, shopping guides) are left out.
 */
import { parseRecipeText, findPrintedNutrition, type PrintedMacros } from "./parse.ts";

export interface BookRecipe {
  /** The recipe's name, or "Recipe on page N" when the book doesn't print one. */
  title: string;
  /** Book page numbers (1-based) the recipe was read from. */
  pages: number[];
  /** The recipe's text, ready for the importer. */
  text: string;
  servings: number | null;
  ingredientCount: number;
  printed: PrintedMacros | null;
}

interface PageInfo {
  page: number;
  text: string;
  title: string | null;
  ingredients: number;
  steps: number;
  hasIngredientHeading: boolean;
  printed: PrintedMacros | null;
}

const INGREDIENT_HEADING = /^\s*(?:[•–\-*]\s*)?(?:ingredients?|what you(?:'|’)?ll need)\b/im;
const STEP_HEADING = /^\s*(?:instructions?|directions?|method|how to make(?: it)?|steps?|preparation)\b\s*:?\s*$/im;

function inspect(page: number, text: string): PageInfo {
  const r = parseRecipeText(text);
  return {
    page,
    text,
    title: r.title,
    // Count only real lines: a nutrition panel's "53g" has no food name.
    ingredients: r.ingredients.filter((x) => /[a-z]{3}/i.test(x.name)).length,
    steps: r.steps.length,
    hasIngredientHeading: INGREDIENT_HEADING.test(text),
    printed: r.printed,
  };
}

/** A page with a recipe's ingredients on it. */
const isRecipePage = (p: PageInfo) => p.ingredients >= 3 && (p.steps >= 1 || p.hasIngredientHeading);

/** A short page that introduces the recipe on the next page: a name and usually its nutrition, no ingredient list. */
function isIntroPage(p: PageInfo): boolean {
  return !isRecipePage(p) && !p.hasIngredientHeading && p.title !== null && p.text.length < 1500 && (p.printed !== null || /\b(?:serving|makes|serves)\b/i.test(p.text));
}

const PAGE_OF = /\bpage \d+ of \d+\b/i;
/** Print clutter at the foot of a web page: the address, the date it was printed, "Page 1 of 2". */
const PRINT_FOOTER = /^\s*(?:https?:\/\/\S+|www\.\S+|\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}[:\s]\d{2}\s*[ap]m|page \d+ of \d+|[:.]?)\s*$/i;

const trimFooter = (text: string) => {
  const lines = text.split("\n");
  while (lines.length && PRINT_FOOTER.test(lines.at(-1)!)) lines.pop();
  return lines;
};

const STEP_START = /^\s*(?:step\s*1\b|1\s*[.)]\s|(?:instructions?|directions?|method|how to make(?: it)?|preparation)\s*:?\s*$)/i;

/**
 * Joins a page whose two columns (ingredients on the left, steps on the right) carry on to the next
 * page: the next page's ingredient lines go after this page's ingredients, the rest after its steps.
 */
function continueColumns(first: string, second: string): string {
  const head = trimFooter(first);
  const blocks = trimFooter(second).join("\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const ingredients: string[] = [];
  const rest: string[] = [];
  for (const b of blocks) {
    const r = parseRecipeText(`Ingredients\n${b}`);
    if (rest.length === 0 && r.ingredients.length >= 2 && r.steps.length === 0) ingredients.push(b);
    else rest.push(b);
  }
  const at = head.findIndex((l) => STEP_START.test(l));
  if (ingredients.length && at > 0) head.splice(at, 0, ...ingredients, "");
  else rest.unshift(...ingredients);
  // The step cut off at the foot of the page goes on with the first lines over the page.
  return `${head.join("\n").replace(/\s+$/, "")}\n${rest.join("\n\n")}`;
}

/** A page that only carries on the steps of the page before. */
const isContinuation = (p: PageInfo) => !p.hasIngredientHeading && p.ingredients < 3 && (p.steps >= 1 || STEP_HEADING.test(p.text) || /^\s*[»>]*\s*continued?\b/im.test(p.text));

/**
 * Lines repeated at the top or bottom of many pages ("THE MEAL PREP COOK BOOK",
 * "Return to Table of Contents") are the book's own headers and footers.
 */
function runningLines(pageTexts: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const t of pageTexts) {
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of new Set([...lines.slice(0, 2), ...lines.slice(-2)])) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const min = Math.max(3, Math.ceil(pageTexts.length * 0.3));
  return new Set([...counts].filter(([l, n]) => n >= min && l.length > 3 && !/^\d+$/.test(l)).map(([l]) => l));
}

export function findRecipes(pageTexts: string[]): BookRecipe[] {
  const running = runningLines(pageTexts);
  const cleaned = pageTexts.map((t) => t.split("\n").filter((l) => !running.has(l.trim())).join("\n"));
  const pages = cleaned.map((t, i) => inspect(i + 1, t));
  const out: BookRecipe[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    if (!isRecipePage(p)) continue;
    const used: PageInfo[] = [];
    const prev = pages[i - 1];
    // The left page of a spread: its name and nutrition belong to this recipe.
    if (prev && isIntroPage(prev) && (p.title === null || p.printed === null) && !out.some((r) => r.pages.includes(prev.page))) used.push(prev);
    used.push(p);
    const next = pages[i + 1];
    let text: string;
    if (next && p.steps === 0 && isContinuation(next) && !isIntroPage(next)) {
      used.push(next);
      i++;
      text = used.map((u) => u.text).join("\n\n");
    } else if (next && p.steps > 0 && next.title === null && !next.hasIngredientHeading && !isIntroPage(next) && (PAGE_OF.test(p.text) || /^\s*https?:\/\/\S+\s*$/m.test(p.text))) {
      // A web page printed to PDF: the ingredient and step columns both carry on to the next page.
      used.push(next);
      i++;
      text = continueColumns(used.slice(0, -1).map((u) => u.text).join("\n\n"), next.text);
    } else {
      text = used.map((u) => u.text).join("\n\n");
    }
    // A book's weekly shopping list looks like a long ingredient list, but it isn't a recipe.
    if (/^\s*(?:weekly |the )?(?:shopping\s*list|grocery list)\s*:?\s*$/im.test(text.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n"))) continue;
    const r = parseRecipeText(text);
    // Tips pages and shopping guides can look like ingredient lists; a recipe has both ingredients and steps.
    if (r.ingredients.length < 3 || r.steps.length === 0) continue;
    out.push({
      title: r.title ?? `Recipe on page ${p.page}`,
      pages: used.map((u) => u.page),
      text,
      servings: r.servings,
      ingredientCount: r.ingredients.length,
      printed: r.printed ?? findPrintedNutrition(text),
    });
  }
  return out;
}
