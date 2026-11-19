/**
 * The built-in recipe reader. Turns pasted text (from a website, notes, a
 * PDF or an iPhone Live Text photo) into a title, servings, ingredient lines
 * and steps. It never guesses silently: anything it isn't sure about gets a
 * flag that you check in the review screen before the recipe is saved.
 *
 * Rules, not AI. Same input, same result.
 */

export type ParsedUnit =
  | { kind: "mass"; unit: "g" | "kg" | "oz" | "lb" }
  | { kind: "volume"; unit: "tsp" | "tbsp" | "cup" | "fl_oz" | "ml" | "l" }
  | { kind: "count"; noun: string };

export type FlagCode =
  | "no_amount"
  | "to_taste"
  | "range"
  | "unknown_unit"
  | "letter_unit"
  | "ocr_fix"
  | "amounts_disagree"
  | "package_size"
  | "alternatives"
  | "divided"
  | "optional"
  | "joined_line"
  | "combined"
  | "unusual"
  | "no_title"
  | "no_servings"
  | "no_steps"
  | "no_ingredients"
  | "ai_unclear"
  | "ai_mismatch";

export interface ImportFlag {
  code: FlagCode;
  message: string;
  /** "fix": something must be entered or chosen. "check": confirm the app read it right. */
  severity: "fix" | "check";
}

export interface ParsedIngredient {
  /** The line exactly as it appeared (after joining wrapped lines). */
  raw: string;
  group: string | null;
  amount: number | null;
  /** Upper end when the recipe gives a range ("1–2 cups"). */
  amountMax: number | null;
  unit: ParsedUnit | null;
  /** "large", "medium", "small" when given ("2 large eggs"). */
  sizeWord: string | null;
  name: string;
  prep: string | null;
  optional: boolean;
  /** A stated package size, e.g. "1 (15 oz) can" → 15 oz each. */
  packageSize: { amount: number; unit: "g" | "kg" | "oz" | "lb" } | null;
  flags: ImportFlag[];
}

export interface ParsedRecipe {
  title: string | null;
  servings: number | null;
  ingredients: ParsedIngredient[];
  steps: string[];
  notes: string[];
  flags: ImportFlag[];
}

// ---------- units ----------

const UNIT_WORDS: Record<string, ParsedUnit> = {};
const addUnit = (u: ParsedUnit, ...names: string[]) => names.forEach((n) => (UNIT_WORDS[n] = u));
addUnit({ kind: "mass", unit: "g" }, "g", "gr", "gm", "gms", "gram", "grams", "gramme", "grammes");
addUnit({ kind: "mass", unit: "kg" }, "kg", "kgs", "kilo", "kilos", "kilogram", "kilograms");
addUnit({ kind: "mass", unit: "oz" }, "oz", "ozs", "ounce", "ounces");
addUnit({ kind: "mass", unit: "lb" }, "lb", "lbs", "pound", "pounds", "#", "ib", "ibs"); // "Ib": common text-recognition slip
addUnit({ kind: "volume", unit: "tsp" }, "tsp", "tsps", "teaspoon", "teaspoons", "tspn", "ts");
addUnit({ kind: "volume", unit: "tbsp" }, "tbsp", "tbsps", "tbs", "tbl", "tbls", "tblsp", "tablespoon", "tablespoons", "tbspn");
addUnit({ kind: "volume", unit: "cup" }, "cup", "cups", "c");
addUnit({ kind: "volume", unit: "fl_oz" }, "fl oz", "fl. oz", "fl.oz", "floz", "fluid ounce", "fluid ounces");
addUnit({ kind: "volume", unit: "ml" }, "ml", "mls", "milliliter", "milliliters", "millilitre", "millilitres");
addUnit({ kind: "volume", unit: "l" }, "l", "liter", "liters", "litre", "litres");

