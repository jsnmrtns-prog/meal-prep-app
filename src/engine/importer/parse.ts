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
  | "ai_mismatch"
  | "split_line"
  | "sub_recipe"
  | "suggested";

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
  /** Nutrition printed in the source ("597 calories, 59g protein…"), for comparing with the app's numbers. */
  printed: PrintedMacros | null;
}

export interface PrintedMacros {
  kcal: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  /** Whether the numbers are for one serving or for the whole recipe. */
  per: "serving" | "recipe";
}

/**
 * The calories and macros a recipe prints about itself, in the layouts seen in
 * cookbooks and posts: "505 Calories / 44G Protein 52G Carbs 15G Fat",
 * "CALORIES: 946 · PROTEIN: 113G", "572 Calories | 52g Protein | …", or the
 * values on one line and the labels on the next ("59g 52g 16g" / "PROTEIN CARBS FAT").
 */
export function findPrintedNutrition(text: string): PrintedMacros | null {
  const t = text.replace(/\r/g, "");
  const num = (re: RegExp) => {
    const m = t.match(re);
    return m ? Number(m[1]!.replace(",", "")) : null;
  };
  // Number and label on the same line (spaces only, so a sentence on the next line can't join in).
  let kcal = num(/(?:^|[^\d.])(\d{2,4}|\d,\d{3})[ \t]*(?:kcal|calories|cals?)\b/im) ?? num(/\b(?:calories|kcal|energy)[ \t]*[:\-]?[ \t]*(\d{2,4}|\d,\d{3})\b/im);
  let protein = num(/(?:^|[^\d.])(\d{1,3}(?:\.\d)?)[ \t]*g[ \t]*protein\b/im) ?? num(/\bprotein[ \t]*[:\-]?[ \t]*(\d{1,3}(?:\.\d)?)[ \t]*g\b/im);
  let carbs = num(/(?:^|[^\d.])(\d{1,3}(?:\.\d)?)[ \t]*g[ \t]*(?:carbs|carbohydrates?)\b/im) ?? num(/\b(?:carbs|carbohydrates?)[ \t]*[:\-]?[ \t]*(\d{1,3}(?:\.\d)?)[ \t]*g\b/im);
  let fat = num(/(?:^|[^\d.])(\d{1,3}(?:\.\d)?)[ \t]*g[ \t]*fats?\b/im) ?? num(/\bfats?[ \t]*[:\-]?[ \t]*(\d{1,3}(?:\.\d)?)[ \t]*g\b/im);
  if (protein === null || kcal === null) {
    // Values first, labels after: "597 / 59g / 52g / 16g / CALORIES / PROTEIN / CARBS / FAT" (one per line or several per line).
    const tokens = t.split("\n").flatMap((l) => l.trim().split(/\s{2,}|\s(?=\d)|(?<=[a-z])\s(?=[a-z])/i)).map((x) => x.trim()).filter(Boolean);
    const isLabel = (x: string) => /^(?:calories|kcal|protein|carbs?|carbohydrates?|fats?)$/i.test(x);
    const isValue = (x: string) => /^\d{1,4}(?:\.\d)?\s*g?$/i.test(x);
    for (let k = 0; k < tokens.length; k++) {
      if (!isLabel(tokens[k]!)) continue;
      let e = k;
      while (e < tokens.length && isLabel(tokens[e]!)) e++;
      const labels = tokens.slice(k, e).map((x) => x.toLowerCase());
      const values = tokens.slice(Math.max(0, k - labels.length), k);
      if (labels.length >= 3 && values.length === labels.length && values.every(isValue)) {
        labels.forEach((l, j) => {
          const v = Number(values[j]!.replace(/\s*g$/i, ""));
          if (/^(?:calories|kcal)$/.test(l)) kcal ??= v;
          else if (l === "protein") protein ??= v;
          else if (/^carb/.test(l)) carbs ??= v;
          else fat ??= v;
        });
        break;
      }
      k = e;
    }
    // Each number straight above its label: "512 / CALORIES / 48g / PROTEIN / …".
    if (protein === null || kcal === null) {
      for (let k = 0; k + 1 < tokens.length; k++) {
        if (!isValue(tokens[k]!) || !isLabel(tokens[k + 1]!)) continue;
        const v = Number(tokens[k]!.replace(/\s*g$/i, ""));
        const l = tokens[k + 1]!.toLowerCase();
        if (/^(?:calories|kcal)$/.test(l)) kcal ??= v;
        else if (l === "protein") protein ??= v;
        else if (/^carb/.test(l)) carbs ??= v;
        else fat ??= v;
      }
    }
  }
  if (kcal === null || kcal < 30 || kcal > 6000) return null;
  const totalNear = /\btotal\b(?![^\n]*\btime\b)/i.test(t.slice(0, Math.max(0, t.search(/calories|kcal/i)) + 1).split("\n").slice(-6).join("\n"));
  return { kcal, protein, carbs, fat, per: totalNear ? "recipe" : "serving" };
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
  "serving", "servings", "bundle", "bundles", "knob", "knobs", "thumb", "thumbs", "wedge", "wedges", "tin", "tins", "carton", "cartons", "pouch", "pouches", "tub", "tubs", "bottle", "bottles", "cube", "cubes",
]);
const SIZE_WORDS = new Set(["large", "medium", "small", "extra-large", "jumbo", "extra large"]);
/** Count nouns that are vague amounts rather than measurable units. */
const VAGUE = new Set(["pinch", "pinches", "dash", "dashes", "handful", "handfuls", "splash", "drizzle", "drop", "drops"]);

const singular = (noun: string) => {
  const map: Record<string, string> = { bundle: "bunch", bundles: "bunch", leaves: "leaf", boxes: "box", bunches: "bunch", pinches: "pinch", dashes: "dash", pkgs: "package", pkg: "package", packages: "package" };
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

/** Package words that follow a size or weight: "400g can", "15 oz. jar". */
const PACK_WORDS = "cans?|tins?|jars?|packages?|packets?|pkgs?|bags?|box(?:es)?|cartons?|tubs?|bottles?|pouch(?:es)?|containers?|blocks?";
/** Prep words that may follow a name without a comma. */
const PREP_TAIL = "freshly cracked|cracked|freshly ground|boneless|skinless|uncooked|garnish|optional garnish|drained|rinsed|chopped|diced|minced|sliced|shredded|grated|peeled|softened|melted|divided|cubed|crushed|beaten|thawed|halved|quartered|trimmed|deseeded|seeded|cored|julienned|torn|packed|sifted|toasted|at room temperature|room temperature|finely chopped|roughly chopped|thinly sliced";

/**
 * Removes what isn't part of the ingredient: prices ("($0.40)"), recipe-note
 * references ("(Note 1)"), footnote stars, and spaces lost between the amount,
 * the unit and the name ("2 Tbspolive oil", "400gcan", "1kglean").
 */
function cleanIngredientText(text: string): string {
  let t = text
    .replace(/\(\s*\$\s?\d+(?:[.,]\d+)?\s*\)/g, " ")
    .replace(/,?\s*\$\s?\d+(?:[.,]\d+)?\**(?=\s|,|$)/g, " ")
    .replace(/\(\s*(?:see\s+)?notes?\s*\d*\s*\)/gi, " ")
    .replace(/\*+(?=\s|,|;|\)|$)/g, "")
    .replace(/;\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  // "Spice Mix: ½ Tsp each …", "Chicken Seasoning: Salt", "Add 300ml of …", "Extra Juice of ½ Lemon": the ingredient after the label.
  t = t.replace(/^(?:[A-Z][\w&'’]*(?:\s+[\w&'’]+){0,3})\s*:\s+(?=\S)/, (m) => (/^(?:to taste|note|tip|serve|(?:a\s+)?(?:drizzle|pinch|splash|dash|sprinkle|squeeze|handful))/i.test(m) ? m : ""));
  t = t.replace(new RegExp(`^(?:add|plus|extra|additional)\\s+(?=${NUM}|juice of|zest of)`, "i"), "");
  // "(Optional) 10ml Rice Vinegar": the amount comes first, the note goes last.
  const opt = t.match(/^\(\s*optional\s*\)\s*/i);
  if (opt) t = `${t.slice(opt[0].length)} (optional)`;
  // "Roughly 60g", "about 2 cups", "~200g": the amount is the amount.
  t = t.replace(new RegExp(`^(?:roughly|about|approx\\.?|approximately|around|~)\\s*(?=${NUM})`, "i"), "");
  // "2onions", "400gcan": a number glued to the next word.
  t = t.replace(new RegExp(`^(${NUM})(?=[A-Za-z])`), "$1 ");
  // "Tbspolive oil", "kglean", "gcan": a unit glued to the name. Single-letter "g" only before a package word.
  t = t.replace(new RegExp(`^(${NUM}\\s+)(tbsp|tsp|tbs|kg|ml|lbs|lb|oz)(?=[a-z]{3,})`, "i"), "$1$2 ");
  t = t.replace(new RegExp(`^(${NUM}\\s+)(g)(?=(?:${PACK_WORDS})\\b)`, "i"), "$1$2 ");
  // "750glean minced beef": gram amounts are large numbers; small numbers before "g…" are counts ("2garlic cloves").
  const big = t.match(new RegExp(`^(${NUM})\\s+(g|ml)(?=[a-z]{3,})`, "i"));
  if (big && (parseNumber(big[1]!) ?? 0) >= 20) t = t.replace(big[0], `${big[1]} ${big[2]} `);
  return t;
}

/** "0.33 cup", "0.13 tsp": two-decimal amounts that are really thirds or eighths. */
function snapDecimal(n: number | null, text: string): number | null {
  if (n === null || !/^\d*\.\d{2}$/.test(text)) return n;
  const whole = Math.floor(n);
  const frac = n - whole;
  for (const f of [1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8]) if (Math.abs(frac - f) < 0.006) return whole + f;
  return n;
}

/**
 * Cleans what PDF layouts leave behind: letter-spaced headings ("S T E P 1"),
 * bullet symbols drawn with symbol fonts (a lone "z" is a Wingdings dot) and
 * arrow markers ("»", "»»"). A symbol at the start of a line becomes a plain bullet.
 */
