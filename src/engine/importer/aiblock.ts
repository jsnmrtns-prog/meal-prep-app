/**
 * The optional AI shortcut. You copy AI_PROMPT into ChatGPT or Claude along
 * with a recipe photo or file; the AI replies with a recipe block; you paste
 * the reply here. The app checks the block strictly, re-reads every
 * ingredient line itself, and flags anywhere the AI's reading differs from
 * its own. The AI is never trusted for nutrition: it only transcribes.
 */
import { normalizeUnit, parseIngredientLine, parseNumber, type ImportFlag, type ParsedIngredient, type ParsedRecipe } from "./parse.ts";

export const AI_BLOCK_FORMAT = "meal-prep-recipe-v1";

export const AI_PROMPT = `Please transcribe the recipe I'm attaching (photo, PDF or text) for my meal-prep app.

Reply with ONLY one JSON code block in exactly this format:

\`\`\`json
{
  "format": "${AI_BLOCK_FORMAT}",
  "title": "Recipe name",
  "servings": 4,
  "ingredients": [
    {
      "original": "1 1/2 cups uncooked white rice",
      "amount": 1.5,
      "amountMax": null,
      "unit": "cup",
      "item": "uncooked white rice",
      "prep": null,
      "group": null,
      "optional": false
    }
  ],
  "steps": ["First step, word for word.", "Second step, word for word."],
  "notes": [],
  "unclear": []
}
\`\`\`

Rules:
- Copy every ingredient line exactly as written into "original", one ingredient per entry, in order.
- "amount" is a number (1/2 → 0.5). For a range like "1-2", put the low number in "amount" and the high one in "amountMax".
- "unit" is the unit as written (g, oz, lb, cup, tbsp, tsp, ml, clove, can, packet…) or null if there is none.
- "item" is the food itself; "prep" is anything like "diced" or "drained"; "group" is the section heading it's under (e.g. "Sauce") or null.
- Never guess. If an amount, unit, servings or step is missing or hard to read, use null and describe it in "unclear".
- Don't convert units, round, add ingredients, or calculate nutrition.
- Copy the steps word for word, one step per entry. Put tips or storage notes in "notes".`;

export type AiBlockResult = { ok: true; recipe: ParsedRecipe } | { ok: false; problems: string[] };