/** Count words that act as a unit ("3 cloves garlic", "1 can beans"). */
const COUNT_NOUNS = new Set([
  "clove", "cloves", "can", "cans", "jar", "jars", "packet", "packets", "package", "packages", "pkg", "pkgs",
  "bunch", "bunches", "head", "heads", "stalk", "stalks", "sprig", "sprigs", "slice", "slices", "piece", "pieces",
  "pinch", "pinches", "dash", "dashes", "handful", "handfuls", "stick", "sticks", "bag", "bags", "box", "boxes",
  "container", "containers", "fillet", "fillets", "breast", "breasts", "thigh", "thighs", "envelope", "envelopes",
  "scoop", "scoops", "drop", "drops", "splash", "drizzle", "sheet", "sheets", "leaf", "leaves", "ear", "ears",
]);
const SIZE_WORDS = new Set(["large", "medium", "small", "extra-large", "jumbo", "extra large"]);
/** Count nouns that are vague amounts rather than measurable units. */
const VAGUE = new Set(["pinch", "pinches", "dash", "dashes", "handful", "handfuls", "splash", "drizzle", "drop", "drops"]);

const singular = (noun: string) => {
  const map: Record<string, string> = { leaves: "leaf", boxes: "box", bunches: "bunch", pinches: "pinch", dashes: "dash", pkgs: "package", pkg: "package", packages: "package" };
  if (map[noun]) return map[noun]!;
  return noun.endsWith("s") && !noun.endsWith("ss") ? noun.slice(0, -1) : noun;
};

/** A unit word as written ("Tbsp", "cups", "clove") → the app's unit, or null if unknown. */
export function normalizeUnit(word: string): ParsedUnit | null {
  const w = word.trim().replace(/\.$/, "");
  if (w === "T") return UNIT_WORDS["tbsp"]!;
  if (w === "t") return UNIT_WORDS["tsp"]!;
  const lower = w.toLowerCase();
  if (UNIT_WORDS[lower]) return UNIT_WORDS[lower]!;
  if (/^fl\.?\s*oz$/.test(lower)) return UNIT_WORDS["fl oz"]!;
  if (COUNT_NOUNS.has(lower)) return { kind: "count", noun: singular(lower) };
  return null;
}

// ---------- numbers ----------

const FRACTIONS: Record<string, number> = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, half: 0.5, dozen: 12 };

/** One number at the start of `s`: "1", "1.5", "1/2", "1 1/2", "1½", "½". */
const NUM = String.raw`(?:\d+\s*[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*[.,]\d+|\d+)`;

export function parseNumber(s: string): number | null {
  const t = s.trim().replace(",", ".");
  let m = t.match(/^(\d+)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/);
  if (m) return Number(m[1]) + FRACTIONS[m[2]!]!;
  if (FRACTIONS[t] !== undefined) return FRACTIONS[t]!;
  m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[3]) === 0 ? null : Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[2]) === 0 ? null : Number(m[1]) / Number(m[2]);
  if (/^\d*\.?\d+$/.test(t)) return Number(t);
  return null;
}

// ---------- cleaning ----------

/** Fixes common text-recognition slips in amounts; returns the fixed line and whether anything changed. */
function fixOcr(line: string): { text: string; fixed: boolean } {
  let t = line;
  // "l/2 cup", "1 l/2 cups", "I cup": letter l/I/| read instead of the digit 1, only in the amount position.
  t = t.replace(/^(\s*)([lI|])(\s*\/\s*\d)/, "$11$3");
  t = t.replace(/^(\s*\d+\s+)([lI|])(\s*\/\s*\d)/, "$11$3");
  t = t.replace(/^(\s*)[lI|](\s+(?:cups?|tbsp|tsp|tablespoons?|teaspoons?|lbs?|pounds?|oz|ounces?)\b)/i, "$11$2");
  // "O" for 0 inside a number: "1O oz"
  t = t.replace(/^(\s*\d+)[oO](\s)/, "$10$2");
  return { text: t, fixed: t !== line };
}

const BULLET = /^\s*(?:[-–—•*·▪◦●○▢□☐✓✔➤>]|\[\s?[x ]?\s?\])\s*/i;

function stripBullet(line: string): string {
  return line.replace(BULLET, "").trim();
}

// ---------- one ingredient ----------

