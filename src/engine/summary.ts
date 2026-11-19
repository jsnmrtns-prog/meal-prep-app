/**
 * A short, plain summary of a recipe, worked out with simple word rules (no AI):
 * what's in it, how it's cooked, its style, and the book's own description when
 * there is one. "Close enough": a part the rules can't tell is left out.
 */

export interface SummaryInput {
  name: string;
  ingredients: { name: string; group?: string | null | undefined; optional?: boolean | undefined }[];
  steps: string[];
  /** The recipe's original text, for the description a book prints above the ingredients. */
  sourceText?: string | undefined;
}

export interface RecipeSummary {
  /** "Chicken thighs with white rice and mixed vegetables, in a teriyaki sauce." */
  dish: string | null;
  /** "Stove", "Oven", "Slow cooker"… */
  method: string | null;
  /** "Asian-style", "Mexican-style"… */
  style: string | null;
  /** Minutes of cooking named in the steps (not marinating or chilling). */
  minutes: number | null;
  /** The first sentence or two of the recipe's own description. */
  intro: string | null;
}

import type { Recipe } from "./recipe.ts";
import { parseRecipeText } from "./importer/parse.ts";

type Pick = [RegExp, string];

// Order matters within each list: more specific first.
const MAIN_PROTEIN: Pick[] = [
  [/chicken thigh/, "chicken thighs"],
  [/chicken breast/, "chicken breast"],
  [/chicken (?:tender|strip)/, "chicken tenders"],
  [/chicken sausage/, "chicken sausage"],
  [/ground chicken|chicken mince|minced chicken/, "ground chicken"],
  [/\bchicken\b/, "chicken"],
  [/turkey sausage/, "turkey sausage"],
  [/ground turkey|turkey mince|minced turkey/, "ground turkey"],
  [/\bturkey\b/, "turkey"],
  [/ground beef|beef mince|minced beef|ground\/mince beef|lean beef|\bmince\b/, "ground beef"],
  [/steak|sirloin|flank|ribeye|skirt/, "steak"],
  [/\bbeef\b|chuck roast|brisket/, "beef"],
  [/pork tenderloin/, "pork tenderloin"],
  [/pork chop/, "pork chops"],
  [/ground pork|pork mince/, "ground pork"],
  [/\bham\b/, "ham"],
  [/\bbacon\b/, "bacon"],
  [/\bsausage|chorizo|kielbasa/, "sausage"],
  [/\bpork\b/, "pork"],
  [/\blamb\b/, "lamb"],
  [/salmon/, "salmon"],
  [/\btuna\b/, "tuna"],
  [/shrimp|prawns?\b/, "shrimp"],
  [/\bcod\b|tilapia|white fish|halibut|haddock|pollock|basa/, "white fish"],
  [/\bfish\b(?! sauce)/, "fish"],
  [/\btofu\b/, "tofu"],
  [/tempeh/, "tempeh"],
  [/seitan/, "seitan"],
];

const OTHER_PROTEIN: Pick[] = [
  [/egg whites?/, "egg whites"],
  [/\beggs?\b/, "eggs"],
  [/protein powder|whey/, "protein powder"],
  [/greek yog(?:h)?urt/, "Greek yogurt"],
  [/cottage cheese/, "cottage cheese"],
  [/lentils?/, "lentils"],
  [/chickpeas?|garbanzo/, "chickpeas"],
  [/black beans?/, "black beans"],
  [/kidney beans?|pinto beans?|cannellini|white beans?/, "beans"],
];

const CARB: Pick[] = [
  [/cauliflower rice|riced cauliflower/, "cauliflower rice"],
  [/brown rice/, "brown rice"],
  [/basmati/, "basmati rice"],
  [/jasmine/, "jasmine rice"],
  [/white rice/, "white rice"],
  [/\brice\b(?! vinegar| wine| paper| flour)/, "rice"],
  [/sweet potato/, "sweet potatoes"],
  [/potato|\bspuds?\b/, "potatoes"],
  [/macaroni|elbow/, "macaroni"],
  [/spaghetti|linguine|fettuccine/, "spaghetti"],
  [/penne|rigatoni|fusilli|rotini|farfalle|orzo|\bpasta\b|gnocchi/, "pasta"],
  [/noodle|ramen|udon|soba/, "noodles"],
  [/quinoa/, "quinoa"],
  [/couscous/, "couscous"],
  [/\boats?\b|oatmeal/, "oats"],
  [/tortilla|\bwraps?\b/, "tortillas"],
  [/\bbuns?\b|brioche/, "buns"],
  [/bagel/, "bagels"],
  [/pita|naan|flatbread/, "flatbread"],
  [/\bbread\b|sourdough|toast/, "bread"],
];

