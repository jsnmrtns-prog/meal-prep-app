/**
 * Suggests USDA foods for an imported ingredient and turns a reviewed import
 * into a recipe. Suggestions are only suggestions: the review screen asks you
 * to confirm every food before the recipe is saved.
 */
import { gramsForAmount, type Food, type FoodDb } from "../fooddb.ts";
import type { IngredientLine, IngredientRole, LineCook, MeasuredState, Quantity, Recipe, RecipeSource } from "../recipe.ts";
import type { ParsedIngredient, ParsedUnit } from "./parse.ts";
import { stepMentionsLine } from "../audit.ts";

const PREP_WORDS = new Set([
  "chopped", "diced", "minced", "sliced", "shredded", "grated", "crushed", "cubed", "halved", "quartered", "julienned",
  "fresh", "freshly", "finely", "thinly", "roughly", "coarsely", "peeled", "trimmed", "rinsed", "drained", "packed",
  "softened", "melted", "divided", "optional", "about", "approximately", "of", "the", "a", "an", "for", "to", "taste",
  "uncooked", "dry", "choice", "your", "favorite", "organic", "large", "medium", "small", "extra", "day", "old", "in", "florets",
]);
const COOKED = /\b(cooked|boiled|roasted|fried|baked|grilled|braised|broiled|stewed|steamed|microwaved|simmered|pan-browned|canned|smoked|cured)\b/i;
const NOT_WANTED = /\b(with added solution|babyfood|baby food|infant|imitation|dehydrated|freeze-dried|restaurant|fast foods?)\b/i;