/** Reads one ingredient line. */
export function parseIngredientLine(rawLine: string, group: string | null = null): ParsedIngredient {
  const flags: ImportFlag[] = [];
  const raw = stripBullet(rawLine).replace(/\s+/g, " ").trim();
  const ocr = fixOcr(raw);
  if (ocr.fixed) flags.push({ code: "ocr_fix", severity: "check", message: `Read "${raw.split(" ").slice(0, 3).join(" ")}" as "${ocr.text.split(" ").slice(0, 3).join(" ")}". Check the amount.` });
  let rest = ocr.text;

  let optional = false;
  const optMatch = rest.match(/\(\s*optional\s*\)|,?\s*\boptional\b,?/i);
  if (optMatch) {
    optional = true;
    rest = rest.replace(optMatch[0], " ").replace(/\s+/g, " ").replace(/^[:\s]+/, "").trim();
    flags.push({ code: "optional", severity: "check", message: "Marked optional: decide whether to include it." });
  }

  let toTaste = false;
  const tasteMatch = rest.match(/,?\s*\b(to taste|as needed|as desired|for serving|for garnish|if desired)\b/i);
  if (tasteMatch) {
    toTaste = true;
    rest = rest.replace(tasteMatch[0], "").replace(/^[:\s]+/, "").trim();
  }

  // Amount (with an optional range).
  let amount: number | null = null;
  let amountMax: number | null = null;
  const range = rest.match(new RegExp(`^(${NUM})\\s*(?:-|–|—|to|or)\\s*(${NUM})\\b\\s*`, "i"));
  const single = rest.match(new RegExp(`^(${NUM})(?![\\d/])\\s*`));
  const wordNum = rest.match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half|a dozen|dozen)\b\s+/i);
  if (range) {
    amount = parseNumber(range[1]!);
    amountMax = parseNumber(range[2]!);
    rest = rest.slice(range[0].length);
  } else if (single) {
    amount = parseNumber(single[1]!);
    rest = rest.slice(single[0].length);
  } else if (wordNum) {
    const w = wordNum[1]!.toLowerCase().replace("a dozen", "dozen");
    amount = WORD_NUMBERS[w] ?? null;
    rest = rest.slice(wordNum[0].length);
  }

  // A stated package size right after the amount: "1 (15 oz) can", "2 (14.5-ounce) cans".
  let packageSize: ParsedIngredient["packageSize"] = null;
  let altAmount: { amount: number; unit: ParsedUnit } | null = null;

  // Unit.
  let unit: ParsedUnit | null = null;
  let letterUnit: "T" | "t" | null = null;
  const takeUnit = () => {
    const fl = rest.match(/^(fl\.?\s*oz\.?|fluid ounces?)\b\.?\s*/i);
    if (fl) {
      unit = UNIT_WORDS["fl oz"]!;
      rest = rest.slice(fl[0].length);
      return;
    }
    const m = rest.match(/^([A-Za-z#]+)\.?(?=\s|$|\(|,)\s*/);
    if (!m) return;
    const word = m[1]!;
    if (word === "T" || word === "t") {
      unit = word === "T" ? UNIT_WORDS["tbsp"]! : UNIT_WORDS["tsp"]!;
      letterUnit = word;
      rest = rest.slice(m[0].length);
      return;
    }
    if (word === "C") {
      unit = UNIT_WORDS["cup"]!;
      rest = rest.slice(m[0].length);
      return;
    }
    const lower = word.toLowerCase();
    // A lone "l" right before a word is far more often the litre unit than a slip; only for numbers.
    if (UNIT_WORDS[lower] && (lower !== "l" || amount !== null)) {
      if (lower === "ib" || lower === "ibs") flags.push({ code: "ocr_fix", severity: "check", message: `Read "${word}" as pounds. Check the amount.` });
      unit = UNIT_WORDS[lower]!;
      rest = rest.slice(m[0].length);
    }
  };
  if (amount !== null) {
    const pkg = rest.match(new RegExp(`^\\((${NUM})\\s*-?\\s*(oz|ounces?|g|grams?|lbs?|pounds?|kg)\\.?\\)\\s*`, "i"));
    if (pkg) {
      const u = UNIT_WORDS[pkg[2]!.toLowerCase()];
      if (u && u.kind === "mass") packageSize = { amount: parseNumber(pkg[1]!)!, unit: u.unit };
      rest = rest.slice(pkg[0].length);
    }
    takeUnit();
    // Second amount in parentheses: "454 g (16 oz)", "2 cups (300 g)".
    const alt = rest.match(new RegExp(`^\\(\\s*(?:~|about|approx\\.?|approximately)?\\s*(${NUM})\\s*([A-Za-z. ]+?)\\)\\s*`, "i"));
    if (alt) {
      const n = parseNumber(alt[1]!);
      const w = alt[2]!.trim().replace(/\.$/, "").toLowerCase();
      const u = UNIT_WORDS[w] ?? (/^fl\.?\s*oz$/.test(w) ? UNIT_WORDS["fl oz"] : undefined);
      if (n !== null && u) {
        altAmount = { amount: n, unit: u };
        rest = rest.slice(alt[0].length);
      } else if (n !== null && unit && (COUNT_NOUNS.has(w) || COUNT_NOUNS.has(w.split(" ")[0]!))) {
        // "30 g (1 packet)": the weight is what counts; the packet is just a description.
        rest = rest.slice(alt[0].length);
      }
    }
  }

  // Size word and count noun: "2 large eggs", "3 cloves garlic", "1 can black beans".
  let sizeWord: string | null = null;
  const size = rest.match(/^(extra[- ]large|large|medium|small|jumbo)\b\s*/i);
  if (size && amount !== null && !unit) {
    sizeWord = size[1]!.toLowerCase().replace(" ", "-");
    rest = rest.slice(size[0].length);
  }
  if (amount !== null && !unit) {
    const noun = rest.match(/^([A-Za-z]+)\b\.?\s*/);
    if (noun && COUNT_NOUNS.has(noun[1]!.toLowerCase())) {
      const n = noun[1]!.toLowerCase();
      // "2 chicken breasts" keeps "breasts" in the name; only leading nouns are units.
      unit = { kind: "count", noun: singular(n) };
      rest = rest.slice(noun[0].length).replace(/^of\s+/i, "");
      // "1 jar (24 oz.) marinara", "1 can (14.5 oz) tomatoes"
      const pkg = rest.match(new RegExp(`^\\((${NUM})\\s*-?\\s*(oz|ounces?|g|grams?|lbs?|pounds?|kg)\\.?\\)\\s*`, "i"));
      if (pkg && !packageSize) {
        const u = UNIT_WORDS[pkg[2]!.toLowerCase()];
        if (u && u.kind === "mass") packageSize = { amount: parseNumber(pkg[1]!)!, unit: u.unit };
        rest = rest.slice(pkg[0].length);
      }
    }
  }
  // "4 salmon fillets (6 oz each)": a weight for each one.
  const each = rest.match(new RegExp(`\\((${NUM})\\s*-?\\s*(oz|ounces?|g|grams?|lbs?|pounds?)\\.?\\s+each\\)`, "i"));
  if (each && amount !== null && !packageSize) {
    const u = UNIT_WORDS[each[2]!.toLowerCase()];
    if (u && u.kind === "mass") packageSize = { amount: parseNumber(each[1]!)!, unit: u.unit };
    rest = rest.replace(each[0], " ").replace(/\s+/g, " ").trim();
  }
  rest = rest.replace(/^of\s+/i, "");

  // Name and prep note: "chicken breast, diced" / "onion (diced)".
  let name = rest.trim();
  let prep: string | null = null;
  const comma = name.indexOf(",");
  if (comma > 0) {
    prep = name.slice(comma + 1).trim() || null;
    name = name.slice(0, comma).trim();
  }
  const paren = name.match(/\(([^)]*)\)\s*$/);
  if (paren && paren.index! > 0) {
    prep = [paren[1]!.trim(), prep].filter(Boolean).join(", ") || null;
    name = name.slice(0, paren.index).trim();
  }
  name = name.replace(/\s+/g, " ").replace(/[.;:]+$/, "").trim();

  // Second amount: prefer the weight, and say so; same-kind amounts must agree.
  if (altAmount && amount !== null && unit) {
    const first = unit as ParsedUnit; // assigned inside takeUnit, which TypeScript can't follow
    const second = altAmount.unit;
    const a = toBase(amount, first);
    const b = toBase(altAmount.amount, second);
    if (first.kind === second.kind && a !== null && b !== null) {
      if (Math.abs(a - b) / Math.max(a, b) > 0.05) {
        flags.push({ code: "amounts_disagree", severity: "fix", message: `The two amounts don't match (${fmt(amount)} ${unitText(first)} vs ${fmt(altAmount.amount)} ${unitText(second)}). Enter the one you'll use.` });
      }
    } else if (second.kind === "mass" && first.kind !== "mass") {
      flags.push({ code: "amounts_disagree", severity: "check", message: `Uses the weight given (${fmt(altAmount.amount)} ${unitText(second)}) instead of ${fmt(amount)} ${unitText(first)}.` });
      amount = altAmount.amount;
      unit = second;
    }
  }

  if (packageSize) {
    flags.push({ code: "package_size", severity: "check", message: `Uses the package size given: ${fmt(amount ?? 1)} × ${fmt(packageSize.amount)} ${packageSize.unit}.` });
  }
  if (letterUnit) {
    flags.push({ code: "letter_unit", severity: "check", message: `Read "${letterUnit}" as ${letterUnit === "T" ? "tablespoon" : "teaspoon"}. Check it.` });
  }
  if (toTaste) {
    flags.push({ code: "to_taste", severity: "fix", message: `Says "${tasteMatch![1]}": enter an amount so it can be counted, or leave it out.` });
  } else if (amount === null && !/^(juice|zest) of\b/i.test(raw)) {
    flags.push({ code: "no_amount", severity: "fix", message: "No amount found: enter how much." });
  }
  if (amountMax !== null && amount !== null) {
    flags.push({ code: "range", severity: "fix", message: `Gives a range (${fmt(amount)}–${fmt(amountMax)}): enter the amount you'll use.` });
    amount = null;
  }
  if (amount !== null && !unit && !sizeWord && !/^[a-z]/i.test(name)) {
    flags.push({ code: "unknown_unit", severity: "fix", message: "Couldn't tell the unit." });
  }
  const u = unit as ParsedUnit | null;
  if (u?.kind === "count" && VAGUE.has(u.noun)) {
    flags.push({ code: "unusual", severity: "fix", message: `"${u.noun}" isn't a measurable amount: enter it in teaspoons or grams.` });
  }
  if (/\bor\b/i.test(name) || /\/(?!\d)/.test(name)) {
    flags.push({ code: "alternatives", severity: "fix", message: "Lists more than one option: keep the one you'll use." });
  }
  if (/\s(?:and|&|\+)\s/i.test(name) || (toTaste && prep !== null && !/\b(?:ground|fresh|freshly|chopped|minced|diced|divided)\b/i.test(prep))) {
    flags.push({ code: "combined", severity: "check", message: "Looks like two ingredients on one line. Keep it only if it's one product; otherwise split it." });
  }
  if (/\bdivided\b/i.test(prep ?? "") || /\bdivided\b/i.test(name)) {
    flags.push({ code: "divided", severity: "check", message: "Used in more than one step (\"divided\"): the full amount is counted once." });
    name = name.replace(/,?\s*divided\b/i, "").trim();
  }
  if (/^(juice|zest) of\b/i.test(raw) || /\bfor (frying|greasing)\b/i.test(raw)) {
    flags.push({ code: "unusual", severity: "fix", message: "Unusual amount: enter it in grams, tablespoons or cups." });
  }
  if (!name) flags.push({ code: "unknown_unit", severity: "fix", message: "Couldn't find the ingredient name." });

  return { raw, group, amount, amountMax, unit: u, sizeWord, name, prep, optional, packageSize, flags };
}

const fmt = (n: number) => `${Math.round(n * 1000) / 1000}`;
function unitText(u: ParsedUnit): string {
  if (u.kind === "count") return u.noun;
  return u.unit === "fl_oz" ? "fl oz" : u.unit;
}

const GRAMS: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
const ML: Record<string, number> = { tsp: 4.92892159375, tbsp: 14.78676478125, cup: 236.5882365, fl_oz: 29.5735295625, ml: 1, l: 1000 };
/** Grams for weights, millilitres for volumes; only amounts of the same kind are compared. */
function toBase(n: number, u: ParsedUnit): number | null {
  if (u.kind === "mass") return n * GRAMS[u.unit]!;
  if (u.kind === "volume") return n * ML[u.unit]!;
  return null;
}

// ---------- whole recipe ----------

const H_INGREDIENTS = /^(?:ingredients?|what you(?:'|’)?ll need|you will need|shopping list)\s*:?$/i;
const H_STEPS = /^(?:instructions?|directions?|method|steps?|preparation|prep(?:aration)? steps|how to make(?: it)?|cooking instructions)\s*:?$/i;
const H_NOTES = /^(?:notes?|tips?|recipe notes?|chef(?:'|’)?s notes?|storage|substitutions?)\s*:?$/i;
const H_NUTRITION = /^(?:nutrition(?: facts| information| info)?|macros|per serving|nutritional information)\b.*$/i;
const SERVINGS = /\b(?:serves|servings?|yield|yields|makes|portions?)\b\s*:?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/i;
const SERVINGS_AFTER = /\b(\d+)\s*(?:servings|portions|meals|containers)\b/i;
const META = /^(?:prep|cook|total|active|inactive|rest|bake|chill|marinate|cooking|baking)\s*time\b|^(?:prep|cook|total|ready in)\s*:|^(?:course|cuisine|author|keyword|calories|difficulty|equipment)\s*:/i;
const STEP_PREFIX = /^\s*(?:step\s*)?(\d{1,2})\s*[.):]\s*(?=[A-Za-z(])|^\s*step\s+(\d{1,2})\s*:?\s*/i;
const FOOTER = /^(?:back to (?:the )?(?:table of )?contents\b.*|page \d+(?: of \d+)?|\d{1,3})$/i;

/** True for a section heading such as "Ingredients" or "Instructions". */
export function isSectionHeading(text: string): boolean {
  const t = stripBullet(text.trim());
  return H_INGREDIENTS.test(t) || H_STEPS.test(t) || H_NOTES.test(t);
}
const AMOUNT_START = new RegExp(`^\\s*(?:${NUM}|[lI|]\\s*\\/\\s*\\d|(?:a|an|one|two|three|four|five|six|half)\\s+(?:${Object.keys(UNIT_WORDS).filter((u) => /^[a-z]/i.test(u) && u.length > 1).join("|")}|${[...COUNT_NOUNS].join("|")}|large|medium|small|pinch|dash)\\b)`, "i");

function looksLikeIngredient(line: string): boolean {
  const t = stripBullet(line);
  // "1. Preheat the oven" is a numbered step, not an amount.
  if (/^\s*\d{1,2}\s*[.)]\s+[A-Z]/.test(line) && !/^\s*\d{1,2}\s*[.)]\s+[A-Z][a-z]*\s+(?:cups?|tbsp|tsp)\b/i.test(line)) return false;
  if (AMOUNT_START.test(t)) return true;
  if (/\b(to taste|as needed)\b/i.test(t) && t.split(" ").length <= 8) return true;
  return false;
}

const STEP_VERBS = new Set([
  "add", "arrange", "bake", "beat", "blend", "boil", "bring", "broil", "brown", "brush", "chill", "chop", "coat", "combine", "cook",
  "cool", "cover", "crack", "cut", "dice", "divide", "drain", "drizzle", "fill", "flip", "fold", "form", "fry", "garnish", "grill",
  "heat", "layer", "let", "line", "marinate", "mash", "melt", "microwave", "mix", "pat", "place", "pour", "preheat", "press", "put",
  "reduce", "refrigerate", "remove", "rest", "return", "rinse", "roast", "roll", "saute", "sauté", "scramble", "season", "sear",
  "serve", "set", "shape", "shred", "simmer", "slice", "spoon", "spray", "spread", "sprinkle", "stir", "stir-fry", "store", "strain",
  "taste", "toast", "top", "toss", "transfer", "turn", "warm", "whisk", "wrap", "meanwhile", "then", "once", "when", "in", "using", "after", "while",
]);

function looksLikeStep(line: string): boolean {
  const t = line.trim();
  if (/^\s*(?:step\s*)?\d{1,2}\s*[.):]\s+[A-Za-z]/i.test(t)) return true;
  const first = stripBullet(t).split(/\s+/)[0]!.toLowerCase().replace(/[^a-zé-]/g, "");
  if (STEP_VERBS.has(first) && !AMOUNT_START.test(stripBullet(t)) && stripBullet(t).split(/\s+/).length >= 3) return true;
  return t.split(/\s+/).length >= 9 && /[.!]$/.test(t);
}

function isGroupHeader(line: string): boolean {
  const t = stripBullet(line);
  if (t.length > 40 || t.length < 3) return false;
  if (AMOUNT_START.test(t)) return false;
  if (/:$/.test(t)) return true;
  if (/^for (?:the )?\w+/i.test(t) && t.split(" ").length <= 5) return true;
  return t === t.toUpperCase() && /[A-Z]/.test(t) && t.split(" ").length <= 4;
}

const cleanHeader = (t: string) => stripBullet(t).replace(/:$/, "").replace(/^for (?:the )?/i, "").trim().replace(/^\w/, (c) => c.toUpperCase());

/** Reads a whole recipe. `text` is whatever was pasted or extracted. */
export function parseRecipeText(text: string): ParsedRecipe {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));

  let title: string | null = null;
  let servings: number | null = null;
  let servingsRange = false;
  const notes: string[] = [];
  const steps: string[] = [];
  const ingredientLines: { text: string; group: string | null; joined: boolean }[] = [];
  let mode: "start" | "ingredients" | "steps" | "notes" | "nutrition" = "start";
  let sawIngredientHeader = false;
  let sawStepHeader = false;
  let group: string | null = null;
  let stepOpen = false; // last step may continue on the next line
  let numbered = false; // steps are numbered, so unnumbered lines continue the step above

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      stepOpen = false;
      continue;
    }
    if (FOOTER.test(line)) continue;
    const s = line.match(SERVINGS_AFTER) ?? line.match(SERVINGS);
    if (servings === null && s && line.length <= 60 && !looksLikeStep(line)) {
      servings = Number(s[1]);
      servingsRange = Boolean(s[2]);
      if (mode !== "steps") continue;
    }
    if (H_INGREDIENTS.test(stripBullet(line))) {
      mode = "ingredients";
      sawIngredientHeader = true;
      group = null;
      continue;
    }
    if (H_STEPS.test(stripBullet(line))) {
      mode = "steps";
      sawStepHeader = true;
      stepOpen = false;
      continue;
    }
    if (H_NOTES.test(stripBullet(line))) {
      mode = "notes";
      continue;
    }
    if (H_NUTRITION.test(stripBullet(line)) && (mode !== "steps" || stripBullet(line).split(/\s+/).length <= 3)) {
      mode = "nutrition";
      continue;
    }
    if (META.test(stripBullet(line))) continue;
    if (mode === "nutrition") {
      if (looksLikeIngredient(line) && !/\b(kcal|calories|protein|carbs?|fat|fiber|sugar|sodium)\b/i.test(line)) mode = "ingredients";
      else continue;
    }

    if (mode === "start") {
      if (looksLikeIngredient(line)) mode = "ingredients";
      else if (looksLikeStep(line)) mode = "steps";
      else if (title === null) {
        title = stripBullet(line).replace(/\s+/g, " ");
        continue;
      } else if (isGroupHeader(line)) {
        mode = "ingredients";
        group = cleanHeader(line);
        continue;
      } else {
        notes.push(line);
        continue;
      }
    }

    if (mode === "ingredients") {
      // Without a steps header, the first sentence-like line starts the steps.
      // Without a steps header, a step-like line starts the steps. Under an "Ingredients" header only a
      // numbered step or a full sentence does, so "Drizzle of: sesame oil" stays an ingredient.
      const stepLike = sawIngredientHeader
        ? /^\s*(?:step\s*)?\d{1,2}\s*[.):]\s*[A-Za-z]/i.test(line) || (line.split(/\s+/).length >= 9 && /[.!]$/.test(line))
        : looksLikeStep(line);
      if (!sawStepHeader && !looksLikeIngredient(line) && stepLike) {
        mode = "steps";
      } else if (isGroupHeader(line) && !looksLikeIngredient(line)) {
        group = cleanHeader(line);
        continue;
      } else {
        const prev = ingredientLines.at(-1);
        // A wrapped line: a word or two in lowercase with no amount ("cheese" after "1 cup shredded cheddar"),
        // or anything following a line that ends mid-phrase ("…, " / "and" / "or").
        const wrapped =
          prev && !looksLikeIngredient(line) && !BULLET.test(rawLine) &&
          ((/^[a-z(]/.test(stripBullet(line)) && stripBullet(line).split(/\s+/).length <= 2) ||
            /(?:,|\band|\bor|\bof|\bwith|\bmixed|\bboneless|\bskinless|\bshredded|\bchopped|\bgrated|\bfrozen|\bfresh|\bground|\blow|\breduced|\bfat|\bfree|\bplain|\bpart)$/i.test(prev.text) ||
            /^(?:or|and|\+)\s/i.test(stripBullet(line)));
        if (wrapped && prev) {
          prev.text = `${prev.text} ${stripBullet(line)}`;
          prev.joined = true;
        } else {
          ingredientLines.push({ text: line, group, joined: false });
        }
        continue;
      }
    }

    if (mode === "steps") {
      const m = line.match(STEP_PREFIX);
      const body = m ? line.slice(m[0].length).trim() : stripBullet(line);
      if (!body) continue;
      if (/^(?:enjoy|serve and enjoy)!?$/i.test(body) && steps.length > 0) {
        steps[steps.length - 1] = `${steps.at(-1)} ${body}`;
        continue;
      }
      if (m) numbered = true;
      const startsNew = !numbered && STEP_VERBS.has(body.split(/\s+/)[0]!.toLowerCase().replace(/[^a-zé-]/g, "")) && !/^(?:in|when|once|then|while|after|using)$/i.test(body.split(/\s+/)[0]!);
      if (!m && (stepOpen || numbered) && steps.length > 0 && !BULLET.test(rawLine) && !startsNew) {
        // "zero-" + "calorie" was one word split across lines.
        const prevStep = steps.at(-1)!;
        steps[steps.length - 1] = /[a-z]-$/.test(prevStep) && /^[a-z]/.test(body) ? `${prevStep}${body}` : `${prevStep} ${body}`;
      } else {
        steps.push(body);
      }
      stepOpen = !/[.!?)]$/.test(body);
      continue;
    }

    if (mode === "notes") notes.push(stripBullet(line));
  }

  const ingredients = ingredientLines.map((l) => {
    const p = parseIngredientLine(l.text, l.group);
    if (l.joined) p.flags.push({ code: "joined_line", severity: "check", message: "Joined two lines into one ingredient. Check it." });
    return p;
  });
  const flags: ImportFlag[] = [];
  if (!title) flags.push({ code: "no_title", severity: "fix", message: "No recipe name found: enter one." });
  if (servings === null) flags.push({ code: "no_servings", severity: "fix", message: "How many servings the recipe makes wasn't found: enter it." });
  else if (servingsRange) flags.push({ code: "no_servings", severity: "fix", message: "Servings are given as a range: enter the number this recipe makes." });
  if (ingredients.length === 0) flags.push({ code: "no_ingredients", severity: "fix", message: "No ingredients found. Check that the ingredient list was included." });
  if (steps.length === 0) flags.push({ code: "no_steps", severity: "fix", message: "No instructions found: add them." });
  return { title, servings, ingredients, steps, notes, flags };
}