const VEG: Pick[] = [
  [/mixed (?:frozen )?veg|stir[- ]fry veg|frozen veg/, "mixed vegetables"],
  [/broccoli/, "broccoli"],
  [/bell peppers?|red peppers?|green peppers?|yellow peppers?|capsicum/, "peppers"],
  [/spinach/, "spinach"],
  [/zucchini|courgette/, "zucchini"],
  [/green beans/, "green beans"],
  [/asparagus/, "asparagus"],
  [/mushroom/, "mushrooms"],
  [/carrot/, "carrots"],
  [/cauliflower(?! rice)/, "cauliflower"],
  [/kale/, "kale"],
  [/cabbage|slaw/, "cabbage"],
  [/\bcorn\b|sweetcorn/, "corn"],
  [/\bpeas\b|edamame/, "peas"],
  [/tomato(?:es)?(?! paste| sauce| puree)/, "tomatoes"],
  [/cucumber/, "cucumber"],
  [/lettuce|romaine|salad greens|mixed greens|arugula|rocket/, "greens"],
  [/avocado/, "avocado"],
  [/brussels/, "Brussels sprouts"],
  [/\bonions?\b|shallot|scallion|spring onion|green onion/, "onion"],
];

const FRUIT: Pick[] = [
  [/berr(?:y|ies)/, "berries"],
  [/banana/, "banana"],
  [/mango/, "mango"],
  [/pineapple/, "pineapple"],
  [/\bapples?\b/, "apple"],
  [/kiwi/, "kiwi"],
  [/peach/, "peaches"],
  [/orange|clementine/, "orange"],
  [/watermelon|melon/, "melon"],
  [/pomegranate|grenadine/, "pomegranate"],
  [/cherr(?:y|ies)/, "cherries"],
];