/** Pulls the JSON out of an AI reply (a ```json block, or the outermost { … }). */
export function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  // Curly quotes from some keyboards or copy paths break JSON.
  return body.slice(start, end + 1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** True if the text looks like a reply to AI_PROMPT (so the import screen can route it). */
export function looksLikeAiBlock(text: string): boolean {
  return text.includes(AI_BLOCK_FORMAT);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNumOrNull = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

export function parseAiBlock(text: string): AiBlockResult {
  const json = extractJson(text);
  if (!json) return { ok: false, problems: ["No recipe block found. Paste the AI's whole reply, including the code block."] };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, problems: ["The recipe block isn't valid JSON. Ask the AI to send it again as one JSON code block."] };
  }
  const problems: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, problems: ["The recipe block is empty."] };
  const d = data as Record<string, unknown>;
  if (d.format !== AI_BLOCK_FORMAT) problems.push(`The block doesn't say "format": "${AI_BLOCK_FORMAT}". Use the app's prompt exactly.`);
  if (!(d.title === null || isStr(d.title))) problems.push("Title must be text.");
  if (!(d.servings === null || d.servings === undefined || (typeof d.servings === "number" && Number.isInteger(d.servings) && d.servings > 0))) problems.push("Servings must be a whole number or null.");
  if (!Array.isArray(d.ingredients) || d.ingredients.length === 0) problems.push("No ingredients in the block.");
  if (!Array.isArray(d.steps) || !d.steps.every(isStr)) problems.push("Steps must be a list of text.");
  if (d.notes !== undefined && !(Array.isArray(d.notes) && d.notes.every(isStr))) problems.push("Notes must be a list of text.");
  if (d.unclear !== undefined && !(Array.isArray(d.unclear) && d.unclear.every(isStr))) problems.push("Unclear items must be a list of text.");
  (Array.isArray(d.ingredients) ? d.ingredients : []).forEach((x: unknown, i: number) => {
    const w = `Ingredient ${i + 1}`;
    if (typeof x !== "object" || x === null) return void problems.push(`${w} is damaged.`);
    const g = x as Record<string, unknown>;
    if (!isStr(g.original) || !g.original.trim()) problems.push(`${w}: "original" text is missing.`);
    if (!isStr(g.item) || !g.item.trim()) problems.push(`${w}: "item" is missing.`);
    if (!isNumOrNull(g.amount) || !isNumOrNull(g.amountMax)) problems.push(`${w}: amounts must be numbers or null.`);
    if (!(g.unit === null || g.unit === undefined || isStr(g.unit))) problems.push(`${w}: unit must be text or null.`);
  });
  if (problems.length) return { ok: false, problems };

  const ingredients: ParsedIngredient[] = (d.ingredients as Record<string, unknown>[]).map((g) => {
    const original = (g.original as string).trim();
    const group = isStr(g.group) && g.group.trim() ? g.group.trim() : null;
    // The app reads the line itself; that reading keeps its own flags.
    const own = parseIngredientLine(original, group);
    const aiAmount = typeof g.amount === "number" ? g.amount : null;
    const aiMax = typeof g.amountMax === "number" ? g.amountMax : null;
    const aiUnit = isStr(g.unit) && g.unit.trim() ? normalizeUnit(g.unit) : null;
    const flags: ImportFlag[] = [...own.flags];
    const result: ParsedIngredient = { ...own, flags };
    if (isStr(g.unit) && g.unit.trim() && !aiUnit) {
      flags.push({ code: "ai_mismatch", severity: "fix", message: `The AI gave the unit "${g.unit}", which the app doesn't know. Enter the amount in grams, cups or spoons.` });
    }
    const ownHasAmount = own.amount !== null || own.amountMax !== null;
    const sameUnit = JSON.stringify(own.unit) === JSON.stringify(aiUnit) || (own.unit === null && aiUnit === null);
    const sameAmount = own.amountMax !== null
      ? aiMax !== null && Math.abs(aiMax - own.amountMax) < 1e-9
      : (own.amount === null && aiAmount === null) || (own.amount !== null && aiAmount !== null && Math.abs(own.amount - aiAmount) < 1e-9) || own.packageSize !== null;
    if (ownHasAmount && !(sameAmount && sameUnit)) {
      flags.push({ code: "ai_mismatch", severity: "fix", message: `The AI read this as ${describe(aiAmount, aiMax, g.unit)}, but the app reads ${describe(own.amount ?? own.amountMax, null, own.unit ? (own.unit.kind === "count" ? own.unit.noun : own.unit.unit) : null)}. Check the original.` });
    } else if (!ownHasAmount && aiAmount !== null && !own.flags.some((f) => f.code === "to_taste" || f.code === "unusual")) {
      // The app couldn't read an amount but the AI did: use it, but have you confirm it.
      result.amount = aiAmount;
      result.amountMax = aiMax;
      result.unit = aiUnit;
      result.flags = flags.filter((f) => f.code !== "no_amount");
      result.flags.push({ code: "ai_mismatch", severity: "check", message: `Amount from the AI only (${describe(aiAmount, aiMax, g.unit)}). Check it against the original.` });
    }
    if (g.optional === true && !result.optional) {
      result.optional = true;
      result.flags.push({ code: "optional", severity: "check", message: "Marked optional: decide whether to include it." });
    }
    return result;
  });

  const steps = (d.steps as string[]).map((s) => s.trim()).filter(Boolean);
  const notes = ((d.notes as string[] | undefined) ?? []).map((s) => s.trim()).filter(Boolean);
  const flags: ImportFlag[] = ((d.unclear as string[] | undefined) ?? []).filter((u) => u.trim()).map((u) => ({ code: "ai_unclear" as const, severity: "check" as const, message: `The AI wasn't sure: ${u.trim()}` }));
  const title = isStr(d.title) && d.title.trim() ? d.title.trim() : null;
  const servings = typeof d.servings === "number" ? d.servings : null;
  if (!title) flags.push({ code: "no_title", severity: "fix", message: "No recipe name found: enter one." });
  if (servings === null) flags.push({ code: "no_servings", severity: "fix", message: "How many servings the recipe makes wasn't found: enter it." });
  if (steps.length === 0) flags.push({ code: "no_steps", severity: "fix", message: "No instructions found: add them." });
  return { ok: true, recipe: { title, servings, ingredients, steps, notes, flags, printed: null } };
}

function describe(amount: number | null, max: number | null, unit: unknown): string {
  const n = (x: number) => `${Math.round(x * 1000) / 1000}`;
  const a = amount === null ? "no amount" : max !== null ? `${n(amount)}–${n(max)}` : n(amount);
  return `${a}${isStr(unit) && unit ? ` ${unit}` : ""}`;
}

void parseNumber;
