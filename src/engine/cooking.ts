/**
 * The cookable recipe: the original steps with each ingredient's amount
 * written in where the step first uses it, e.g. "combine chicken breast
 * (1 lb 9 oz) with soy sauce (2 Tbsp)". The wording stays the recipe's own;
 * only amounts are added. Amounts come from the recipe being shown (the
 * original or a scaled plan), so a scaled plan reads with its new amounts.
 *
 * Each ingredient's amount is written once: in the first step that uses it
 * that another ingredient of the same name hasn't taken ("soy sauce" in the
 * marinade goes in step 1, the second "soy sauce" in the rice step). When the
 * step doesn't name the ingredient (the app worked out where it goes), the
 * amount is listed after the step instead: "Also: avocado oil (1 Tbsp)".
 */
import { stepMentionsLine } from "./audit.ts";
import type { Recipe } from "./recipe.ts";

export type StepPart = { kind: "text"; text: string } | { kind: "amount"; lineId: string };

export interface CookingStep {
  parts: StepPart[];
  /** Ingredients for this step that the wording doesn't name. */
  also: string[];
}

/**
 * Which step carries each line's amount (1-based), or null if none: the first
 * linked step that names it in full ("bell peppers", not the "black pepper" of
 * another line), else the first that names it at all, else the first linked step;
 * a step another line of the same name already took is skipped.
 */
export function amountSteps(recipe: Recipe): Map<string, number | null> {
  const taken = new Map<string, Set<number>>();
  const out = new Map<string, number | null>();
  for (const line of recipe.lines) {
    const steps = (line.usedInSteps ?? []).filter((n) => n >= 1 && n <= recipe.steps.length);
    const key = line.name.toLowerCase().trim();
    const used = taken.get(key) ?? new Set<number>();
    const open = steps.filter((n) => !used.has(n));
    const text = (n: number) => recipe.steps[n - 1]!.text;
    const pick =
      (line.stepsInferred ? undefined : open.find((n) => mentionPass(text(n), line.name, [], true))) ??
      (line.stepsInferred ? undefined : open.find((n) => mentionPass(text(n), line.name, [], false))) ??
      open[0] ?? steps[0] ?? null;
    if (pick !== null) used.add(pick);
    taken.set(key, used);
    out.set(line.id, pick);
  }
  return out;
}