export function tidyLine(line: string): string {
  let t = line.replace(/\s+/g, " ").trim();
  // A stray bracket inside an amount: "45g (3 (Tbsp) sesame oil" → "45g (3 Tbsp) sesame oil".
  t = t.replace(/\((\s*[\d¼½¾⅓⅔⅛.\/ ]+?)\s*\(\s*(?=[A-Za-z]+\))/g, "($1 ");
  t = t.replace(/\b(?:[A-Z] ){2,}[A-Z]\b/g, (m) => m.replace(/ /g, ""));
  t = t.replace(/^(?:(?:z|[»«›‹]+|[◆■►▶❖✦➢])\s+)+(?=\S)/, "• ");
  t = t.replace(/(^|\s)(?:z|[»«›‹]+|[◆■►▶❖✦➢])(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim();
  // A bullet or dash with nothing after it, and a stray dash at the end of a line.
  if (/^[»«›‹•–—\-*]+$/.test(t)) return "";
  t = t.replace(/\s+[–—]$/, "");
  return t;
}

// ---------- one ingredient ----------

/** Reads one ingredient line. */
export function parseIngredientLine(rawLine: string, group: string | null = null): ParsedIngredient {
  const flags: ImportFlag[] = [];
  const raw = stripBullet(rawLine).replace(/\s+/g, " ").trim();
  // "Juice of 1 lime": USDA gives the juice from one lime, so count limes.
  const juice = raw.replace(/^(?:the\s+)?(juice (?:of|from)) half (?:a|an)\s+/i, "$1 half ").match(new RegExp(`^(?:the\\s+)?juice (?:of|from) (${NUM}|a|an|one|two|three|half)\\s+(?:whole |large |medium |small |fresh )*(lime|lemon|orange)s?\\b\\s*(?:,\\s*(.*))?$`, "i"))
    // "1 lemon, juiced", "½ lime (juiced)": the juice, not the whole fruit.
    ?? raw.match(new RegExp(`^(${NUM}|a|an|one|two|half)\\s+(?:whole |large |medium |small |fresh )*(lime|lemon|orange)s?\\s*,?\\s*\\(?juiced\\)?\\s*(?:,\\s*(.*))?$`, "i"));
  // "Zest of 2 Limes": USDA has the peel by the teaspoon; one fruit gives about a teaspoon of zest.
  const zest = raw.match(new RegExp(`^(?:the\\s+)?zest (?:of|from) (${NUM}|a|an|one|two|half)\\s+(?:whole |large |medium |small )*(lime|lemon|orange)s?\\b`, "i"));
  if (zest) {
    const n = parseNumber(zest[1]!) ?? WORD_NUMBERS[zest[1]!.toLowerCase()] ?? null;
    if (n !== null) {
      const fruit = zest[2]!.toLowerCase();
      return {
        raw, group, amount: n, amountMax: null, unit: { kind: "volume", unit: "tsp" }, sizeWord: null,
        name: `${fruit[0]!.toUpperCase()}${fruit.slice(1)} zest`, prep: null, optional: false, packageSize: null,
        flags: [{ code: "suggested", severity: "check", message: `Zest of ${fmt(n)} ${fruit}${n === 1 ? "" : "s"}: counted as about ${fmt(n)} tsp (one fruit gives about a teaspoon).` }],
      };
    }
  }
  const juice2 = juice ? null : raw.match(new RegExp(`^(${NUM})\\s+(?:whole\\s+)?(lime|lemon|orange)s?\\s+juice\\b\\s*(?:,\\s*(.*))?$`, "i"));
  if (juice || juice2) {
    const j = (juice ?? juice2)!;
    const n = parseNumber(j[1]!) ?? WORD_NUMBERS[j[1]!.toLowerCase()] ?? null;
    const fruit = j[2]!.toLowerCase();
    if (n !== null) {
      return {
        raw, group, amount: n, amountMax: null, unit: { kind: "count", noun: fruit }, sizeWord: null,
        name: `${fruit[0]!.toUpperCase()}${fruit.slice(1)} juice`, prep: j[3]?.trim() || null, optional: false, packageSize: null,
        flags: [{ code: "unusual", severity: "check", message: `Counts the juice of ${fmt(n)} ${fruit}${n === 1 ? "" : "s"}, using USDA's weight for the juice from one.` }],
      };
    }
  }
  const ocr = fixOcr(cleanIngredientText(raw));
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
  // "toasted if desired" with an amount is an optional extra, not "to taste".
  const ifDesired = rest.match(/,?\s*\bif (?:desired|you like|using|preferred)\b/i);
  if (ifDesired && new RegExp(`^${NUM}`).test(rest)) {
    rest = rest.replace(ifDesired[0], "").trim();
    if (!optional) {
      optional = true;
      flags.push({ code: "optional", severity: "check", message: "Marked optional: decide whether to include it." });
    }
  }
  const tasteMatch = rest.match(/,?\s*\b(to taste|as needed|as desired|as required|for serving|for garnish|if desired)\b(?:\s+(?:after|before|at|when|once|to)\b.*)?/i);
  if (tasteMatch) {
    toTaste = true;
    rest = rest.replace(tasteMatch[0], "").replace(/^[:\s]+/, "").trim();
  }

  // Amount (with an optional range).
  let amount: number | null = null;
  let amountMax: number | null = null;
  let amountText = "";
  const range = rest.match(new RegExp(`^(${NUM})\\s*(?:-|–|—|to|or)\\s*(${NUM})(?![\\d/.,]|\\s*%)\\s*`, "i"));
  const single = rest.match(new RegExp(`^(${NUM})(?![\\d/]|\\s*%)\\s*`));
  const wordNum = rest.match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half|a dozen|dozen)\b\s+/i);
  if (range) {
    amount = parseNumber(range[1]!);
    amountMax = parseNumber(range[2]!);
    rest = rest.slice(range[0].length);
  } else if (single) {
    amount = snapDecimal(parseNumber(single[1]!), single[1]!);
    amountText = single[1]!;
    rest = rest.slice(single[0].length);
  } else if (wordNum) {
    const w = wordNum[1]!.toLowerCase().replace("a dozen", "dozen");
    amount = WORD_NUMBERS[w] ?? null;
    rest = rest.slice(wordNum[0].length);
  }

  // A stated package size right after the amount: "1 (15 oz) can", "2 (14.5-ounce) cans".
  let packageSize: ParsedIngredient["packageSize"] = null;
  let altAmount: { amount: number; unit: ParsedUnit; text: string } | null = null;

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
    // "1 heaped tsp", "1 level tbsp": read as the plain measure, and say so.
    const mod = rest.match(/^(heaped|heaping|level|rounded|scant|generous|good|big)\s+(?=(?:tsp|tbsp|teaspoons?|tablespoons?|cups?|t|T)\b)/i);
    if (mod) {
      flags.push({ code: "unusual", severity: "check", message: `Reads "${mod[1]}" as a plain measure.` });
      rest = rest.slice(mod[0].length);
    }
    // "3 x 400g cans": three cans of 400 g each.
    const times = rest.match(new RegExp(`^[x×]\\s*(${NUM})\\s*(g|kg|oz|lb|ml)\\.?\\s*(${PACK_WORDS})\\b\\.?\\s*`, "i"));
    // "1 15oz. can", "1 1.25-ounce package", "1 15 ounce can": a package size without parentheses.
    const bare = rest.match(new RegExp(`^(${NUM})\\s*-?\\s*(oz|ounces?|g|grams?|lbs?|pounds?|kg)\\.?\\s+(${PACK_WORDS})\\b\\.?\\s*`, "i"));
    for (const m of [times, bare]) {
      if (!m) continue;
      const u = UNIT_WORDS[m[2]!.toLowerCase()];
      if (u && u.kind === "mass") {
        packageSize = { amount: parseNumber(m[1]!)!, unit: u.unit };
        unit = { kind: "count", noun: singular(m[3]!.toLowerCase()) };
        rest = rest.slice(m[0].length).replace(/^of\s+/i, "");
        if (/^(?:can|tin)$/.test(singular(m[3]!.toLowerCase())) && !/\bcanned\b/i.test(rest)) rest = `canned ${rest}`;
        break;
      }
    }
    const pkg = unit ? null : rest.match(new RegExp(`^\\((${NUM})\\s*-?\\s*(oz|ounces?|g|grams?|lbs?|pounds?|kg)\\.?\\)\\s*`, "i"));
    if (pkg) {
      const u = UNIT_WORDS[pkg[2]!.toLowerCase()];
      if (u && u.kind === "mass") packageSize = { amount: parseNumber(pkg[1]!)!, unit: u.unit };
      rest = rest.slice(pkg[0].length);
    }
    if (!unit) takeUnit();
    // "400g can chopped tomatoes": the weight is what counts; a can means canned.
    const pack = unit && (unit as ParsedUnit).kind !== "count" ? rest.match(new RegExp(`^(${PACK_WORDS})\\b\\.?\\s+(?:of\\s+)?`, "i")) : null;
    if (pack) {
      rest = rest.slice(pack[0].length);
      if (/^(?:can|cans|tin|tins)$/i.test(pack[1]!) && !/\bcanned\b/i.test(rest)) rest = `canned ${rest}`;
    }
    // A second amount after a slash: "250g / 8oz beef".
    const slash = unit ? rest.match(new RegExp(`^\\/\\s*(${NUM})\\s*([A-Za-z.]+?)\\.?(?=\\s|$)\\s*`)) : null;
    if (slash) {
      const n = parseNumber(slash[1]!);
      const w = slash[2]!.replace(/\.$/, "").toLowerCase();
      if (n !== null && UNIT_WORDS[w]) {
        altAmount = { amount: n, unit: UNIT_WORDS[w]!, text: slash[1]! };
        rest = rest.slice(slash[0].length);
      }
    }
    // Second amount in parentheses: "454 g (16 oz)", "2 cups (300 g)".
    const alt = rest.match(new RegExp(`^\\(\\s*(?:~|about|approx\\.?|approximately)?\\s*(${NUM})\\s*([A-Za-z. ]+?)\\)\\s*`, "i"));
    if (alt) {
      const n = parseNumber(alt[1]!);
      const w = alt[2]!.trim().replace(/\.$/, "").toLowerCase();
      const u = UNIT_WORDS[w] ?? (/^fl\.?\s*oz$/.test(w) ? UNIT_WORDS["fl oz"] : undefined);
      if (n !== null && u) {
        altAmount = { amount: n, unit: u, text: alt[1]! };
        rest = rest.slice(alt[0].length);
      } else if (n !== null && unit && (COUNT_NOUNS.has(w) || COUNT_NOUNS.has(w.split(" ")[0]!))) {
        // "30 g (1 packet)": the weight is what counts; the packet is just a description.
        rest = rest.slice(alt[0].length);
      }
    }
  }

  // Leading prep words: "1/2 Diced Medium White Onion", "Cooked & Diced Chicken Breast" ("cooked" stays: USDA has cooked foods).
  const leadPrep: string[] = [];
  {
    const words = rest.split(/\s+/);
    const kept: string[] = [];
    let k = 0;
    while (k < words.length - 1 && /^(?:diced|sliced|chopped|minced|cubed|crushed|peeled|finely|thinly|roughly|coarsely|cooked|&|and)$/i.test(words[k]!)) {
      if (/^cooked$/i.test(words[k]!)) kept.push(words[k]!);
      else if (!/^(?:&|and)$/i.test(words[k]!)) leadPrep.push(words[k]!.toLowerCase());
      k++;
    }
    if (leadPrep.length) rest = [...kept, ...words.slice(k)].join(" ");
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
      if (/^(?:can|tin)$/.test(singular(n)) && !/\bcanned\b/i.test(rest)) rest = rest.replace(/^(\(.*?\)\s*)?/, "$1canned ");
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
  // A comma inside brackets isn't the name/prep split: "veggies (carrots, mushrooms, onions)".
  let depth = 0;
  let comma = -1;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) { comma = i; break; }
  }
  if (comma > 0) {
    prep = name.slice(comma + 1).trim() || null;
    name = name.slice(0, comma).trim();
  }
  const paren = name.match(/\(([^)]*)\)?\s*$/);
  if (paren && paren.index! > 0) {
    prep = [paren[1]!.trim(), prep].filter(Boolean).join(", ") || null;
    name = name.slice(0, paren.index).trim();
  }
  name = name.replace(/\s+/g, " ").replace(/[.;:]+$/, "").trim();
  if (leadPrep.length) prep = [leadPrep.join(" "), prep].filter(Boolean).join(", ");
  // "(0% Fat)", "(fat free)" describe the food itself, so they stay in the name.
  if (prep && /^(?:\d+(?:\.\d+)?%\s*(?:fat|milkfat|lean)?|fat[- ]free|non-?fat|low[- ]fat|reduced[- ]fat|skim|light|lite)$/i.test(prep.trim())) {
    name = `${prep.trim()} ${name}`;
    prep = null;
  }
  // "black beans (rinsed)": beans that are drained or rinsed come from a can.
  if (/\b(?:beans|chickpeas|garbanzos?)\b/i.test(name) && /\b(?:rinsed|drained)\b/i.test(prep ?? "") && !/\b(?:canned|dried|dry|cooked)\b/i.test(name)) name = `canned ${name}`;
  // Prep words after the name without a comma: "black beans drained and rinsed".
  const tail = name.match(new RegExp(`\\s+((?:${PREP_TAIL})(?:\\s*(?:,|and|&)\\s*(?:${PREP_TAIL}))*)$`, "i"));
  if (tail && tail.index! > 0) {
    prep = [tail[1]!, prep].filter(Boolean).join(", ");
    name = name.slice(0, tail.index).trim();
  }
  // "2 onions, large, halved": the size can come after the name.
  if (amount !== null && !unit && !sizeWord && prep && !COUNT_NOUNS.has(name.split(" ").at(-1)!.toLowerCase())) {
    const sz = prep.match(/^(extra[- ]large|large|medium|small|jumbo)\b[,\s]*/i);
    if (sz) {
      sizeWord = sz[1]!.toLowerCase().replace(" ", "-");
      prep = prep.slice(sz[0].length).trim() || null;
    }
  }
  // "1 onion, about 200g, peeled": a weight given in the note is better than a count.
  const noted = prep?.match(new RegExp(`\\b(?:about|approx\\.?|approximately|roughly|~)\\s*(${NUM})\\s*(g|grams?|kg|oz|ounces?|lbs?|pounds?)\\b`, "i"));
  if (noted && amount !== null && amountMax === null && (!unit || (unit as ParsedUnit).kind === "count") && !packageSize) {
    const u = UNIT_WORDS[noted[2]!.toLowerCase()];
    const n = parseNumber(noted[1]!);
    if (u && u.kind === "mass" && n !== null) {
      flags.push({ code: "amounts_disagree", severity: "check", message: `Uses the weight given in the note (${fmt(n)} ${u.unit}) for ${fmt(amount)}.` });
      amount = n * amount;
      unit = u;
      sizeWord = null;
    }
  }

  // Second amount: prefer the weight, and say so; same-kind amounts must agree.
  if (altAmount && amount !== null && unit) {
    const first = unit as ParsedUnit; // assigned inside takeUnit, which TypeScript can't follow
    const second = altAmount.unit;
    const a = toBase(amount, first);
    const b = toBase(altAmount.amount, second);
    if (first.kind === second.kind && a !== null && b !== null) {
      // Printed amounts are rounded ("30g (1oz)" is 28.35 g): allow half of the last shown digit on either side.
      const slack = (text: string, u: ParsedUnit) => 0.5 * 10 ** -((text.split(/[.,]/)[1] ?? "").replace(/\D/g, "").length) * (toBase(1, u) ?? 0);
      const allowed = Math.max(0.05 * Math.max(a, b), (/^\d+(?:[.,]\d+)?$/.test(amountText) ? slack(amountText, first) : 0) + (/^\d+(?:[.,]\d+)?$/.test(altAmount.text) ? slack(altAmount.text, second) : 0));
      const metricFirst = /^(?:g|kg|ml|l)$/.test((first as { unit?: string }).unit ?? "") && !/^(?:g|kg|ml|l)$/.test((second as { unit?: string }).unit ?? "");
      if (Math.abs(a - b) > Math.max(allowed, 0.15 * Math.max(a, b)) && metricFirst) {
        // "15g (0.7oz)": the grams are the recipe's own measure; the conversion beside it is off.
        flags.push({ code: "amounts_disagree", severity: "check", message: `The two amounts don't match (${fmt(amount)} ${unitText(first)} vs ${fmt(altAmount.amount)} ${unitText(second)}): uses ${fmt(amount)} ${unitText(first)}, the recipe's main measure.` });
      } else if (Math.abs(a - b) > Math.max(allowed, 0.15 * Math.max(a, b))) {
        flags.push({ code: "amounts_disagree", severity: "fix", message: `The two amounts don't match (${fmt(amount)} ${unitText(first)} vs ${fmt(altAmount.amount)} ${unitText(second)}). Enter the one you'll use.` });
      } else if (Math.abs(a - b) > allowed) {
        // "250g / 8oz": a loose conversion. The first amount is the recipe's own.
        flags.push({ code: "amounts_disagree", severity: "check", message: `The two amounts are a rough match (${fmt(amount)} ${unitText(first)} vs ${fmt(altAmount.amount)} ${unitText(second)}): uses ${fmt(amount)} ${unitText(first)}.` });
      }
    } else if (second.kind === "mass" && first.kind === "volume" && /^(?:ml|l)$/.test((first as { unit?: string }).unit ?? "") && (second as { unit?: string }).unit === "oz") {
      // "300ml (10.6oz)": these ounces are fluid ounces; the millilitres are the recipe's own measure.
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
  if (toTaste && amount !== null && unit) {
    // "1 Tsp Salt (or to taste)": the amount is given.
    flags.push({ code: "to_taste", severity: "check", message: `Says "${tasteMatch![1]}": using the ${fmt(amount)} ${unitText(unit as ParsedUnit)} given.` });
  } else if (toTaste) {
    flags.push({ code: "to_taste", severity: "fix", message: `Says "${tasteMatch![1]}": enter an amount so it can be counted, or leave it out.` });
  } else if (amount === null && !/^(juice|zest) of\b/i.test(raw)) {
    flags.push({ code: "no_amount", severity: "fix", message: "No amount found: enter how much." });
  }
  if (amountMax !== null && amount !== null && (amount <= 0 || amountMax > amount * 2)) {
    // "¼–1½ cups oil for frying": too wide to pick for you.
    flags.push({ code: "range", severity: "fix", message: `Gives a range (${fmt(amount)}–${fmt(amountMax)}): enter the amount you'll use.` });
    amount = null;
  } else if (amountMax !== null && amount !== null) {
    // "1–2 tsp", "300–400g": the middle of the range, marked so it can be changed.
    const mid = Math.round(((amount + amountMax) / 2) * 1000) / 1000;
    flags.push({ code: "range", severity: "check", message: `Gives a range (${fmt(amount)}–${fmt(amountMax)}${unit ? ` ${unitText(unit)}` : ""}): using the middle, ${fmt(mid)}. Change it if you use more or less.` });
    amount = mid;
    amountMax = null;
  }
  if (amount !== null && !unit && !sizeWord && !/^[a-z]/i.test(name)) {
    flags.push({ code: "unknown_unit", severity: "fix", message: "Couldn't tell the unit." });
  }
  const u = unit as ParsedUnit | null;
  if (u?.kind === "count" && VAGUE.has(u.noun)) {
    flags.push({ code: "unusual", severity: "fix", message: `"${u.noun}" isn't a measurable amount: enter it in teaspoons or grams.` });
  }
  // "Salt or to taste", "water or more as needed": the amount given is used.
  name = name.replace(/\s+or\s+(?:more\s+|less\s+)?(?:to taste|as needed|as desired|more|less)\b.*$/i, "").trim();
  if (/\b(?:white|yellow|red|green|orange|gold|golden|russet|sweet|brown|black|purple|baby|regular|large|small|medium) or (?:white|yellow|red|green|orange|gold|golden|russet|sweet|brown|black|purple|baby|regular|large|small|medium) \w/i.test(name)) {
    flags.push({ code: "alternatives", severity: "check", message: "Gives two kinds of the same food: check the one picked." });
  } else if (/\bor\b/i.test(name)) {
    // "Rice Vinegar or Lemon Juice", "Fat Free or Low Fat Greek Yogurt": the first option, with the words they share.
    const [left, ...others] = name.split(/\s+or\s+/i);
    const right = others.join(" or ");
    const lw = left!.trim().split(/\s+/);
    const rw = right.trim().split(/\s+/);
    const modifiersOnly = lw.every((w) => /^(?:fat|free|low|reduced|light|lite|whole|skim|nonfat|non-fat|white|yellow|red|green|brown|raw|cooked|fresh|frozen|dried|plain|unsweetened|sweetened|regular|lean|extra|virgin|sharp|mild|hot|sweet|smoked|salted|unsalted|\d+%)$/i.test(w));
    const chosen = rw.length > lw.length && modifiersOnly ? [...lw, ...rw.slice(lw.length)].join(" ") : left!.trim();
    if (others.length === 1 && !/\d/.test(right) && lw.length <= 5 && rw.length <= 6 && chosen) {
      flags.push({ code: "alternatives", severity: "check", message: `Gives a choice: using ${chosen}. Change the food if you use ${right.replace(/^(?:any|a)\s+/i, "")}.` });
      name = chosen;
    } else if (left!.trim()) {
      // A longer choice: the first option, close enough.
      flags.push({ code: "alternatives", severity: "check", message: `Gives a choice: using ${left!.trim()}. Change the food if you use another option.` });
      name = left!.trim();
    } else {
      flags.push({ code: "alternatives", severity: "fix", message: "Lists more than one option: keep the one you'll use." });
    }
  } else if (/[A-Za-z]\s*\/\s*[A-Za-z]/.test(name)) {
    flags.push({ code: "alternatives", severity: "check", message: "Gives two names for it: check the food picked." });
  }
  if (/^or\b/i.test(prep ?? "")) {
    flags.push({ code: "alternatives", severity: "check", message: `Suggests a swap (${prep}): ${name} is used.` });
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

const H_INGREDIENTS = /^(?:ingredients?|what you(?:'|’)?ll need|you will need|shopping list)\s*(?:\([^)]*\))?\s*:?(?:\s*\d+(?:\/\d+)?x)*$/i;
const H_STEPS = /^(?:instructions?|directions?|method|steps?|preparation|prep(?:aration)? steps|how to make(?: it)?|cooking instructions)\s*(?:\([^)]*\))?\s*:?$/i;
const H_NOTES = /^(?:(?:important|helpful|cooking|recipe|chef(?:'|’)?s|meal[- ]prep|storage|serving|top|quick|pro|my)\s+)*(?:notes?|tips?|storage|substitutions?|storage (?:and|&) reheating)\s*:?$/i;
const H_EQUIPMENT = /^(?:equipment|tools|kitchen tools|equipment needed|you will need these tools)\s*:?$/i;

/** A recipe name without emoji, hashtags or a leading account name ("fairfiteats Creamy Cajun Chicken Pasta 🍝"). */
function cleanTitle(t: string): string {
  let s = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, "").replace(/\s#\w+/g, "").replace(/\s+/g, " ").trim();
  // "fairfiteats Creamy Cajun…": an account name copied with a social post (it has emoji, or dots, digits or underscores).
  const social = s !== t.replace(/\s+/g, " ").trim() || /^[a-z]*[._\d][a-z0-9._]*\s/.test(s);
  if (social) s = s.replace(/^[a-z0-9._]{3,30}\s+(?=[A-Z])/, "");
  // "Honey Garlic Butter chicken Mac n cheese": a mostly Title Case name with a few words the font printed small.
  const words = s.split(" ");
  const big = words.filter((w) => w.length >= 4);
  if (words.length >= 4 && big.length >= 2 && big.filter((w) => /^[A-Z]/.test(w)).length / big.length >= 0.5 && s !== s.toUpperCase()) {
    s = words.map((w, i) => (i > 0 && /^(?:and|or|n|with|of|the|a|an|in|on|&|to|for)$/.test(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase()))).join(" ");
  }
  return s || t;
}

/** "STEP 1" on a line of its own: the following lines are that step. */
const STEP_MARKER = /^step\s*(\d{1,2})\s*[:.]?$/i;
/** A running page header or table-of-contents link, not a recipe name. */
const NOT_TITLE = /\bcook\s?book\b|\btable of contents\b|^page\s+\d|^recipe\s*(?:#|no\.?|number)?\s*\d+$|^tap icons\b/i;
/** Website and print-page clutter around a recipe card. */
const JUNK = /^(?:go back|print(?: recipe)?|pin(?: recipe| it)?|save(?: recipe)?|email(?: link)?|go back email link|jump to (?:recipe|video)|share(?: this recipe)?|rate this recipe|prevent (?:your )?screen from (?:sleeping|going dark)|cook mode|\d+(?:\.\d+)?\s*(?:from|out of)\s*\d+\s*(?:votes?|ratings?|reviews?)|[\d.,]+\s*(?:votes?|ratings?|reviews?)|no ratings yet|\$[\d.]+ (?:recipe|serving)\b.*|(?:recipe|photo|photos) by\b.*|(?:author|by|course|cuisine|keyword|keywords|diet|method|equipment|category|calories|cost)\s*:.*|.*\bthis post may contain affiliate links\b.*|skip to (?:main )?content|minutes?|mins?|hours?|hrs?|\d+\s*(?:min|mins|minutes|hrs?|hours?)|see how we calculate.*|page|#\s?\d+|#\w+(?:\s+#\w+)*|nutritional|information|nutritional information|total|(?:calories|carbs|carbohydrates|fats?|protein|fibre|fiber|sugars?|sodium)\s*:?\s*\d+(?:\.\d+)?\s*(?:g|kcal|mg)?|\d+(?:\.\d+)?\s*(?:g\s*)?(?:calories|kcal|protein|carbs|fat)|.*\d+\s*(?:calories|kcal)\b.*\|.*|(?:\d+(?:\/\d+)?x\s*){2,})$/i;
/** Section labels in ingredient lists that are still a single food, never a heading. */
const FOODISH = /\b(?:salt|pepper|oil|water|ice|parsley|cilantro|coriander|basil|garnish|spray|butter|sugar|flour|lemon|lime|chives|dill|mint)\b/i;
const CONTINUE = /^(?:continued?|cont(?:'|’)?d\.?|cont\.)\s*(?:from (?:previous|last) page)?$/i;
const H_NUTRITION = /^(?:nutrition(?: facts| information| info)?|macros|per serving|nutritional information)\b.*$/i;
const SERVINGS = /\b(?:serves|servings?|yield|yields|makes|portions?)\b\s*:?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/i;
const SERVINGS_AFTER = /\b(\d+)\s*(?:servings|portions|meals|containers)\b/i;
const META = /^(?:prep|cook|total|active|inactive|rest|bake|chill|marinate|cooking|baking)\s*time(?:\b|(?=\d))|^(?:prep|cook|total|ready in)\s*:|^(?:course|cuisine|author|keyword|calories|difficulty|equipment)\s*:/i;
const STEP_PREFIX = /^\s*(?:step\s*)?(\d{1,2})\s*[.):]\s*(?=[A-Za-z(])|^\s*step\s+(\d{1,2})\s*:?\s*/i;
const FOOTER = /^(?:(?:back|return) to (?:the )?(?:table of )?contents\b.*|page \d+(?: of \d+)?|\d{1,3})$/i;

/** True for a section heading such as "Ingredients" or "Instructions". */
export function isSectionHeading(text: string): boolean {
  const t = stripBullet(tidyLine(text));
  return H_INGREDIENTS.test(t) || H_STEPS.test(t) || H_NOTES.test(t);
}
const AMOUNT_START = new RegExp(`^\\s*(?:${NUM}(?![\\d.,]|\\s*%)|[lI|]\\s*\\/\\s*\\d|(?:a|an|one|two|three|four|five|six|half)\\s+(?:${Object.keys(UNIT_WORDS).filter((u) => /^[a-z]/i.test(u) && u.length > 1).join("|")}|${[...COUNT_NOUNS].join("|")}|large|medium|small|pinch|dash)\\b)`, "i");

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
  "taste", "toast", "top", "toss", "make", "transfer", "turn", "warm", "whisk", "wrap", "meanwhile", "then", "once", "when", "in", "using", "after", "while",
]);

function looksLikeStep(line: string): boolean {
  const t = line.trim();
  if (/^\s*(?:step\s*)?\d{1,2}\s*[.):]\s+[A-Za-z]/i.test(t)) return true;
  const first = stripBullet(t).split(/\s+/)[0]!.toLowerCase().replace(/[^a-zé-]/g, "");
  if (STEP_VERBS.has(first) && !AMOUNT_START.test(stripBullet(t)) && stripBullet(t).split(/\s+/).length >= 3) return true;
  return t.split(/\s+/).length >= 9 && /[.!]$/.test(t);
}

/** A line with a bracket left open or closed from another line ("Tortilla (Brand:", "Wrap)"). */
const unbalanced = (t: string) => (t.match(/\(/g)?.length ?? 0) !== (t.match(/\)/g)?.length ?? 0);

function isGroupHeader(line: string): boolean {
  const t = stripBullet(line);
  if (unbalanced(t)) return false;
  if (t.length > 40 || t.length < 3) return false;
  if (AMOUNT_START.test(t)) return false;
  if (/:$/.test(t)) return true;
  if (/^For (?:the )?\w+/.test(t) && t.split(" ").length <= 5) return true;
  return t === t.toUpperCase() && /[A-Z]/.test(t) && t.split(" ").length <= 4;
}

const cleanHeader = (t: string) => stripBullet(t).replace(/:$/, "").replace(/^for (?:the )?/i, "").trim().replace(/^\w/, (c) => c.toUpperCase());

/** An amount with nothing after it: "0.13 cup", "1/4 pound", "2", "As required". */
const AMOUNT_ONLY = new RegExp(`^(?:(?:${NUM})(?:\\s*(?:-|–|to)\\s*(?:${NUM}))?\\s*(?:${Object.keys(UNIT_WORDS).filter((u) => /^[a-z]/i.test(u)).join("|")}|${[...COUNT_NOUNS].join("|")})?\\.?|as required|to taste|as needed)$`, "i");
/** A second "amount + measure" later in a line, after a word or closing bracket. */
const SECOND_AMOUNT = new RegExp(`(?<=[A-Za-z)])\\s(?<!\\b(?:for|of|about|approx|approximately|to|plus|or|and|each|per|in|with|x|from|makes|yields?|serves|into)\\s)(?:${NUM})\\s*(?:cups?|teaspoons?|tablespoons?|tsp|tbsp|grams?|g|ounces?|oz|pounds?|lbs?|lb|ml|kg|large|medium|small|cloves?|cans?)\\b`, "i");
/** How a note line under an ingredient usually starts. */
const NOTE_START = /^(?:any |use |such as|e\.g\.|like |ideally|preferably|if |homemade|store|see |recipe |large|medium|small|extra|drained|rinsed|peeled|chopped|diced|minced|sliced|finely|roughly|thinly|halved|cut|deseeded|seeded|trimmed|softened|melted|at room|room temperature|we |i |you |or |plus |about |see |optional|plain|homemade|store-bought|fresh|frozen|thawed|to serve|for serving|for garnish)/i;

/** Words that finish a food name wrapped onto a second line. */
const CONTINUES_NAME = /^(?:reggiano|cheese|yog(?:h)?urt|milk|cream|breasts?|thighs?|fillets?|powder|flakes|seeds|juice|sauce|paste|oil|stock|broth|onions?|peppers?|beef|chicken|turkey|pork|rice|pasta|noodles|beans|tomatoes|potatoes|cheddar|mozzarella|parmesan|seasoning|mix|syrup|vinegar|leaves)$/i;

/** A line that stops mid-name: the next line finishes it ("Low Fat Cottage" / "Cheese"). */
const WRAP_END = /(?:,|\bday-old|\band|\bor|\bof|\bwith|\b&|\bmixed|\bboneless|\bskinless|\bshredded|\bchopped|\bgrated|\bfrozen|\bfresh|\bfreshly|\bground|\blow|\breduced|\bfat|\bfree|\bplain|\bpart|\bcottage|\bgreek|\bdiced|\bsliced|\bmedium|\blarge|\bsmall|\bwhite|\bcooked|\buncooked|\bdry|\braw|\blean|\bsmoked|\bevaporated|\blight|\bextra|\bvirgin|\bwhole|\bsour|\bheavy|\bbrown|\bsweet|\bred|\bgreen|\byellow|\bchicken|\bbeef|\bturkey|\bpork|\bcream|\b\(brand:?|-)$/i;

/** True when a line is written as a list bullet. */
const bulleted = (line: string) => BULLET.test(line);

/**
 * A short label with no amount that heads the lines under it ("Pico de Gallo",
 * "Taco Beef"): it isn't bulleted while the lines under it are, or it follows a
 * blank line and is written in Title Case.
 */
function looksLikeUnmarkedHeader(line: string, next: string | undefined, afterBlank: boolean, prev?: string): boolean {
  const t = stripBullet(line);
  if (!next || bulleted(line) || looksLikeIngredient(line) || unbalanced(t)) return false;
  // "Chicken per Taco" under "Roughly 60g (2.1oz)": the food for an amount on the line above.
  if (/\bper\b/i.test(t) || (prev && parseIngredientLine(prev).name === "")) return false;
  // "Cheese" under "180g Low Fat Cottage": the end of a wrapped line, not a label.
  if (!afterBlank && prev && (WRAP_END.test(prev.trim()) || /^(?:cheese|yog(?:h)?urt|milk|cream|onions?|breasts?|thighs?|powder|flour|juice|beans|rice|pasta|seasoning|oil|stock|broth|paste|leaves|cloves|potato(?:e?s)?|tomato(?:e?s)?|peppers?|mince|fillets?|sauce)$/i.test(t))) return false;
  if (t.length > 45 || t.length < 3 || /[,.;!?]$|,/.test(t) || /^[a-z(]/.test(t)) return false;
  if (t.replace(/\([^)]*\)/g, "").trim().split(/\s+/).length > 6) return false;
  if (!looksLikeIngredient(next)) return false;
  if (bulleted(next)) return true;
  const words = t.replace(/\([^)]*\)/g, "").trim().split(/\s+/);
  const titleCase = words.every((w) => w.length <= 3 || /^[A-Z0-9]/.test(w));
  if (afterBlank && titleCase) return true;
  // "Beef and Marinade", "Frying", "Stir Fry": a short Title Case label that isn't a seasoning or garnish.
  return titleCase && words.length <= 4 && !FOODISH.test(t);
}

/** "1 Tsp each: Salt, Pepper, Cumin" → one line per ingredient with that amount. */
function splitEach(text: string): string[] | null {
  const t = stripBullet(text);
  const m = t.match(/^(.{1,25}?)\s+each\s*:?\s+(.+)$/i);
  if (!m || !AMOUNT_START.test(m[1]!) || m[1]!.split(/\s+/).length > 3) return null;
  const items = m[2]!.split(/\s*,\s*|\s+and\s+|\s*&\s*/i).map((x) => x.trim()).filter(Boolean);
  if (items.length < 2) return null;
  return items.map((x) => `${m[1]} ${x}`);
}

/**
 * "Italian Seasoning, Salt & Garlic Powder" or "Salt and pepper, to taste": several
 * foods with no amount on one line become one line each (each still needs an amount).
 */
function splitList(text: string): string[] | null {
  // "Season both sides generously with Oregano, Garlic Powder, Salt & Pepper": the seasonings, no amounts.
  const season = stripBullet(text).match(/^(?:season|sprinkle|dust|rub)(?:[\s,]+[a-z]+){0,4}?[\s,;]+with\s+(.+)$/i);
  // "Drizzle of: sesame oil and soy sauce": the same small amount of each.
  const vague = season ? null : stripBullet(text).match(/^((?:a\s+)?(?:drizzle|pinch(?:es)?|splash(?:es)?|dash(?:es)?|sprinkle|squeeze|handful)(?:\s+of)?)\s*:?\s+(.+)$/i);
  const t = season ? season[1]! : vague ? vague[2]! : stripBullet(text);
  if (AMOUNT_START.test(t) || /[()]/.test(t)) return null;
  // "To taste: salt, pepper, garlic powder" puts the words first.
  const lead = t.match(/^(to taste|for garnish|garnish(?: with)?|optional)\s*:\s*(.+)$/i);
  const taste = lead ? ([`, ${lead[1]!.toLowerCase().replace(/^garnish(?: with)?$/, "for garnish")}`] as unknown as RegExpMatchArray) : t.match(/,?\s*\b(?:to taste|as needed|for serving|for garnish)\b.*$/i);
  const body = lead ? lead[2]!.trim() : taste ? t.slice(0, taste.index).trim() : t;
  const items = body.replace(/^(?:garnish(?:ed)?(?: with)?|top(?:ped)? with|serve with)\s+/i, "").split(/\s*,\s*|\s*&\s*|\s*\+\s*|\s+and\s+/i).map((x) => x.trim()).filter(Boolean);
  // "Fresh Parsley, chopped": the part after the comma is how it's prepared, not another food.
  if (items.slice(1).some((x) => new RegExp(`^(?:(?:${PREP_TAIL}|finely|roughly|thinly|freshly|to serve|optional)\\s*)+$`, "i").test(x))) return null;
  if (items.length < 2 || items.length > 10 || items.some((x) => x.split(/\s+/).length > 3 || /^[a-z]+ly$/i.test(x))) return null;
  return items.map((x) => `${vague ? `${vague[1]} ` : ""}${x}${taste ? ` ${taste[0].replace(/^,?\s*/, "")}` : ""}`);
}

/** Standard kitchen amounts for unmeasured items, each with the reason shown to the user. */
const VAGUE_AMOUNTS: [RegExp, number, ParsedUnit, string][] = [
  [/\bpinch(?:es)?\b/i, 1 / 16, { kind: "volume", unit: "tsp" }, "a pinch is about 1/16 tsp"],
  [/\bdash(?:es)?\b/i, 1 / 8, { kind: "volume", unit: "tsp" }, "a dash is about 1/8 tsp"],
  [/\bsplash(?:es)?\b/i, 1, { kind: "volume", unit: "tbsp" }, "a splash is about 1 tbsp"],
  [/\bdrops?\b/i, 1, { kind: "volume", unit: "tsp" }, "a drop is about 1 tsp"],
  [/\bspoonfuls?\b|\bdollops?\b/i, 1, { kind: "volume", unit: "tbsp" }, "a spoonful is about 1 tbsp"],
  [/\bsqueeze\b/i, 1, { kind: "volume", unit: "tsp" }, "a squeeze is about 1 tsp"],
  [/\bdrizzle\b/i, 1, { kind: "volume", unit: "tsp" }, "a drizzle is about 1 tsp"],
  [/\bsprinkle\b/i, 1 / 4, { kind: "volume", unit: "tsp" }, "a sprinkle is about 1/4 tsp"],
];
const HERBS = /\b(?:parsley|cilantro|coriander(?! (?:powder|seed))|basil(?! dried)|mint|chives|dill|green onions?|spring onions?|scallions?)\b/i;
const GREENS = /\b(?:spinach|lettuce|rocket|arugula|kale|mixed greens|salad leaves)\b/i;
const SPICES = /\b(?:garlic powder|onion powder|paprika|cumin|oregano|thyme|rosemary|chil(?:l)?i (?:flakes|powder)|red pepper flakes|cayenne|turmeric|cinnamon|nutmeg|curry powder|garam masala|italian seasoning|mixed herbs|seasoning|spice mix|dried basil|dried parsley|parsley flakes|coriander powder|ground coriander|smoked paprika)\b/i;

/**
 * An ingredient without an amount ("Pinch of salt", "To taste: pepper",
 * "Garnish with parsley") gets a standard kitchen amount, marked as an
 * assumption the user can change. Foods that need a real amount (a vegetable,
 * a cheese, wraps) still ask.
 */
function suggestAmount(p: ParsedIngredient): ParsedIngredient {
  // "1 handful cilantro", "2 pinches salt": the count word is the vague measure.
  if (p.unit?.kind === "count" && /^(?:handful|pinch|dash|splash|drizzle|sprinkle|squeeze|spoonful|dollop|drop)$/.test(p.unit.noun)) p = { ...p, unit: null, raw: `${p.raw}`, name: `${p.unit.noun} ${p.name}` };
  if (p.amount !== null && p.unit !== null) return p;
  const fixCodes = p.flags.filter((f) => f.severity === "fix").map((f) => f.code);
  if (!fixCodes.length || fixCodes.some((c) => !["no_amount", "to_taste", "unusual", "unknown_unit"].includes(c))) return p;
  const text = `${p.raw} ${p.name}`;
  const name = p.name.toLowerCase();
  let pick: { amount: number; unit: ParsedUnit; why: string } | null = null;
  const vague = VAGUE_AMOUNTS.find(([re]) => re.test(text));
  const count = p.amount ?? 1;
  if (/\bhandfuls?\b/i.test(text)) {
    pick = GREENS.test(name) ? { amount: count, unit: { kind: "volume", unit: "cup" }, why: "a handful of leaves is about 1 cup" }
      : HERBS.test(name) ? { amount: count * 2, unit: { kind: "volume", unit: "tbsp" }, why: "a handful of herbs is about 2 tbsp" }
      : null;
  } else if (vague && /\bdrizzle\b/i.test(text) && /\b(?:sauce|syrup|honey|glaze|vinegar|dressing)\b/i.test(name)) {
    pick = { amount: count, unit: { kind: "volume", unit: "tbsp" }, why: "a drizzle of sauce is about 1 tbsp" };
  } else if (vague) {
    pick = { amount: count * vague[1], unit: vague[2], why: vague[3] };
  } else if (p.amount === null) {
    if (/\bsalt\b/.test(name) && !/\bgarlic salt\b/.test(name)) pick = { amount: 1 / 4, unit: { kind: "volume", unit: "tsp" }, why: "salt to taste, about 1/4 tsp" };
    else if (/^(?:black |white |ground |cracked |freshly ground )*pepper$/.test(name)) pick = { amount: 1 / 4, unit: { kind: "volume", unit: "tsp" }, why: "pepper to taste, about 1/4 tsp" };
    else if (/\bsesame seeds?\b/.test(name)) pick = { amount: 1, unit: { kind: "volume", unit: "tsp" }, why: "a garnish of seeds, about 1 tsp" };
    else if (HERBS.test(name) && !GREENS.test(name)) pick = { amount: 1, unit: { kind: "volume", unit: "tbsp" }, why: "a garnish of herbs, about 1 tbsp" };
    else if (SPICES.test(name)) pick = { amount: 1, unit: { kind: "volume", unit: "tsp" }, why: "seasoning to taste, about 1 tsp" };
    else if (/\b(?:cooking|oil|olive oil|avocado oil) spray\b|\bspray\b.*\boil\b|\bcooking spray\b/.test(name)) pick = { amount: 1 / 4, unit: { kind: "volume", unit: "tsp" }, why: "a quick spray is about 1/4 tsp of oil" };
    else if (/\b(?:hot sauce|sriracha|tabasco|lemon juice|lime juice)\b/.test(name)) pick = { amount: 1, unit: { kind: "volume", unit: "tsp" }, why: "to taste, about 1 tsp" };
    else if (/^(?:fresh |minced |crushed |chopped )*garlic(?: cloves?)?(?:,? (?:minced|crushed|chopped))?$/.test(name)) pick = { amount: 1, unit: { kind: "count", noun: "clove" }, why: "garlic with no amount, about 1 clove" };
    else if (/\b(?:lemon|lime|orange) zest\b|\bzest of\b/.test(name)) pick = { amount: 1, unit: { kind: "volume", unit: "tsp" }, why: "zest with no amount, about 1 tsp" };
    else if (/^(?:boiled |boiling |cold |warm |hot |tap |filtered )?water$/.test(name)) pick = { amount: 1, unit: { kind: "volume", unit: "cup" }, why: "water has no calories, so 1 cup is a placeholder" };
    else if (/\bslices?\b/.test(name) && /\b(?:cheese|tomato|bread|ham|turkey|pickle|onion)\b/.test(name)) pick = { amount: 1, unit: { kind: "count", noun: "slice" }, why: "one slice" };
    else if (/\blettuce leaf\b|\bleaf of lettuce\b/.test(name)) pick = { amount: 1, unit: { kind: "count", noun: "leaf" }, why: "one leaf" };
  }
  if (!pick) return p;
  const FRAC: Record<number, string> = { 0.0625: "1/16", 0.125: "⅛", 0.25: "¼", 0.5: "½" };
  const shown = `${FRAC[pick.amount] ?? fmt(pick.amount)} ${unitText(pick.unit)}`;
  return {
    ...p,
    amount: pick.amount,
    amountMax: null,
    unit: pick.unit,
    name: p.name.replace(/^(?:a\s+)?(?:big\s+|small\s+|large\s+)?(?:pinch(?:es)?|dash(?:es)?|splash(?:es)?|drops?|spoonfuls?|dollops?|squeeze|drizzle|sprinkle|handfuls?)\s+(?:of\s+)?/i, "").replace(/^(?:garnish(?:ed)?(?:\s+with)?|to taste:?)\s+/i, "").replace(/\s+(?:for garnish|to garnish)$/i, "") || p.name,
    flags: [
      ...p.flags.filter((f) => f.severity !== "fix"),
      { code: "suggested", severity: "check", message: `No amount given: using ${shown}. Change it if you use more or less.` },
    ],
  };
}

/** Reads a whole recipe. `text` is whatever was pasted or extracted. */
export function parseRecipeText(text: string): ParsedRecipe {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(tidyLine);

  let title: string | null = null;
  let servings: number | null = null;
  let servingsRange = false;
  let itemServings: string | null = null;
  let titleOpen = false;
  const notes: string[] = [];
  const steps: string[] = [];
  const ingredientLines: { text: string; group: string | null; joined: boolean; bulleted: boolean }[] = [];
  let mode: "start" | "ingredients" | "steps" | "notes" | "nutrition" | "skip" = "start";
  let sawIngredientHeader = false;
  let sawStepHeader = false;
  let group: string | null = null;
  let stepOpen = false; // last step may continue on the next line
  let numbered = false; // steps are numbered, so unnumbered lines continue the step above
  let newStep = false; // a "STEP 2" marker: the next line starts a new step
  // A notes heading that broke into the steps ("» Continue" after it): its bullet points come after the last step.
  let notesBefore = 0;
  let notesWaiting = false;
  const groupNames = new Set<string>();
  let lastInlineStep = false;
  // Lines before the first section heading: the title may span lines ("HIGH PROTEIN / CHICKEN ALFREDO / PIZZA").
  const firstHeader = lines.findIndex((l) => H_INGREDIENTS.test(stripBullet(l.trim())) || H_STEPS.test(stripBullet(l.trim())));
  if (firstHeader > 0) {
    const runs: number[][] = [];
    let run: number[] = [];
    for (let k = 0; k < firstHeader; k++) {
      const t = stripBullet(lines[k]!.trim());
      const caps = t.length > 1 && t === t.toUpperCase() && /[A-Z]{2}/.test(t) && t.split(/\s+/).length <= 5 && !JUNK.test(t) && !FOOTER.test(t) && !META.test(t) && !/\d/.test(t);
      if (caps) run.push(k);
      else if (t !== "" || run.length) {
        if (run.length) runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    const multi = runs.filter((r) => r.length >= 2).at(-1);
    if (multi) {
      title = multi.map((k) => lines[k]!.trim()).join(" ");
      for (const k of multi) lines[k] = "";
    }
  }
  const firstIngredientHeader = lines.findIndex((l) => H_INGREDIENTS.test(stripBullet(l.trim())));
  const nextLine = (i: number) => lines.slice(i + 1).find((l) => l.trim() !== "" && !FOOTER.test(l.trim()));

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li]!;
    const line = rawLine.trim();
    const afterBlank = li === 0 || lines[li - 1]!.trim() === "";
    if (!line) {
      stepOpen = false;
      continue;
    }
    const labelled: RegExpMatchArray | null = servings === null ? line.match(/\bservings?\s*:\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/i) : null;
    if (labelled && (line.length > 60 || JUNK.test(line) || META.test(line))) {
      // "Course: Dinner … Servings: 4Calories: 421kcal": the servings inside a run-together details line.
      servings = Number(labelled[1]);
      servingsRange = Boolean(labelled[2]);
      continue;
    }
    if (FOOTER.test(line) || JUNK.test(line)) continue;
    let bare = stripBullet(line);
    // "subheading: Dressing:" (some recipe-saver apps)
    const sub = bare.match(/^(?:subheading|sub-heading|section)\s*:\s*(.+?)\s*:?$/i);
    if (sub && (mode === "ingredients" || mode === "start")) {
      mode = "ingredients";
      group = cleanHeader(sub[1]!);
      continue;
    }
    if (CONTINUE.test(bare)) {
      // "» Continue": the steps carry on after a box (such as a notes box) that broke into them.
      if (mode === "notes" && steps.length > 0) {
        mode = "steps";
        notesWaiting = notes.length === notesBefore;
      }
      continue;
    }
    // "Yield: 1 loaf, 16 slices": the pieces are the servings, not the loaf.
    const whole = line.match(/\b(?:yields?|makes)\b\s*:?\s*\d+\s*(?:loaf|loaves|pan|pans|cake|cakes|pie|pies|batch|batches|tray|trays)\b.*?\b(\d+)\s*(?:slices|pieces|squares|bars|muffins|cookies|servings|portions)\b/i);
    const s = whole ? ([whole[0], whole[1]] as unknown as RegExpMatchArray) : line.match(SERVINGS_AFTER) ?? line.match(SERVINGS);
    if (H_INGREDIENTS.test(bare)) {
      mode = "ingredients";
      sawIngredientHeader = true;
      group = null;
      if (servings === null && s) {
        servings = Number(s[1]);
        servingsRange = Boolean(s[2]);
      }
      // "Ingredients (2 Burgers)", "(6-8 Tacos)": one item counts as one serving.
      const items: RegExpMatchArray | null = servings === null ? bare.match(/\((?:for |makes |approx\.?\s*)?(\d+)\s*(?:-|–|to)?\s*(\d+)?\s*(?:medium |large |small |mini |spicy )?(wraps?|burgers?|bowls?|tacos?|pancakes?|muffins?|cookies?|bars?|pizzas?|burritos?|sandwich(?:es)?|quesadillas?|bites?|balls?|slices?|pieces?|portions?|people)\)/i) : null;
      if (items) {
        servings = Number(items[1]);
        servingsRange = Boolean(items[2]);
        itemServings = items[3]!.toLowerCase();
      }
      continue;
    }
    if (H_STEPS.test(bare)) {
      mode = "steps";
      sawStepHeader = true;
      stepOpen = false;
      continue;
    }
    if (H_NOTES.test(bare)) {
      mode = "notes";
      notesBefore = notes.length;
      continue;
    }
    if (STEP_MARKER.test(bare)) {
      mode = "steps";
      numbered = true;
      newStep = true;
      continue;
    }
    if (H_EQUIPMENT.test(bare)) {
      mode = "skip";
      continue;
    }
    if (mode === "skip") continue;
    const servingsOnly = /^(?:for |makes |serves )?\d+\s*(?:-|–|to)?\s*\d*\s*(?:servings?|portions?|people|meals)\b\.?$/i.test(bare);
    if (servings === null && s && line.length <= 60 && !looksLikeStep(line) && (servingsOnly || !(mode === "ingredients" && looksLikeIngredient(line)))) {
      servings = Number(s[1]);
      servingsRange = Boolean(s[2]);
      if (mode !== "steps") continue;
    }
    if (H_NUTRITION.test(bare) && (mode !== "steps" || bare.split(/\s+/).length <= 3)) {
      mode = "nutrition";
      continue;
    }
    if (META.test(bare)) continue;
    if (mode === "nutrition") {
      // A nutrition panel's own numbers ("597", "59g") and, before the Ingredients heading, the description under it.
      const panelValue = /^\d{1,4}(?:\.\d)?\s*(?:g|mg|kcal)?$/i.test(bare);
      if (firstHeader > li && !panelValue && !looksLikeIngredient(line)) notes.push(bare);
      if (!panelValue && firstHeader < li && looksLikeIngredient(line) && !/\b(kcal|calories|protein|carbs?|fat|fiber|sugar|sodium)\b/i.test(line)) mode = "ingredients";
      else continue;
    }

    if (mode === "start" && titleOpen) {
      // A name printed over two lines ("Honey Garlic Butter" / "chicken Mac n cheese").
      titleOpen = false;
      if (!afterBlank && bare.length <= 40 && bare.split(/\s+/).length <= 6 && !/\d|[.!?:,]$/.test(bare) && !/^by\b/i.test(bare) && !NOT_TITLE.test(bare) && !looksLikeIngredient(line) && !isGroupHeader(line)) {
        title = cleanTitle(`${title} ${bare}`);
        continue;
      }
    }
    if (mode === "start") {
      const headerAhead = firstHeader > li;
      // Everything between the name and the "Ingredients" heading is an introduction (a nutrition panel's numbers are dropped).
      const ingredientsAhead = firstIngredientHeader > li;
      if (ingredientsAhead && title !== null && /^\d{1,4}(?:\.\d)?\s*(?:g|mg|kcal)?$/i.test(bare)) continue;
      if (headerAhead && title !== null && (ingredientsAhead || !looksLikeIngredient(line))) {
        // Before the "Ingredients" heading: a description or intro, not steps.
        notes.push(bare);
        continue;
      }
      if (looksLikeIngredient(line) && !(headerAhead && title === null && !AMOUNT_START.test(stripBullet(line)))) mode = "ingredients";
      else if (looksLikeStep(line) && !headerAhead) mode = "steps";
      else if (NOT_TITLE.test(bare)) continue;
      else if (title === null) {
        title = cleanTitle(bare);
        titleOpen = true;
        continue;
      } else if (isGroupHeader(line) || looksLikeUnmarkedHeader(line, nextLine(li), afterBlank)) {
        mode = "ingredients";
        group = cleanHeader(line);
        continue;
      } else {
        notes.push(line);
        continue;
      }
    }

    if (NOT_TITLE.test(bare) && !looksLikeIngredient(line)) continue;
    if (mode === "ingredients" && (/^(?:\*+\s*)?(?:note|notes|tip|tips|substitute|substitution|swap|serve (?:with|over)|photo note|optional extras?)\s*:/i.test(bare) ||
      (!looksLikeIngredient(line) && /^(?:i|we|you|distribute|divide|portion|mix|stir|combine|then|serve with|this|these|it's|it is)\b/i.test(bare) && bare.split(/\s+/).length >= 3) || /^\([^)]*\)$/.test(bare) && /\b(?:mix|in a bowl|set aside)\b/i.test(bare))) {
      // "Note: …", "Serve with: …", "*Substitute: …" inside the list: a note, not an ingredient.
      notes.push(bare.replace(/^\*+\s*/, ""));
      continue;
    }
    if (mode === "ingredients") {
      // An amount on its own line belongs to the food on the next line ("0.13 cup" / "jarred mild salsa").
      const ni = lines.findIndex((l, k) => k > li && l.trim() !== "");
      const next = ni > 0 ? lines[ni]!.trim() : undefined;
      if (next && AMOUNT_ONLY.test(bare) && !looksLikeIngredient(next) && !isSectionHeading(next) && !H_STEPS.test(stripBullet(next))) {
        lines[ni] = `${bulleted(rawLine) ? "• " : ""}${bare} ${stripBullet(next)}`;
        continue;
      }
      // Two ingredients run together on one line ("... bananas) 2 teaspoons vanilla extract"): split them.
      const two = looksLikeIngredient(line) || (/^[a-z]/.test(bare) && !looksLikeStep(line)) ? bare.match(SECOND_AMOUNT) : null;
      if (two && two.index! >= 3) {
        lines.splice(li + 1, 0, bare.slice(two.index! + 1));
        bare = bare.slice(0, two.index!).trim();
        lines[li] = bulleted(rawLine) ? `• ${bare}` : bare;
        li--;
        continue;
      }
      // Without a steps header, a step-like line starts the steps. Under an "Ingredients" header only a
      // numbered step or a full sentence does, so "Drizzle of: sesame oil" stays an ingredient.
      const stepLike = sawIngredientHeader
        ? /^\s*(?:step\s*)?\d{1,2}\s*[.):]\s*[A-Za-z]/i.test(line) || (line.split(/\s+/).length >= 9 && /[.!]$/.test(line))
        : looksLikeStep(line);
      const prev = ingredientLines.at(-1);
      const openParen = prev ? (prev.text.match(/\(/g)?.length ?? 0) > (prev.text.match(/\)/g)?.length ?? 0) : false;
      const parenLabel = /\b(?:weight|optional|approx|per|each|cooked|raw|uncooked|dry)\b/i.test(bare) ? null : bare.match(/^\(\s*([A-Z][A-Za-z &'’-]{1,30}?)\s*\)$/);
      // Cooking steps written between ingredient sections ("• Spread chicken thighs evenly on sheet pan…").
      const inlineStep = sawIngredientHeader && !sawStepHeader && !looksLikeIngredient(line) && !parenLabel && !/:/.test(bare) &&
        !/^(?:season|sprinkle|dust|rub)\b[^,]*\bwith\b[^,]+,[^,]+,/i.test(bare) &&
        ((STEP_VERBS.has(bare.split(/\s+/)[0]!.toLowerCase().replace(/[^a-zé-]/g, "")) && bare.split(/\s+/).length >= 5) || bare.split(/\s+/).length >= 12);
      if (!openParen && parenLabel && next && looksLikeIngredient(next)) {
        // "(Dough)", "(Alfredo Sauce)": a section label in brackets.
        group = cleanHeader(parenLabel[1]!);
        groupNames.add(normName(group));
        continue;
      }
      if (inlineStep && !openParen) {
        steps.push(bare);
        lastInlineStep = true;
        continue;
      }
      if (lastInlineStep && !bulleted(rawLine) && /^[a-z]/.test(bare) && steps.length) {
        steps[steps.length - 1] = `${steps.at(-1)} ${bare}`;
        continue;
      }
      lastInlineStep = false;
      if (!sawStepHeader && !looksLikeIngredient(line) && stepLike) {
        mode = "steps";
      } else if (prev && !looksLikeIngredient(line) && (openParen || (/^\(/.test(bare) && !bulleted(rawLine)) || (unbalanced(bare) && !bulleted(rawLine)))) {
        // "(or butter of choice)" under "20g Butter", or the rest of "(or any" on the next line.
        prev.text = `${prev.text} ${bare}`;
        prev.joined = true;
        continue;
      } else if ((isGroupHeader(line) && !looksLikeIngredient(line)) || looksLikeUnmarkedHeader(line, nextLine(li), afterBlank, prev?.text)) {
        group = cleanHeader(line);
        groupNames.add(normName(group));
        continue;
      } else {
        // A wrapped line: a word or two in lowercase with no amount ("cheese" after "1 cup shredded cheddar"),
        // a line without a bullet in a bulleted list, or anything following a line that ends mid-phrase.
        // A note on its own line under the ingredient ("large, halved and sliced", "drained", "we like just bouillon").
        const midName = prev ? WRAP_END.test(prev.text) && !/,$/.test(prev.text) : false;
        if (prev && !midName && !looksLikeIngredient(line) && !bulleted(rawLine) && /^[a-z]/.test(bare) && (bare.includes(",") || NOTE_START.test(bare)) && !/,$/.test(prev.text)) {
          prev.text = /,|\(/.test(stripBullet(prev.text).replace(/^\S+\s+\S+/, "")) ? `${prev.text}; ${bare}` : `${prev.text}, ${bare}`;
          prev.joined = true;
          continue;
        }
        // "20g Parmigiano" / "Reggiano": a food name finished on the next line.
        const finishesName = prev && !bulleted(rawLine) && !looksLikeIngredient(line) && bare.split(/\s+/).length <= 2 && CONTINUES_NAME.test(bare) && AMOUNT_START.test(stripBullet(prev.text)) && !afterBlank;
        // "300g day-old" / "cooked white rice (300g": the name goes on, and its only amount is in brackets.
        const outsideParens = bare.replace(/\([^)]*\)?/g, " ");
        const nameGoesOn = prev && midName && !bulleted(rawLine) && /^[a-z]/.test(bare) && !looksLikeIngredient(outsideParens) && !AMOUNT_START.test(bare);
        const wrapped =
          nameGoesOn || prev && !looksLikeIngredient(line) && !bulleted(rawLine) && (finishesName ||
          ((/^[a-z(]/.test(bare) && bare.split(/\s+/).length <= 2) ||
            (prev.bulleted && !afterBlank) ||
            WRAP_END.test(prev.text) ||
            /^(?:or|and|\+)\s/i.test(bare)));
        if (wrapped && prev) {
          prev.text = `${prev.text} ${bare}`;
          prev.joined = true;
        } else {
          ingredientLines.push({ text: line, group, joined: false, bulleted: bulleted(rawLine) });
        }
        continue;
      }
    }

    if (mode === "steps" && notesWaiting && numbered && afterBlank && bulleted(rawLine) && !STEP_PREFIX.test(bare)) {
      mode = "notes";
      notesWaiting = false;
    }
    // "Beef and Marinade" / "Frying" above steps: a section label, not a step.
    if (mode === "steps" && !STEP_PREFIX.test(bare) && (groupNames.has(normName(bare)) || (/:$/.test(bare) && bare.split(/\s+/).length <= 5) ||
      (bare.split(/\s+/).length <= 4 && /^[A-Z]/.test(bare) && !stepOpen && !/[.!?,]$/.test(bare) && bare.split(/\s+/).every((w) => w.length <= 3 || /^[A-Z]/.test(w)) && !STEP_VERBS.has(bare.split(/\s+/)[0]!.toLowerCase())))) {
      stepOpen = false;
      continue;
    }
    if (mode === "steps") {
      const m = bare.match(STEP_PREFIX);
      const body = m ? bare.slice(m[0].length).trim() : bare;
      if (!body) continue;
      if (/^(?:enjoy|serve and enjoy)!?$/i.test(body) && steps.length > 0) {
        steps[steps.length - 1] = `${steps.at(-1)} ${body}`;
        continue;
      }
      if (m) numbered = true;
      const startsNew = newStep || (!numbered && STEP_VERBS.has(body.split(/\s+/)[0]!.toLowerCase().replace(/[^a-zé-]/g, "")) && !/^(?:in|when|once|then|while|after|using)$/i.test(body.split(/\s+/)[0]!));
      const continues = steps.length > 0 && !m && !startsNew && (/^[a-z]/.test(body) || ((stepOpen || numbered) && !bulleted(rawLine)));
      if (continues) {
        // "zero-" + "calorie" was one word split across lines.
        const prevStep = steps.at(-1)!;
        steps[steps.length - 1] = /[a-z]-$/.test(prevStep) && /^[a-z]/.test(body) ? `${prevStep}${body}` : `${prevStep} ${body}`;
      } else {
        steps.push(body);
      }
      newStep = false;
      stepOpen = !/[.!?)]$/.test(body);
      continue;
    }

    if (mode === "notes") notes.push(bare);
  }

  /** "300g cooked white rice (300g dry weight, ~700g cooked)": the dry weight is what the nutrition needs. */
  const preferDryWeight = (p: ParsedIngredient): ParsedIngredient => {
    const m = p.raw.match(/(\d+(?:\.\d+)?)\s*(g|grams?|oz|ounces?)\s*(?:\(|,)?\s*(?:dry|uncooked|raw)(?:\s+weight)?\b/i) ?? p.raw.match(/\b(?:dry|uncooked|raw)\s+weight[:\s]*(\d+(?:\.\d+)?)\s*(g|grams?|oz|ounces?)\b/i);
    if (!m || !/\bcooked\b/i.test(p.name) || /\buncooked\b/i.test(p.name)) return p;
    if (!/\b(?:rice|pasta|noodles|quinoa|couscous|oats|lentils|beans|spaghetti|penne|macaroni|orzo)\b/i.test(p.name)) return p;
    const amount = Number(m[1]);
    const unit = /^o/i.test(m[2]!) ? "oz" : "g";
    const name = p.name.replace(/\b(?:day-old\s+)?cooked\b/i, "uncooked").replace(/\s+/g, " ").trim();
    return {
      ...p,
      amount,
      amountMax: null,
      unit: { kind: "mass", unit },
      name,
      prep: [p.prep?.replace(/^\(|\)$/g, ""), "cooked before use"].filter(Boolean).join("; "),
      flags: [...p.flags.filter((f) => f.severity !== "fix" && f.code !== "amounts_disagree"), { code: "unusual", severity: "check", message: `Uses the dry weight given (${amount} ${unit} uncooked); the app works out the cooked weight.` }],
    };
  };

  // One line per ingredient: "1 tsp each: salt, pepper" becomes two lines.
  const expanded = ingredientLines.flatMap((l) => {
    const parts = splitEach(l.text) ?? splitList(l.text);
    if (!parts) {
      const p = preferDryWeight(parseIngredientLine(l.text, l.group));
      if (l.joined) p.flags.push({ code: "joined_line", severity: "check", message: "Joined two lines into one ingredient. Check it." });
      return [p];
    }
    return parts.map((t) => {
      const p = parseIngredientLine(t, l.group);
      p.flags.push({ code: "split_line", severity: "check", message: `Split from "${stripBullet(l.text)}". Check it.` });
      return p;
    });
  });
  const ingredients = tidyUnmeasured(expandSubRecipes(expanded).map(suggestAmount), notes, servings);

  const flags: ImportFlag[] = [];
  if (!title) flags.push({ code: "no_title", severity: "fix", message: "No recipe name found: enter one." });
  if (servings === null) flags.push({ code: "no_servings", severity: "fix", message: "How many servings the recipe makes wasn't found: enter it." });
  else if (servingsRange) flags.push({ code: "no_servings", severity: "fix", message: "Servings are given as a range: enter the number this recipe makes." });
  else if (itemServings) flags.push({ code: "no_servings", severity: "check", message: `Makes ${servings} ${itemServings}: counted as ${servings} serving${servings === 1 ? "" : "s"}. Change it if a serving is different.` });
  if (ingredients.length === 0) flags.push({ code: "no_ingredients", severity: "fix", message: "No ingredients found. Check that the ingredient list was included." });
  if (steps.length === 0) flags.push({ code: "no_steps", severity: "fix", message: "No instructions found: add them." });
  return { title, servings, ingredients, steps, notes, flags, printed: findPrintedNutrition(text) };
}

const SERVE_GROUP = /\b(?:to serve|serve with|serving|for serving|garnish|garnishes|toppings?|sides?|extra sides?|optional|to finish)\b/i;
const HEADERISH = /(?:\bbig batch\b|\bstores? for\b|^(?:to serve|serve with|for serving|garnish(?:es)?|toppings?|extra sides?|sides?|optional extras?)$|\b(?:sauce|marinade|mix|glaze|dressing|slaw|seasoning|rub|base|bowls?|mac n cheese|salad)$)/i;
const PROSE = /(?:[.!?:]$|\b(?:you|your|i|we|my|keep|until|minutes?|mins|goal|always|never|do not|don't|if the|once it|for desired|when serving|rule of thumb)\b)/i;
const TOPPING_VEG = /\b(?:lettuce|tomato(?:es)?|cherry tomatoes|onions?|red onions?|pickled red onions?|pickles?|gherkins?|cabbage|carrots?|cucumbers?|spinach|rocket|arugula|greens|salad|jalape(?:ñ|n)os?|radish(?:es)?|sprouts|herbs?|parsley|cilantro|coriander|mint|basil|lime wedges?|lemon wedges?|chillis?|chilies?)\b/i;
const ONE_EACH = /\b(?:buns?|rolls?|tortillas?|wraps?|pitas?|flatbreads?|naan|bagels?|english muffins?|slices? of bread|bread slices?|burger buns?|brioche)\b/i;

/**
 * Lines with no amount, sorted out without asking where the meaning is clear:
 * sentences from the book become notes; a title such as "Chipotle Sauce (big
 * batch)" becomes the section name for the lines after it; a serving
 * suggestion ("To serve: shredded lettuce") is left out of the nutrition; a
 * bun, wrap or tortilla with no number is one per serving. Real foods with
 * no amount elsewhere still ask.
 */
function tidyUnmeasured(list: ParsedIngredient[], notes: string[], servings: number | null): ParsedIngredient[] {
  const out: ParsedIngredient[] = [];
  let renamed: { from: string | null; to: string } | null = null;
  for (let i = 0; i < list.length; i++) {
    let p = list[i]!;
    if (renamed && p.group === renamed.from) p = { ...p, group: renamed.to };
    else renamed = null;
    const noAmount = p.amount === null && p.flags.some((f) => f.code === "no_amount");
    if (!noAmount) {
      out.push(p);
      continue;
    }
    const bare = p.raw.replace(/^[•\-–*\s]+/, "");
    const outside = bare.replace(/\([^)]*\)?/g, " ").replace(/\s+/g, " ").trim();
    const words = bare.split(/\s+/).filter(Boolean);
    const outsideWords = outside.split(/\s+/).filter(Boolean);
    if ((outsideWords.length >= 4 && PROSE.test(outside)) || (/^[a-z]/.test(bare) && outsideWords.length >= 5 && !/,/.test(bare))) {
      notes.push(p.raw.replace(/^[•\-–*\s]+/, ""));
      continue;
    }
    const firstWord = words[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
    if (STEP_VERBS.has(firstWord) && words.length >= 3) {
      notes.push(p.raw.replace(/^[•\-–*\s]+/, ""));
      continue;
    }
    const next = list[i + 1];
    if (HEADERISH.test(p.name.replace(/\s*\([^)]*\)\s*$/, "").trim()) || /\(big batch|stores? for/i.test(p.raw)) {
      if (next && next.group === p.group) renamed = { from: p.group, to: p.name.replace(/\s*\((?:big batch|stores?)[^)]*\)\s*$/i, "").trim() };
      continue;
    }
    const strip = (q: ParsedIngredient) => q.flags.filter((f) => f.code !== "no_amount");
    if ((p.group && SERVE_GROUP.test(p.group)) || SERVE_GROUP.test(p.raw) || p.optional) {
      out.push({ ...p, optional: true, flags: [...strip(p), { code: "optional", severity: "check", message: "Serving suggestion with no amount: left out of the nutrition. Add an amount to count it." }] });
      continue;
    }
    if (TOPPING_VEG.test(p.name) && !/\b(?:rice|pasta|potatoes|beans|chicken|beef|cheese)\b/i.test(p.name)) {
      out.push({ ...p, optional: true, flags: [...strip(p), { code: "optional", severity: "check", message: "Topping with no amount: left out of the nutrition (very few calories). Add an amount to count it." }] });
      continue;
    }
    if (ONE_EACH.test(p.name) && servings) {
      out.push({ ...p, amount: servings, unit: { kind: "count", noun: p.name.split(/\s+/).at(-1)!.toLowerCase().replace(/s$/, "") }, flags: [...strip(p), { code: "suggested", severity: "check", message: `No number given: using one per serving (${servings}). Change it if you use more.` }] });
      continue;
    }
    out.push(p);
  }
  return out;
}

const normName = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A mix made in its own section ("Taco Spice Mix (1 Serving)") and then used by
 * the serving elsewhere ("1 Serving Taco Spice Mix", "1.5 Serving Taco Spice
 * Mix"): the mix's lines are scaled to the total used (2.5 servings) and the
 * "serving" lines are dropped, so the nutrition counts what actually goes in.
 */
function expandSubRecipes(list: ParsedIngredient[]): ParsedIngredient[] {
  const groups = new Map<string, { serves: number; uses: number[] }>();
  for (const p of list) {
    if (!p.group) continue;
    const key = normName(p.group);
    const serves = Number(p.group.match(/\((\d+(?:\.\d+)?)\s*servings?\)/i)?.[1] ?? 1) || 1;
    if (!groups.has(key)) groups.set(key, { serves, uses: [] });
  }
  const isUse = (p: ParsedIngredient) =>
    p.unit?.kind === "count" && p.unit.noun === "serving" && p.amount !== null && groups.has(normName(p.name)) && !(p.group && normName(p.group) === normName(p.name));
  for (const p of list) if (isUse(p)) groups.get(normName(p.name))!.uses.push(p.amount!);
  const out: ParsedIngredient[] = [];
  for (const p of list) {
    if (isUse(p)) continue;
    const mix = p.group ? groups.get(normName(p.group)) : undefined;
    if (mix && mix.uses.length > 0) {
      const total = mix.uses.reduce((a, b) => a + b, 0);
      const factor = total / mix.serves;
      const mixName = p.group!.replace(/\s*\([^)]*\)\s*$/, "");
      out.push({
        ...p,
        raw: `${p.raw} × ${fmt(factor)}`,
        group: mixName,
        amount: p.amount === null ? null : p.amount * factor,
        amountMax: p.amountMax === null ? null : p.amountMax * factor,
        flags: [
          ...p.flags.filter((f) => f.code !== "split_line"),
          { code: "sub_recipe", severity: "check", message: `${mixName} is used ${mix.uses.length > 1 ? `${mix.uses.map(fmt).join(" + ")} = ` : ""}${fmt(total)} serving${total === 1 ? "" : "s"} in this recipe, so this amount is × ${fmt(factor)}.` },
        ],
      });
      continue;
    }
    if (p.unit?.kind === "count" && p.unit.noun === "serving") {
      p.flags.push({ code: "unusual", severity: "fix", message: `"Serving" isn't a measurable amount: enter the grams (check the product label).` });
    }
    out.push(p);
  }
  return out;
}
