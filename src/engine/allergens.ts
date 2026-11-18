/**
 * Allergen screening for USDA generic foods.
 *
 * USDA FoodData Central has no allergen fields, so these tags come from the
 * app's own rules over each food's USDA category and description. They are a
 * screen, not a guarantee:
 *  - Rules lean toward over-tagging: a false alarm is better than a miss.
 *  - Multi-ingredient foods (restaurant items, baked goods, sauces, sausages...)
 *    are marked `needsLabelCheck`, because their ingredients vary by brand.
 *  - Cross-contact ("may contain") can never be verified from USDA data.
 */
import type { Food } from "./fooddb.ts";

/** The nine major food allergens defined by U.S. law (FALCPA as amended by the FASTER Act). */
export const MAJOR_ALLERGENS = [
  "milk", "egg", "fish", "crustacean_shellfish", "tree_nuts", "peanuts", "wheat", "soy", "sesame",
] as const;
export type Allergen = (typeof MAJOR_ALLERGENS)[number];

export interface AllergenScreen {
  allergens: Allergen[];
  /** True when the food's ingredients vary or can't be judged from USDA data: check the product label. */
  needsLabelCheck: boolean;
  /** Short reasons, for display and testing ("description mentions 'cheese'"). */
  reasons: string[];
}

const MULTI_INGREDIENT_CATEGORIES = new Set([
  "Restaurant Foods",
  "Fast Foods",
  "Meals, Entrees, and Side Dishes",
  "Baked Products",
  "Sweets",
  "Snacks",
  "Soups, Sauces, and Gravies",
  "Sausages and Luncheon Meats",
  "Baby Foods",
  "Breakfast Cereals",
  "American Indian/Alaska Native Foods",
  "Beverages",
]);

interface Rule {
  allergen: Allergen;
  /** Whole words or phrases to look for in the lowercased description. */
  terms: string[];
  /** Phrases that cancel a match of a term they contain (e.g. "peanut butter" is not milk). */
  unless?: string[];
  /** Words that cancel a specific term anywhere in the description (e.g. "butternut" with "squash"). */
  contextBlocks?: Record<string, string[]>;
}

const RULES: Rule[] = [
  {
    allergen: "milk",
    terms: [
      "milk", "cheese", "butter", "buttermilk", "cream", "yogurt", "yoghurt", "whey", "casein", "caseinate",
      "ghee", "kefir", "half and half", "ricotta", "cottage", "mozzarella", "cheddar", "parmesan", "lactose",
      "buttered",
    ],
    unless: [
      "peanut butter", "almond butter", "cashew butter", "nut butter", "seed butter", "sesame butter",
      "sunflower seed butter", "soy butter", "apple butter",
      "cocoa butter", "butterbur", "butternut", "butterhead", "cream of tartar", "coconut milk",
      "coconut cream", "almond milk", "soy milk", "soymilk", "rice milk", "oat milk", "milkfish",
      "butter beans", "cream of wheat", "cream of rice",
    ],
  },
  { allergen: "egg", terms: ["egg", "eggs", "mayonnaise", "meringue", "eggnog", "albumen"], unless: ["eggplant"] },
  {
    allergen: "fish",
    terms: [
      "fish", "anchovy", "anchovies", "bass", "catfish", "cod", "flounder", "grouper", "haddock", "hake",
      "halibut", "herring", "mackerel", "mahimahi", "perch", "pike", "pollock", "salmon", "sardine",
      "sardines", "snapper", "sole", "swordfish", "tilapia", "trout", "tuna", "whitefish", "pompano",
      "roe", "caviar", "surimi", "worcestershire",
    ],
    unless: ["shellfish"],
    contextBlocks: { sole: ["shoe"] },
  },
  {
    allergen: "crustacean_shellfish",
    terms: ["crab", "crabs", "lobster", "shrimp", "prawn", "prawns", "crayfish", "crawfish", "krill", "langoustine"],
  },
  {
    allergen: "tree_nuts",
    terms: [
      "almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pecan", "pecans", "pistachio",
      "pistachios", "hazelnut", "hazelnuts", "filbert", "filberts", "macadamia", "brazilnut", "brazilnuts",
      "pine nut", "pine nuts", "pinyon", "chestnut", "chestnuts", "coconut", "praline", "marzipan",
      "nutella", "beechnut", "butternut", "hickorynut", "nuts",
    ],
    unless: ["water chestnut", "water chestnuts", "doughnut", "doughnuts", "nutmeg", "peanut", "peanuts"],
    contextBlocks: { butternut: ["squash"] },
  },
  { allergen: "peanuts", terms: ["peanut", "peanuts", "groundnut", "groundnuts", "mixed nuts"] },
  {
    allergen: "wheat",
    terms: [
      "wheat", "flour", "bread", "breaded", "bun", "buns", "roll", "rolls", "pasta", "spaghetti", "macaroni",
      "noodle", "noodles", "couscous", "bulgur", "semolina", "durum", "farina", "seitan", "cracker",
      "crackers", "crouton", "croutons", "biscuit", "biscuits", "cake", "cookie", "cookies", "pie", "pizza",
      "pretzel", "pretzels", "tortilla", "tortillas", "spelt", "farro", "einkorn", "kamut", "triticale",
      "batter", "dumpling", "dumplings", "gravy", "soy sauce", "bagel", "muffin", "pancake", "waffle",
    ],
    unless: [
      "rice flour", "corn flour", "almond flour", "coconut flour", "potato flour", "soy flour", "rice noodles",
      "corn tortilla", "corn tortillas", "buckwheat", "rice cake", "rice cakes",
      "rice bread", "tamari",
    ],
  },
  { allergen: "soy", terms: ["soy", "soya", "soybean", "soybeans", "tofu", "tempeh", "edamame", "miso", "natto", "tamari", "soymilk"] },
  { allergen: "sesame", terms: ["sesame", "tahini", "benne", "gingelly", "hummus"] },
];