/** Named sauces and flavors, in the order they're worth mentioning. */
const FLAVOR: Pick[] = [
  [/teriyaki/, "teriyaki"],
  [/orange chicken|orange sauce/, "orange"],
  [/sweet (?:and|&) sour/, "sweet and sour"],
  [/gochujang/, "gochujang"],
  [/peanut butter|peanut sauce|satay/, "peanut"],
  [/hoisin/, "hoisin"],
  [/sriracha/, "sriracha"],
  [/buffalo|hot sauce|frank'?s/, "buffalo"],
  [/\bbbq\b|barbecue/, "BBQ"],
  [/chipotle/, "chipotle"],
  [/taco seasoning|taco spice|fajita seasoning|fajita/, "taco"],
  [/enchilada/, "enchilada"],
  [/salsa/, "salsa"],
  [/tikka|garam masala|curry/, "curry"],
  [/pesto/, "pesto"],
  [/marinara|tomato sauce|passata|crushed tomatoes|diced tomatoes|tomato paste|pasta sauce/, "tomato"],
  [/alfredo|cream cheese|heavy cream|single cream|double cream/, "creamy"],
  [/cheddar|mozzarella|parmesan|(?<!cottage |cream )cheese/, "cheesy"],
  [/honey/, "honey"],
  [/lemon/, "lemon"],
  [/lime/, "lime"],
  [/soy sauce|tamari|coconut aminos/, "soy"],
  [/ginger/, "ginger"],
  [/sesame/, "sesame"],
  [/garlic/, "garlic"],
];

const STYLE: { label: string; words: RegExp[]; strong?: RegExp }[] = [
  { label: "Asian-style", words: [/soy sauce|tamari|coconut aminos/, /sesame/, /ginger/, /rice vinegar|mirin/, /sriracha|gochujang|hoisin|oyster sauce|fish sauce/, /bok choy|edamame|water chestnut/, /\bwok\b|stir[- ]fr/], strong: /teriyaki|gochujang|hoisin|korean|thai|chinese|japanese|kung pao|general tso|orange chicken|lo mein|fried rice|bulgogi|katsu|satay|pad thai/ },
  { label: "Mexican-style", words: [/cumin/, /chipotle|jalape/, /tortilla/, /salsa/, /black beans|pinto/, /enchilada sauce|taco seasoning/], strong: /taco|fajita|enchilada|burrito|quesadilla|mexican|carnitas|tex-mex|nacho|\bchili\b(?! powder| flakes| sauce| oil)|\bchilli\b(?! powder| flakes| sauce| oil| crisp)/ },
  { label: "Italian-style", words: [/marinara|passata|crushed tomatoes|pasta sauce/, /parmesan|mozzarella|ricotta/, /basil/, /oregano|italian seasoning/, /pasta|spaghetti|penne|rigatoni|lasagn/], strong: /pesto|lasagn|parmigiana|italian|bolognese|carbonara|alfredo|marsala|piccata/ },
  { label: "Mediterranean-style", words: [/feta/, /tzatziki/, /olives?/, /hummus|chickpea/, /pita/], strong: /greek(?! yog)|gyro|shawarma|mediterranean|souvlaki|falafel/ },
  { label: "Indian-style", words: [/garam masala/, /turmeric/, /curry/, /coconut milk/], strong: /tikka|masala|(?<!honey garlic )butter chicken|korma|tandoori|biryani|dal\b|indian/ },
  { label: "BBQ-style", words: [/\bbbq\b|barbecue/, /smoked paprika/, /brown sugar/], strong: /\bbbq\b|barbecue|pulled pork/ },
];

const METHODS: Pick[] = [
  [/slow cooker|crock ?pot|slow[- ]cook/, "Slow cooker"],
  [/instant pot|pressure cook/, "Instant Pot"],
  [/air[- ]?fr(?:y|ier)/, "Air fryer"],
  [/\bgrill(?:ed|ing)?\b|barbecue the|on the bbq/, "Grill"],
  [/sheet pan|baking sheet|baking tray|oven|\bbake\b|\broast\b|preheat/, "Oven"],
  [/\bwok\b|stir[- ]fr/, "Stir-fried on the stove"],
  [/skillet|frying pan|\bpan\b|saucepan|\bpot\b|sauté|saute|simmer|\bboil|\bfry\b|stovetop|medium heat|high heat|low heat/, "Stove"],
  [/microwave/, "Microwave"],
];

const NO_COOK_GROUP = /\b(?:sauce|glaze|dressing|salsa|marinade|slaw|dip|drizzle|topping|seasoning|spice mix|rub)\b/i;

function pick(list: Pick[], texts: string[], max: number, taken = new Set<string>()): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const lower = t.toLowerCase();
    for (const [re, label] of list) {
      if (re.test(lower)) {
        if (!taken.has(label) && !out.includes(label)) out.push(label);
        break;
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sauce named by a section heading, e.g. "Green Sauce" or "Sticky Glaze". */
function namedSauce(groups: string[]): string | null {
  for (const g of groups) {
    const clean = g.replace(/[:(].*$/, "").replace(/\s+/g, " ").trim();
    if (/\b(?:sauce|glaze|dressing|salsa|gravy|pesto)\b/i.test(clean) && clean.split(" ").length <= 5 && clean.split(" ").length >= 2 && !/^(?:the|make the)\b|\b(?:for|cooking|final|serving|optional|to serve)\b/i.test(clean)) return clean.toLowerCase();
  }
  return null;
}

/** Minutes of cooking named in the steps, leaving out marinating, chilling and resting. */
function cookingMinutes(steps: string[]): number | null {
  let total = 0;
  for (const step of steps) {
    for (const sentence of step.split(/(?<=[.!?])\s+/)) {
      if (/marinat|chill|refrigerat|fridge|overnight|\brest\b|cool|soak|freez|set aside for/i.test(sentence)) continue;
      const re = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|minutes?|mins?)\b/gi;
      for (const m of sentence.matchAll(re)) {
        const n = Number(m[2] ?? m[1]);
        total += /^h/i.test(m[3]!) ? n * 60 : n;
      }
    }
  }
  return total >= 15 ? Math.round(total / 5) * 5 : null;
}

/** "Total time: 45 minutes" or "Prep 10 min · Cook 25 min", when the recipe prints it. */
function printedMinutes(text: string): number | null {
  const total = text.match(/total(?: time\s*[:\-]?|\s*:)\s*(\d+)\s*(h|hours?|hrs?|m|minutes?|mins?)\b(?:\s*(\d+)\s*(?:m|minutes?|mins?)\b)?/i);
  if (total) return /^h/i.test(total[2]!) ? Number(total[1]) * 60 + Number(total[3] ?? 0) : Number(total[1]);
  const prep = text.match(/prep(?:aration)?(?: time\s*[:\-]?|\s*:)\s*(\d+)\s*(?:m|minutes?|mins?)\b/i);
  const cook = text.match(/cook(?:ing)?(?: time\s*[:\-]?|\s*:)\s*(\d+)\s*(?:m|minutes?|mins?)\b/i);
  return prep && cook ? Number(prep[1]) + Number(cook[1]) : null;
}

const NOT_INTRO = /^(?:recipe\s*#?\s*\d+|macros?\b|nutrition|per serving|calories|protein|carbs|fat|tap |click |serves|servings|makes|yield|prep|cook|total|ingredients?|\d)/i;

/**
 * The description a recipe prints between its name and its ingredients:
 * the first sentence or two, at most about 220 characters.
 */
export function introText(text: string, name: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const head: string[] = [];
  const nameWords = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  for (const l of lines) {
    if (/^(?:[•–\-*»z]\s*)?(?:ingredients?|what you(?:'|’)?ll need|instructions?|directions?|method|how to make)\b/i.test(l)) break;
    if (!l) { head.push(""); continue; }
    // The first amount ("2 cups rice", "– 800g chicken") means the ingredients have started.
    if (/^(?:[•–\-*»z]\s*)?(?:\d|[½¼¾⅓⅔⅛])/.test(l) && /[a-z]{3,}/i.test(l) && !/\b(?:calories|kcal|protein|carbs|fat|servings?|makes|serves)\b/i.test(l)) break;
    if (NOT_INTRO.test(l) || /\b(?:calories|kcal)\b/i.test(l)) { head.push(""); continue; }
    const words = l.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    // The recipe's name (sometimes split over two lines) isn't a description.
    if (words.length <= 6 && words.every((w) => nameWords.includes(w))) { head.push(""); continue; }
    head.push(l);
  }
  // Join wrapped lines into paragraphs and keep the first one that reads like sentences.
  const paragraphs = head.join("\n").split(/\n{1,}(?=\n)|\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  for (const p of paragraphs) {
    const words = p.split(/\s+/);
    if (words.length < 6 || !/[a-z]/.test(p) || !/[.!?]["”’)]?$/.test(p)) continue;
    const sentences = p.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [p];
    let out = "";
    for (const s of sentences) {
      if (out && (out + s).length > 220) break;
      out += s;
    }
    out = out.trim();
    if (out.length > 260) out = `${out.slice(0, 220).replace(/\s+\S*$/, "")}…`;
    // Books often shout: "THE BEST recipe" reads better as written, but all-caps sentences don't.
    if (out === out.toUpperCase()) out = cap(out.toLowerCase());
    return out;
  }
  return null;
}

export function summarizeRecipe(input: SummaryInput): RecipeSummary {
  const used = input.ingredients.filter((i) => !i.optional);
  const names = used.map((i) => i.name);
  const groups = [...new Set(input.ingredients.map((i) => i.group).filter((g): g is string => !!g))];
  const all = `${input.name}\n${names.join("\n")}\n${groups.join("\n")}`.toLowerCase();
  const stepText = input.steps.join("\n").toLowerCase();

  // What's in it: the main protein(s), the carb, a couple of vegetables.
  // A sauce or seasoning section doesn't supply the main ingredients.
  const mainNames = used.filter((i) => !(i.group && NO_COOK_GROUP.test(i.group))).map((i) => i.name);
  const proteinNames = mainNames.filter((n) => !/\b(?:broth|stock|bouillon|seasoning|powder|flavou?r|gravy)\b/i.test(n) || /protein powder/i.test(n));
  let protein = pick(MAIN_PROTEIN, proteinNames, 2);
  // A protein filed under a "sauce" heading, or only named in the title ("Sesame Chicken").
  if (protein.length === 0) protein = pick(MAIN_PROTEIN, names.filter((n) => !/\b(?:broth|stock|bouillon|seasoning|powder|gravy)\b/i.test(n)), 2);
  if (protein.length === 0) protein = pick(MAIN_PROTEIN, [input.name], 1);
  if (protein.length === 0) protein = pick(OTHER_PROTEIN, proteinNames, 2);
  // "Chicken thighs and chicken" says the same thing twice.
  protein = protein.filter((p) => !protein.some((q) => q !== p && q.startsWith(`${p} `)));
  const carb = pick(CARB, mainNames, 1);
  let veg = pick(VEG, mainNames, 4);
  if (veg.includes("mixed vegetables")) veg = ["mixed vegetables"];
  // Onion is in nearly everything; mention it only when it's the only vegetable.
  if (veg.length > 1) veg = veg.filter((v) => v !== "onion");
  veg = veg.slice(0, 2);

  const sauce = namedSauce(groups);
  const named = [...protein, ...carb, ...veg].join(" ");
  const flavors = pick(FLAVOR, [input.name, ...names, ...groups], 4).filter((f) => !named.includes(f.toLowerCase()));

  const parts: string[] = [];
  const fruit = carb.length ? [] : pick(FRUIT, mainNames, 2);
  const base = protein.length ? and(protein) : carb.length ? carb[0]! : fruit.length ? and(fruit) : veg.length ? and(veg) : "";
  const withs = protein.length ? [...carb, ...fruit, ...veg].slice(0, 3) : carb.length || fruit.length ? veg : [];
  let dish = base ? cap(base) : "";
  if (dish && withs.length) dish += ` with ${and(withs)}`;
  if (dish) {
    if (sauce) dish += `, with ${/^[aeiou]/i.test(sauce) ? "an" : "a"} ${sauce}`;
    else if (flavors.length) dish += `, ${and(flavors.slice(0, 2))} flavors`;
    parts.push(`${dish}.`);
  }

  // How it's cooked.
  let method: string | null = null;
  for (const [re, label] of METHODS) {
    if (re.test(stepText)) { method = label; break; }
  }
  if (!method && input.steps.length > 0 && !/\bheat|cook|bake|fry|boil|roast|grill|simmer|toast|warm\b/.test(stepText)) method = "No cooking";

  // Style: a dish name or a couple of telling ingredients.
  let style: string | null = null;
  let best = 0;
  for (const s of STYLE) {
    const score = (s.strong?.test(all) ? 3 : 0) + s.words.filter((w) => w.test(all)).length;
    if (score >= 3 && score > best) { best = score; style = s.label; }
  }

  const source = input.sourceText ?? "";
  const minutes = printedMinutes(source) ?? cookingMinutes(input.steps);
  const intro = source ? introText(source, input.name) : null;
  return { dish: parts.length ? parts[0]! : null, method, style, minutes, intro };
}

/** The "how" line: "Stove · Asian-style · about 35 min of cooking". */
export function summaryDetails(s: RecipeSummary): string {
  const bits: string[] = [];
  if (s.method) bits.push(s.method);
  if (s.style) bits.push(s.style);
  if (s.minutes) bits.push(s.minutes >= 90 ? `about ${Math.round(s.minutes / 30) / 2} hours of cooking` : `about ${s.minutes} min of cooking`);
  return bits.join(" · ");
}

/** The summary of a saved recipe. */
export function summarizeSaved(recipe: Recipe): RecipeSummary {
  const nameOf = new Map(recipe.lines.map((l) => [l.id, l.name]));
  const steps = recipe.steps.map((s) => s.text.replace(/\{\{name:([^}]+)\}\}/g, (_, id: string) => nameOf.get(id) ?? "").replace(/\{\{qty:[^}]+\}\}/g, ""));
  return summarizeRecipe({ name: recipe.name, ingredients: recipe.lines, steps, sourceText: recipe.source?.text });
}

/** The summary of recipe text that hasn't been imported yet, e.g. one recipe in a cookbook. */
export function summarizeText(name: string, text: string): RecipeSummary {
  const r = parseRecipeText(text);
  return summarizeRecipe({ name, ingredients: r.ingredients, steps: r.steps, sourceText: text });
}