/** Names people use that USDA words differently. */
const SYNONYMS: [RegExp, string][] = [
  [/\bground beef (\d{2})\s*\/\s*\d{1,2}\b/i, "beef ground $1% lean meat raw"],
  [/\b(\d{2})%(?: lean)?(?: \w+)?(?: (?:ground|mince|minced))+(?:\/(?:ground|mince|minced))? beef\b/i, "beef ground $1% lean meat raw"],
  [/\b(\d{2})% (?:lean )?ground beef\b/i, "beef ground $1% lean meat raw"],
  [/\b(\d{2})% (?:lean )?ground turkey\b/i, "turkey ground $1% lean raw"],
  [/\bground turkey (\d{2})%/i, "turkey ground $1% lean raw"],
  [/\b(?:scallions?|green onions?)\b/i, "onions spring or scallions raw"],
  [/\b(?:chili|chilli|red pepper) flakes\b|\bcrushed red pepper\b/i, "spices pepper red or cayenne"],
  [/\b(red|yellow|green|orange) (?:bell )?peppers?\b(?! flakes)/i, "peppers sweet $1 raw"],
  [/(?<!(?:peanut|almond|nut|cashew|seed|apple|cocoa|shea) )\b(?:reduced[- ]fat|light|lite|low[- ]fat|half[- ]fat) butter\b/i, "butter light stick with salt"],
  [/\bsesame seeds?\b/i, "seeds sesame seeds whole dried"],
  [/\b(?:ginger powder|ground ginger|dried ginger)\b/i, "spices ginger ground"],
  [/^(?:any |regular |dairy |cow'?s )?milk(?: of choice)?$/i, "milk reduced fat fluid 2% milkfat with added vitamin a and vitamin d"],
  [/\blime wedges?\b/i, "limes raw"],
  [/\blemon wedges?\b/i, "lemons raw without peel"],
  [/\bparsley flakes\b|\bdried parsley\b/i, "spices parsley dried"],
  [/^(?:fresh |chopped |flat[- ]leaf |italian )*parsley$/i, "parsley fresh"],
  [/\bitalian seasoning\b|\bmixed herbs\b|\bherbes de provence\b/i, "spices oregano dried"],
  [/\b(?:tandoori|garam) masala\b/i, "spices curry powder"],
  [/\b(?:ground coriander|coriander powder|coriander seeds?)\b/i, "spices coriander seed"],
  [/(?:\bfat[- ]free|\bskim|\bnonfat|\bnon-fat|\b0%)\s+milk\b/i, "milk nonfat fluid with added vitamin a and vitamin d fat free or skim"],
  [/\b(?:low[- ]fat|1%)\s+milk\b/i, "milk lowfat fluid 1% milkfat with added vitamin a and vitamin d"],
  [/\b(?:reduced[- ]fat|2%)\s+milk\b/i, "milk reduced fat fluid 2% milkfat with added vitamin a and vitamin d"],
  [/\bwhole milk\b/i, "milk whole 3.25% milkfat with added vitamin d"],
  [/\b(?:light|lite|reduced[- ]fat|low[- ]fat)\s+mayo(?:nnaise)?\b/i, "salad dressing mayonnaise light"],
  [/\btomato paste\b/i, "tomato products canned paste without salt added"],
  [/\bgarlic salt\b/i, "salt table"],
  [/\bheavy (?:whipping )?cream\b|\bdouble cream\b/i, "cream fluid heavy whipping"],
  [/\bswiss cheese\b/i, "cheese swiss"],
  [/\bcajun seasoning\b|\bcreole seasoning\b/i, "spices paprika"],
  [/\bbell peppers?\b/i, "peppers sweet raw"],
  [/\b(onion|garlic|chili|curry) powder\b/i, "spices $1 powder"],
  [/\bchilli powder\b/i, "spices chili powder"],
  [/\bchipotle\b/i, "peppers hot chili red canned"],
  [/\b(?:buffalo |louisiana |cayenne )?hot sauce\b|\bbuffalo sauce\b|\bfrank'?s\b/i, "sauce ready-to-serve pepper or hot"],
  [/^(?:fresh |ripe |plum |vine )?tomato(?:e?s)?$/i, "tomatoes red ripe raw year round average"],
  [/\b(lime|lemon) juice\b/i, "$1 juice raw"],
  [/\bjalape[nñ]os?\b/i, "peppers jalapeno raw"],
  [/\bchicken breasts?\b/i, "chicken breast boneless skinless raw"],
  [/\bchicken thighs?\b/i, "chicken thigh boneless skinless raw"],
  [/\begg whites?\b/i, "egg white raw"],
  [/^(?:large |whole )?eggs?$/i, "egg whole raw fresh"],
  [/\bgreek yogurt\b/i, "yogurt greek plain nonfat"],
  [/\bwhite rice\b|^rice$|\bjasmine rice\b/i, "rice white long-grain regular raw"],
  [/\bcooked (?:white |jasmine )?rice\b/i, "rice white long-grain regular cooked"],
  [/\bbrown rice\b/i, "rice brown long-grain raw"],
  [/\bcooked brown rice\b/i, "rice brown long-grain cooked"],
  [/\b(?:penne|spaghetti|rotini|macaroni|elbow|orzo|pasta)\b/i, "pasta dry enriched"],
  [/\b(olive|avocado|sesame|canola|coconut) oil\b/i, "oil $1"],
  [/\bvegetable oil\b|^oil$|^(?:cooking|neutral|frying) oil$/i, "oil soybean salad or cooking"],
  [/\bgarlic cloves?\b|\bcloves? (?:of )?garlic\b|^garlic\b(?! (?:powder|salt))/i, "garlic raw"],
  [/\bshrimp\b/i, "crustaceans shrimp raw"],
  [/(?:\b0%|\bfat[- ]free\b|\bnon-?fat\b).*\bcottage cheese\b/i, "cheese cottage nonfat uncreamed dry large or small curd"],
  [/\bcottage cheese\b/i, "cheese cottage lowfat 2% milkfat"],
  [/\bpart[- ]skim ricotta\b/i, "cheese ricotta part skim milk"],
  [/\bpart[- ]skim mozzarella\b|\bmozzarella\b/i, "cheese mozzarella low moisture part-skim"],
  [/\blettuce\b/i, "lettuce iceberg raw"],
  [/\b(?:canned (?:chopped |diced |crushed |whole |plum )?|crushed |diced )tomato(?:e?s)?\b(?! (?:sauce|paste|puree|purée|juice))/i, "tomatoes red ripe canned packed in tomato juice"],
  [/\b(?:beef |chicken |vegetable )?(?:stock|bouillon) cubes?\b/i, "soup bouillon cubes and granules"],
  [/\bwalnuts?\b(?! (?:oil|butter|milk|flour|extract))/i, "nuts walnuts english"],
  [/\balmonds?\b(?! (?:oil|butter|milk|flour|extract))/i, "nuts almonds"],
  [/\bpecans?\b(?! (?:oil|butter|milk|flour|extract))/i, "nuts pecans"],
  [/\bcashews?\b(?! (?:oil|butter|milk|flour|extract))/i, "nuts cashew nuts raw"],
  [/\bpistachios?\b(?! (?:oil|butter|milk|flour|extract))/i, "nuts pistachio nuts raw"],
  [/\bpeanuts?\b(?! (?:oil|butter|flour))/i, "peanuts all types raw"],
  [/^(?:white |granulated |caster |cane )?sugar$/i, "sugars granulated"],
  [/\bcorn ?starch\b|\bcornflour\b/i, "cornstarch"],
  [/\b(?:hamburger |burger )?buns?\b/i, "rolls hamburger or hotdog"],
  [/^water$|^(?:cold|warm|hot|boiling) water$/i, "water tap"],
  [/^(?:black )?pepper$|\bground black pepper\b/i, "spices pepper black"],
  [/\b(?:chili|red pepper) flakes\b|\bcrushed red pepper\b/i, "spices pepper red or cayenne"],
  [/\b(?:frozen )?corn\b(?! ?(?:starch|meal|tortillas?|flour|syrup))/i, "corn sweet yellow"],
  [/\bsnap peas\b|\bsnow peas\b/i, "peas edible-podded raw"],
  [/\bchicken (?:broth|stock)\b/i, "soup chicken broth ready-to-serve"],
  [/\bbeef (?:broth|stock)\b/i, "soup beef broth ready-to-serve"],
  [/\bvegetable (?:broth|stock)\b/i, "soup vegetable broth ready to serve"],
  [/\bbay lea(?:f|ves)\b/i, "spices bay leaf"],
  [/\bsalmon\b/i, "fish salmon atlantic farmed raw"],
  [/\bbananas?\b/i, "bananas raw"],
  [/\bblueberries\b/i, "blueberries raw"],
  [/\b(?:rolled |old-fashioned )?oats\b/i, "oats rolled"],
  [/\bsweet potato(?:e?s)?\b/i, "sweet potato raw unprepared"],
  [/(?<!sweet )\bpotato(?:e?s)\b/i, "potatoes flesh and skin raw"],
  [/\bcarrots?\b/i, "carrots raw"],
  [/^onions?\b/i, "onions raw"],
  [/\bflour\b/i, "wheat flour white all-purpose enriched"],
  [/\bdijon\b/i, "mustard prepared"],
  [/\bbroccoli\b/i, "broccoli raw"],
];

/** Foods USDA doesn't have, where the suggestion is only the closest stand-in. */
const APPROXIMATE: [RegExp, string][] = [
  [/\bchipotle\b/i, "USDA has no chipotle paste"],
  [/\bcajun seasoning\b|\bcreole seasoning\b/i, "USDA has no Cajun seasoning"],
  [/\bitalian seasoning\b|\bmixed herbs\b|\bherbes de provence\b/i, "USDA has no Italian seasoning blend"],
  [/\b(?:tandoori|garam) masala\b/i, "USDA has no masala blend"],
  [/\bgarlic salt\b/i, "USDA has no garlic salt"],
  [/\bprotein pasta\b|\bchickpea pasta\b|\blentil pasta\b/i, "USDA has no protein pasta"],
  [/\bhollandaise\b/i, "USDA has no hollandaise"],
];

/** A note when the suggested food can only be a stand-in, so it isn't accepted without a look. */
export function approximateNote(name: string): string | null {
  const hit = APPROXIMATE.find(([re]) => re.test(name));
  return hit ? `${hit[1]}: the food picked is the closest stand-in. Change it, or add the product's label under Settings → Label foods.` : null;
}

/** How well a USDA description matches the search words: earlier, fuller matches score higher. */
function matchScore(description: string, terms: string[]): number {
  const w = description.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim().split(/\s+/);
  let score = 0;
  for (const t of terms) {
    const i = w.findIndex((x) => x === t || x === `${t}s` || x === `${t}es` || (t.length >= 4 && x.startsWith(t) && x.length - t.length <= 3));
    score += i === -1 ? -6 : 10 - Math.min(i, 6);
  }
  return score - 0.6 * Math.max(0, w.length - terms.length);
}

function singularWord(w: string): string {
  if (w.length <= 3 || /(?:ss|us|is)$/.test(w)) return w;
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The search words for an ingredient name, most important last (names usually end in the food). */
export function searchTerms(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9%\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !PREP_WORDS.has(w))
    .map(singularWord);
}

/** What the recipe needs from a food: a portion for counts, a volume weight for cups and spoons. */
export interface MatchWant {
  countWords?: string[];
  volume?: boolean;
}

function hasPortion(food: Food, want: MatchWant | undefined): boolean {
  if (!want) return true;
  if (want.volume) return food.portions.some((p) => p.unit !== null && ["cup", "tbsp", "tsp", "fl_oz", "ml"].includes(p.unit));
  if (want.countWords?.length) return food.portions.some((p) => want.countWords!.some((w) => new RegExp(`\\b${w}s?\\b`, "i").test(p.label)));
  return true;
}

/**
 * Up to `limit` USDA foods for an ingredient name, best first. Tries known
 * USDA wording first, then the name itself, then the name with leading words
 * dropped; prefers raw foods (unless the name says cooked) and records that
 * have the portion the recipe uses.
 */
export function suggestFoods(rawName: string, db: FoodDb, limit = 6, want?: MatchWant): Food[] {
  const name = rawName.replace(/yoghurt/gi, "yogurt").replace(/\bchilli\b/gi, "chili").replace(/\bmince\b/gi, "ground");
  const queries: string[] = [];
  for (const [re, q] of SYNONYMS) {
    const m = name.match(re);
    if (m) queries.push(m[0].replace(re, q));
  }
  // "cornstarch/cornflour", "scallions/shallots": each name on its own, the first one first.
  const alts = name.split(/(?<=[a-z])\s*\/\s*(?=[a-z])/i);
  if (alts.length > 1) {
    for (const [re, q] of SYNONYMS) {
      const m = alts[0]!.match(re);
      if (m) queries.push(m[0].replace(re, q));
    }
    for (const a of alts) if (searchTerms(a).length) queries.push(searchTerms(a).join(" "));
  }
  const terms = searchTerms(name);
  if (terms.length) queries.push(terms.join(" "));
  for (let k = 1; k < terms.length; k++) queries.push(terms.slice(k).join(" "));
  const wantsCooked = COOKED.test(name);
  const best = new Map<number, { food: Food; score: number }>();
  queries.forEach((q, qi) => {
    const qTerms = searchTerms(q);
    for (const f of db.search(q, 40)) {
      if (!f.usableForMacros) continue;
      let score = matchScore(f.description, qTerms) - qi * 4;
      if (NOT_WANTED.test(f.description)) score -= 40;
      // A soup or a condensed product is never what "black beans" means.
      if (/^soup\b|\bcondensed\b/i.test(f.description) && !/\b(?:soup|broth|stock|bouillon|condensed)\b/i.test(name)) score -= 20;
      if (COOKED.test(f.description) !== wantsCooked) score -= 8;
      if (!hasPortion(f, want)) score -= 15;
      if (f.dataset === "foundation") score += 0.5;
      // Brand-name records (UNCLE BENS, SILK) and snacks are rarely what a recipe means.
      if (/\b[A-Z]{3,}\b/.test(f.description.replace(/\bUSDA\b/g, "")) || /^snacks\b/i.test(f.description)) score -= 10;
      const prev = best.get(f.fdcId);
      if (!prev || prev.score < score) best.set(f.fdcId, { food: f, score });
    }
  });
  return [...best.values()].sort((a, b) => b.score - a.score || a.food.description.length - b.food.description.length).slice(0, limit).map((x) => x.food);
}

/** What `suggestFoods` should prefer for a parsed line. */
export function wantFor(p: Pick<ParsedIngredient, "unit" | "sizeWord" | "packageSize" | "name">): MatchWant | undefined {
  if (p.packageSize || p.unit?.kind === "mass") return undefined;
  // "1 package of shredded swiss cheese": you'll enter the package weight, so any record will do.
  if (p.unit?.kind === "count" && /^(?:package|packet|can|tin|jar|bag|box|carton|tub|bottle|pouch|container|block|envelope)$/.test(p.unit.noun)) return undefined;
  if (p.unit?.kind === "volume") return { volume: true };
  const words = [p.unit?.kind === "count" ? p.unit.noun : null, p.sizeWord].filter((w): w is string => Boolean(w));
  // "3 garlic cloves": the count word is the last word of the name. "1 red pepper" with no size: any whole-item size will do.
  if (words.length === 0) {
    const last = searchTerms(p.name.split(/\s*\/\s*/)[0]!).at(-1);
    if (last) words.push(last, "whole", "large", "medium", "small");
  }
  return { countWords: words };
}

/** A sensible role for a food, which you can change. */
export function guessRole(food: Food, name = ""): IngredientRole {
  const c = food.category;
  const d = `${food.description} ${name}`.toLowerCase();
  if (/\begg\b|\begg white/.test(d)) return "protein";
  if (/protein powder|whey/.test(d)) return "protein";
  if (["Poultry Products", "Beef Products", "Pork Products", "Finfish and Shellfish Products", "Lamb, Veal, and Game Products", "Sausages and Luncheon Meats"].includes(c)) return "protein";
  if (c === "Cereal Grains and Pasta" || c === "Baked Products" || c === "Breakfast Cereals") return "carb";
  if (c === "Legumes and Legume Products") return /tofu|tempeh/.test(d) ? "protein" : "carb";
  if (c === "Fats and Oils") return "fat";
  if (c === "Vegetables and Vegetable Products") return /potato|corn\b/.test(d) ? "carb" : "vegetable";
  if (c === "Fruits and Fruit Juices") return "vegetable";
  if (c === "Dairy and Egg Products") return "dairy";
  if (c === "Spices and Herbs") return "seasoning";
  if (c === "Soups, Sauces, and Gravies") return "sauce";
  return "other";
}

export function guessState(food: Food, name: string): MeasuredState {
  // Canned foods are weighed as they come out of the can, like the USDA "canned" records.
  if (/\bcanned\b/i.test(food.description) && !/\bcooked\b/i.test(name)) return "as_packaged";
  if (COOKED.test(name) || /\bcooked\b/i.test(food.description)) return COOKED.test(food.description) ? "cooked" : "raw";
  if (/frozen/i.test(food.description) || /\bfrozen\b/i.test(name)) return "frozen";
  if (food.category === "Cereal Grains and Pasta" && /\b(raw|dry)\b/i.test(food.description)) return "dry";
  if (food.category === "Vegetables and Vegetable Products" || food.category === "Poultry Products" || /\braw\b/i.test(food.description)) return "raw";
  return "as_packaged";
}

export interface QuantityChoice {
  label: string;
  quantity: Quantity;
}

/**
 * How a parsed amount becomes a recipe quantity for a chosen food. Counts
 * ("3 cloves", "2 large eggs") need a matching USDA portion. When the app
 * can't tell, `quantity` is null, `problem` says why, and `options` lists the
 * USDA sizes to choose from (you can always enter grams instead).
 */
export function quantityFor(
  p: Pick<ParsedIngredient, "amount" | "unit" | "sizeWord" | "packageSize" | "name"> & { prep?: string | null },
  food: Food | null,
): { quantity: Quantity | null; problem: string | null; options: QuantityChoice[] } {
  const none = (problem: string, options: QuantityChoice[] = []) => ({ quantity: null, problem, options });
  if (p.amount === null) return none("Enter an amount.");
  const amount = p.amount;
  if (p.packageSize) return { quantity: { kind: "mass", amount: amount * p.packageSize.amount, unit: p.packageSize.unit }, problem: null, options: [] };
  const u: ParsedUnit | null = p.unit;
  if (u?.kind === "mass") return { quantity: { kind: "mass", amount, unit: u.unit }, problem: null, options: [] };
  if (u?.kind === "volume") {
    if (food) {
      const r = gramsForAmount(food, 1, u.unit);
      if (!r.ok && r.reason === "ambiguous") {
        // The recipe's own words pick the form ("ground cumin", "whole peppercorns"); black pepper
        // measured by the spoon is ground unless it says otherwise.
        const hint = ["ground", "whole", "leaves", "leaf", "mashed", "whipped", "chopped", "sliced", "diced", "minced", "shredded", "grated", "crushed"].find((w) => new RegExp(`\\b${w}\\b`, "i").test(`${p.name} ${p.prep ?? ""}`) && r.options.some((o) => new RegExp(`\\b${w}`, "i").test(o.label)));
        const words = `${p.name} ${p.prep ?? ""}`;
        const want = hint ?? (/\bdiced\b/i.test(words) ? "chopped" : /\bdried\b/i.test(words) ? "leaves" : undefined);
        const pick =
          (want ? r.options.filter((o) => new RegExp(`\\b${want}`, "i").test(o.label)) : []).at(0) ??
          // Cream by the cup is liquid unless the recipe says whipped.
          (!/\bwhipped\b/i.test(p.name) ? r.options.find((o) => /\bfluid\b/i.test(o.label)) : undefined) ??
          (/\bpepper, black\b/i.test(food.description) ? r.options.find((o) => /\bground\b/i.test(o.label)) : undefined);
        if (pick) return { quantity: { kind: "volume", amount, unit: u.unit, portionLabel: pick.label }, problem: null, options: [] };
        return none(
          `USDA lists more than one weight per ${u.unit} for this food: choose one, or enter grams.`,
          r.options.map((o) => ({ label: `${o.amount} ${o.label} (${Math.round((o.grams / o.amount) * 10) / 10} g)`, quantity: { kind: "volume", amount, unit: u.unit, portionLabel: o.label } })),
        );
      }
      if (!r.ok) return none(`USDA has no ${u.unit === "tbsp" ? "tablespoon" : u.unit === "tsp" ? "teaspoon" : u.unit} weight for this food: choose another USDA food or enter grams.`);
    }
    return { quantity: { kind: "volume", amount, unit: u.unit }, problem: null, options: [] };
  }
  if (!food) return none("Choose the USDA food first.");
  // Count: find a USDA portion matching the noun or size ("clove", "large", "medium").
  const portions = food.portions.filter((x) => x.grams > 0 && (x.unit === null || !["cup", "tbsp", "tsp", "ml", "l", "fl_oz", "g", "oz", "lb", "kg"].includes(x.unit)));
  const words = [u?.kind === "count" ? u.noun : null, p.sizeWord, ...searchTerms(p.name.split(/\s*\/\s*/)[0]!).slice(-1)].filter((w): w is string => Boolean(w));
  for (const w of words) {
    // Best label first: exactly the word, then starting with it, then containing it.
    const re = new RegExp(`\\b${w}s?\\b`, "i");
    const hit =
      portions.find((x) => x.label.toLowerCase() === w || x.label.toLowerCase() === `${w}s`) ??
      portions.find((x) => new RegExp(`^${w}s?\\b`, "i").test(x.label)) ??
      portions.find((x) => re.test(x.label) && !/^serving\b/i.test(x.label));
    if (hit) return { quantity: { kind: "count", amount, portionLabel: hit.label }, problem: null, options: [] };
  }
  const options = portions.map((x) => ({ label: `${x.label} (${Math.round((x.grams / x.amount) * 10) / 10} g each)`, quantity: { kind: "count" as const, amount, portionLabel: x.label } }));
  const what = u?.kind === "count" ? `one ${u.noun}` : `one ${p.sizeWord ? `${p.sizeWord} ` : ""}${searchTerms(p.name.split(/\s*\/\s*/)[0]!).at(-1) ?? "item"}`;
  return none(options.length ? `Which USDA size is ${what}? Choose one, or enter grams.` : `USDA has no weight for ${what} of this food: enter grams.`, options);
}

/** Which steps mention an ingredient (by its main words). */
export function stepsMentioning(name: string, steps: string[], group?: string | null): number[] {
  const words = searchTerms(name).filter((w) => w.length >= 4 && !/^\d/.test(w));
  const hits: number[] = [];
  steps.forEach((s, i) => {
    const t = s.toLowerCase();
    if (words.some((w) => new RegExp(`\\b${w.replace(/[-]/g, "\\-")}(?:s|es)?\\b`).test(t))) hits.push(i + 1);
  });
  if (hits.length) return hits;
  // "Season with 1 serving of taco spice mix", "blend yogurt, mayo…": the section's name or another name for the food.
  steps.forEach((s, i) => {
    if (stepMentionsLine(s, name, group)) hits.push(i + 1);
  });
  return hits;
}

/**
 * USDA's cooked-weight factor for dry rice and pasta (used for container
 * weights only); everything else starts as "weight unchanged".
 */
export function defaultCookFor(food: Food, state: MeasuredState): LineCook {
  if (state !== "dry" && state !== "raw") return { kind: "unchanged" };
  const d = food.description.toLowerCase();
  if (/^rice, white, long[- ]grain\b.*\braw\b/.test(d)) return { kind: "yield", yieldId: "hydrate-rice-white-long-grain", match: "exact" };
  if (/^rice, white\b.*\braw\b/.test(d)) return { kind: "yield", yieldId: "hydrate-rice-white-long-grain", match: "closest" };
  if (/^rice, brown, long[- ]grain\b.*\braw\b/.test(d)) return { kind: "yield", yieldId: "hydrate-rice-brown-long-grain", match: "exact" };
  if (/^pasta, dry, enriched\b/.test(d)) return { kind: "yield", yieldId: "hydrate-pasta-enriched", match: "exact" };
  return { kind: "unchanged" };
}

export interface ReviewedLine {
  name: string;
  /** null = left out of the recipe. */
  food: Food | null;
  quantity: Quantity;
  state: MeasuredState;
  role: IngredientRole;
  optional: boolean;
  group: string | null;
  usedInSteps: number[];
  /** Flags the user confirmed, kept as notes on the line. */
  confirmed: string[];
}

export function slugFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "ingredient";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Builds the recipe from reviewed lines. Lines without a food are left out. */
export function recipeFromImport(args: {
  id: string;
  title: string;
  servings: number;
  lines: ReviewedLine[];
  steps: string[];
  notes: string[];
  source: RecipeSource;
}): Recipe {
  const taken = new Set<string>();
  const lines: IngredientLine[] = args.lines
    .filter((l) => l.food !== null)
    .map((l) => {
      const line: IngredientLine = {
        id: slugFor(l.name, taken),
        name: l.name,
        food: { kind: "usda", fdcId: l.food!.fdcId },
        quantity: l.quantity,
        state: l.state,
        role: l.role,
        usedInSteps: l.usedInSteps,
        cook: defaultCookFor(l.food!, l.state),
      };
      if (l.group) line.group = l.group;
      if (l.optional) line.optional = true;
      if (l.confirmed.length) line.assumptions = l.confirmed;
      return line;
    });
  const recipe: Recipe = { id: args.id, name: args.title, portions: args.servings, lines, steps: args.steps.map((text) => ({ text })), source: args.source };
  if (args.notes.length) recipe.notes = args.notes;
  return recipe;
}