const WORD = /[A-Za-zÀ-ÿ0-9%']+(?:-[A-Za-zÀ-ÿ]+)*/g;

/** Where in the step text the ingredient is named: [start, end) of the run of its words, avoiding spans already taken. */
const QUALIFIER = /^(?:black|white|red|green|yellow|orange|bell|sweet|brown|cayenne|chili|chilli|sesame|olive|coconut|peanut|soy|fish|hot|lemon|lime|garlic|onion|chicken|beef|turkey|pork)$/i;

/** strict: the run must hold every distinctive word of the name ("bell pepper", not just "pepper"). */
function mentionPass(text: string, name: string, taken: [number, number][], strict: boolean): [number, number] | null {
  if (!stepMentionsLine(text, name)) return null;
  const distinctive = (name.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 3 && !/^(?:and|with|the|for|of|or|red|green|yellow|white|black|fresh|large|small|medium|lean|light|low|fat|free|raw|cooked|uncooked|dry|dried|frozen|chopped|diced|sliced|minced|grated|shredded|boneless|skinless)$/.test(w));
  const nameWords = new Set((name.toLowerCase().match(WORD) ?? []).flatMap((w) => [w, w.replace(/(?:es|s)$/, "")]));
  const words = [...text.matchAll(WORD)];
  const same = (w: string) => nameWords.has(w.toLowerCase()) || nameWords.has(w.toLowerCase().replace(/(?:es|s)$/, ""));
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  for (let i = 0; i < words.length; i++) {
    if (!same(words[i]![0]) || !stepMentionsLine(words[i]![0], name)) continue;
    // Back up and run forward over the ingredient's own words ("sauce" → "soy sauce").
    let s0 = i;
    while (s0 > 0 && same(words[s0 - 1]![0]) && text.slice(words[s0 - 1]!.index! + words[s0 - 1]![0].length, words[s0]!.index!).trim() === "") s0--;
    let j = i;
    while (j + 1 < words.length && same(words[j + 1]![0]) && text.slice(words[j]!.index! + words[j]![0].length, words[j + 1]!.index!).trim() === "") j++;
    // A run followed by another food word belongs to that food ("egg" in "egg whites" isn't the eggs).
    const start = words[s0]!.index!;
    const end = words[j]!.index! + words[j]![0].length;
    const nextWord = words[j + 1];
    const glued = nextWord && text.slice(end, nextWord.index!).trim() === "" && /^(?:whites?|yolks?|noodles|sauce|paste|powder|oil|juice|stock|broth|milk|cream|cheese|butter|flakes|seeds)$/i.test(nextWord[0]) && !same(nextWord[0]);
    const run = text.slice(start, end).toLowerCase();
    const prev = words[s0 - 1];
    const qualified = prev && text.slice(prev.index! + prev[0].length, start).trim() === "" && QUALIFIER.test(prev[0]) && !same(prev[0]);
    const covers = distinctive.every((w) => new RegExp(`\\b${w.replace(/(?:es|s)$/, "")}`).test(run));
    if (glued || qualified || !free(start, end) || (strict && !covers)) {
      i = j;
      continue;
    }
    return [start, end];
  }
  return null;
}

const DIVIDE = /\b((?:divide|split|portion|distribute|share)\w*\b[^.]*?\b(?:into|between|among)\s+)(\d+)(\s+(?:equal\s+)?(?:portions|containers|servings|meals|bowls|boxes|parts|equal))/i;

export function cookingSteps(recipe: Recipe, containers = recipe.portions): CookingStep[] {
  const where = amountSteps(recipe);
  return recipe.steps.map((step, si) => {
    const n = si + 1;
    // "Divide into 5 portions" follows the plan's number of containers.
    const text = step.text.replace(DIVIDE, (_m, a: string, num: string, b: string) => `${a}${num === String(containers) ? num : String(containers)}${b}`);
    // Longer names first, so "egg whites" claims its words before "eggs".
    const here = recipe.lines.filter((l) => where.get(l.id) === n).sort((a, b) => b.name.split(/\s+/).length - a.name.split(/\s+/).length);
    const inserts: { at: number; lineId: string }[] = [];
    const taken: [number, number][] = [];
    const also: string[] = [];
    // Full-name matches for every ingredient first, then single words, so "pepper" goes to the black pepper.
    const placed = new Set<string>();
    for (const strict of [true, false]) {
      for (const line of here) {
        if (placed.has(line.id) || line.stepsInferred) continue;
        const span = mentionPass(text, line.name, taken, strict);
        if (span) {
          taken.push(span);
          inserts.push({ at: span[1], lineId: line.id });
          placed.add(line.id);
        }
      }
    }
    for (const line of here) if (!placed.has(line.id)) also.push(line.id);
    inserts.sort((a, b) => a.at - b.at);
    const parts: StepPart[] = [];
    let pos = 0;
    for (const ins of inserts) {
      parts.push({ kind: "text", text: text.slice(pos, ins.at) });
      parts.push({ kind: "amount", lineId: ins.lineId });
      pos = ins.at;
    }
    parts.push({ kind: "text", text: text.slice(pos) });
    // Keep the recipe's order for the extra list.
    also.sort((a, b) => recipe.lines.findIndex((l) => l.id === a) - recipe.lines.findIndex((l) => l.id === b));
    return { parts: parts.filter((p) => p.kind !== "text" || p.text !== ""), also };
  });
}

/** True when some step already says how to divide the batch. */
export function stepsDivide(recipe: Recipe): boolean {
  return recipe.steps.some((s) => DIVIDE.test(s.text));
}