const CATEGORY_RULES: { category: string; allergen: Allergen; unless?: string[] }[] = [
  { category: "Finfish and Shellfish Products", allergen: "fish", unless: [
    "crab", "lobster", "shrimp", "prawn", "crayfish", "crawfish", "clam", "oyster", "scallop", "mussel",
    "squid", "octopus", "abalone", "snail", "whelk", "conch", "cuttlefish",
  ] },
  { category: "Cereal Grains and Pasta", allergen: "wheat", unless: [
    "rice", "corn", "oat", "oats", "quinoa", "millet", "sorghum", "amaranth", "buckwheat", "teff",
    "wild rice", "hominy", "barley", "rye", "arrowroot", "tapioca", "cornmeal", "cornstarch", "masa",
  ] },
];

function containsPhrase(text: string, phrase: string): boolean {
  // Whole-word or whole-phrase match on a normalised, space-padded string.
  return text.includes(` ${phrase} `);
}

function normalise(description: string): string {
  return ` ${description.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim()} `;
}

export function screenAllergens(food: Pick<Food, "description" | "category">): AllergenScreen {
  const text = normalise(food.description);
  const found = new Map<Allergen, string>();

  for (const rule of RULES) {
    const blockers = (rule.unless ?? []).filter((u) => containsPhrase(text, u));
    for (const term of rule.terms) {
      if (!containsPhrase(text, term)) continue;
      // A blocker only cancels the match if it contains this term (e.g. "peanut butter" cancels "butter").
      if (blockers.some((b) => ` ${b} `.includes(` ${term} `))) continue;
      if ((rule.contextBlocks?.[term] ?? []).some((w) => containsPhrase(text, w))) continue;
      if (!found.has(rule.allergen)) found.set(rule.allergen, `description mentions "${term}"`);
      break;
    }
  }

  for (const rule of CATEGORY_RULES) {
    if (food.category !== rule.category || found.has(rule.allergen)) continue;
    if ((rule.unless ?? []).some((u) => containsPhrase(text, u))) continue;
    found.set(rule.allergen, `USDA category "${rule.category}"`);
  }

  const needsLabelCheck = MULTI_INGREDIENT_CATEGORIES.has(food.category) || /\bbrand\b|\bprepared\b/.test(text);
  const allergens = MAJOR_ALLERGENS.filter((a) => found.has(a));
  return {
    allergens,
    needsLabelCheck,
    reasons: allergens.map((a) => `${a}: ${found.get(a)!}`),
  };
}
