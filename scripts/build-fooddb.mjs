// Builds the app's bundled food database (public/data/fooddb.json) from the
// pinned USDA FoodData Central releases in data-raw/ (see fetch-usda.mjs).
//
// Values are copied exactly as USDA publishes them, per 100 g of food.
// A missing nutrient is stored as null, never as 0.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = new URL("..", import.meta.url).pathname;
const rawDir = join(root, "data-raw");
const outFile = join(root, "public/data/fooddb.json");
const sources = JSON.parse(await readFile(join(root, "scripts/usda-sources.json"), "utf8"));

// Nutrients kept, in storage order. `numbers` are USDA nutrient numbers.
export const NUTRIENTS = [
  { key: "kcal", unit: "kcal", numbers: [] }, // filled by the energy rule below
  { key: "protein", unit: "g", numbers: ["203"] },
  { key: "fat", unit: "g", numbers: ["204"] },
  { key: "carbs", unit: "g", numbers: ["205"] }, // carbohydrate, by difference
  { key: "fiber", unit: "g", numbers: ["291"] },
  { key: "sugars", unit: "g", numbers: ["269", "269.3"] },
  { key: "sodium", unit: "mg", numbers: ["307"] },
  { key: "satFat", unit: "g", numbers: ["606"] },
  { key: "water", unit: "g", numbers: ["255"] },
];

// Energy of record, in priority order: USDA "Energy" (208), then Atwater
// specific factors (958), then Atwater general factors (957).
export const ENERGY_SOURCES = ["208", "958", "957"];

// Portion units the engine can convert exactly; anything else is a count
// portion ("1 large", "1 slice") kept with its label and gram weight.
const UNIT_ALIASES = new Map([
  ["cup", "cup"], ["cups", "cup"],
  ["tbsp", "tbsp"], ["tablespoon", "tbsp"], ["tablespoons", "tbsp"],
  ["tsp", "tsp"], ["teaspoon", "tsp"], ["teaspoons", "tsp"],
  ["fl oz", "fl_oz"], ["fluid ounce", "fl_oz"],
  ["oz", "oz"], ["ounce", "oz"], ["lb", "lb"], ["pound", "lb"],
  ["ml", "ml"], ["milliliter", "ml"], ["l", "l"], ["liter", "l"],
  ["g", "g"], ["gram", "g"], ["kg", "kg"],
]);

function parseUnit(text) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("fl oz") || t.startsWith("fluid ounce")) return "fl_oz";
  const first = t.split(/[ ,(]/)[0];
  return UNIT_ALIASES.get(first) ?? null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${value}`);
  return n;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, no embedded newlines in USDA files).
async function* readCsv(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = null;
  for await (const line of lines) {
    if (!line) continue;
    const cells = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let value = "";
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { value += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else value += line[i++];
        }
        cells.push(value);
        i++; // skip comma
      } else {
        const end = line.indexOf(",", i);
        const stop = end === -1 ? line.length : end;
        cells.push(line.slice(i, stop));
        i = stop + 1;
      }
    }
    if (!header) { header = cells; continue; }
    yield Object.fromEntries(header.map((h, k) => [h, cells[k] ?? ""]));
  }
}

const categories = [];
const categoryIndex = (name) => {
  let i = categories.indexOf(name);
  if (i === -1) { i = categories.length; categories.push(name); }
  return i;
};

function finishFood({ fdcId, dataset, description, category, byNumber, portions, factors }) {
  let energySource = -1;
  let kcal = null;
  for (let i = 0; i < ENERGY_SOURCES.length; i++) {
    const v = byNumber.get(ENERGY_SOURCES[i]);
    if (v !== undefined && v !== null) { energySource = i; kcal = v; break; }
  }
  const values = NUTRIENTS.map((n) => {
    if (n.key === "kcal") return kcal;
    for (const num of n.numbers) {
      const v = byNumber.get(num);
      if (v !== undefined && v !== null) return v;
    }
    return null;
  });
  return [fdcId, dataset, description, categoryIndex(category), energySource, values, portions, factors];
}

// ---- Foundation Foods (JSON) ----
const fnd = sources.datasets.foundation;
const fndPath = join(rawDir, "foundation", fnd.entry);
const fndJson = JSON.parse(await readFile(fndPath, "utf8"));
const foods = [];
for (const f of fndJson.FoundationFoods) {
  const byNumber = new Map();
  for (const fn of f.foodNutrients ?? []) {
    if (fn.amount === undefined || fn.amount === null) continue;
    byNumber.set(String(fn.nutrient.number), toNumber(fn.amount));
  }
  const portions = (f.foodPortions ?? [])
    .filter((p) => toNumber(p.gramWeight) > 0)
    .map((p) => {
      const unitName = p.measureUnit?.name ?? "";
      const unit = parseUnit(p.measureUnit?.abbreviation) ?? parseUnit(unitName);
      const label = unitName === "RACC"
        ? "serving (USDA reference amount)"
        : [unitName === "undetermined" ? "" : unitName, p.modifier ?? ""].filter(Boolean).join(", ");
      return [toNumber(p.amount) ?? 1, unit, label, toNumber(p.gramWeight)];
    });
  const cal = (f.nutrientConversionFactors ?? []).find((c) => c.type === ".CalorieConversionFactor");
  const factors = cal ? [toNumber(cal.proteinValue), toNumber(cal.fatValue), toNumber(cal.carbohydrateValue)] : null;
  foods.push(finishFood({
    fdcId: f.fdcId, dataset: 0, description: f.description,
    category: f.foodCategory?.description ?? "Uncategorized", byNumber, portions, factors,
  }));
}
const foundationCount = foods.length;

// ---- SR Legacy (CSV) ----
const sr = sources.datasets.srLegacy;
const srDir = join(rawDir, "srLegacy", sr.entry);
const srCategories = new Map();
for await (const r of readCsv(join(srDir, "food_category.csv"))) srCategories.set(r.id, r.description);
const nutrientNumberById = new Map();
for await (const r of readCsv(join(srDir, "nutrient.csv"))) nutrientNumberById.set(r.id, r.nutrient_nbr);
const keep = new Set([...ENERGY_SOURCES, ...NUTRIENTS.flatMap((n) => n.numbers)]);

const srFoods = new Map();
for await (const r of readCsv(join(srDir, "food.csv"))) {
  srFoods.set(r.fdc_id, {
    fdcId: Number(r.fdc_id), dataset: 1, description: r.description,
    category: srCategories.get(r.food_category_id) ?? "Uncategorized",
    byNumber: new Map(), portions: [], factors: null,
  });
}
for await (const r of readCsv(join(srDir, "food_nutrient.csv"))) {
  const num = nutrientNumberById.get(r.nutrient_id);
  if (!keep.has(num)) continue;
  const food = srFoods.get(r.fdc_id);
  if (food && r.amount !== "") food.byNumber.set(num, toNumber(r.amount));
}
for await (const r of readCsv(join(srDir, "food_portion.csv"))) {
  const food = srFoods.get(r.fdc_id);
  const grams = toNumber(r.gram_weight);
  if (!food || !(grams > 0)) continue;
  const label = [r.portion_description, r.modifier].filter(Boolean).join(", ");
  food.portions.push([toNumber(r.amount) ?? 1, parseUnit(r.modifier), label, grams]);
}
const factorFood = new Map();
for await (const r of readCsv(join(srDir, "food_nutrient_conversion_factor.csv"))) factorFood.set(r.id, r.fdc_id);
for await (const r of readCsv(join(srDir, "food_calorie_conversion_factor.csv"))) {
  const food = srFoods.get(factorFood.get(r.food_nutrient_conversion_factor_id));
  if (food) food.factors = [toNumber(r.protein_value), toNumber(r.fat_value), toNumber(r.carbohydrate_value)];
}
for (const food of srFoods.values()) foods.push(finishFood(food));

// ---- Checks ----
const ids = new Set();
for (const f of foods) {
  if (ids.has(f[0])) throw new Error(`Duplicate fdcId ${f[0]}`);
  ids.add(f[0]);
}
if (foundationCount < 400 || foods.length - foundationCount < 7700) {
  throw new Error(`Unexpected food counts: foundation ${foundationCount}, SR ${foods.length - foundationCount}`);
}

foods.sort((a, b) => a[0] - b[0]);
const db = {
  schema: 1,
  citation: sources.citation,
  license: sources.license,
  releases: { foundation: fnd.release, srLegacy: sr.release },
  files: {
    foundation: { file: fnd.file, sha256: fnd.sha256 },
    srLegacy: { file: sr.file, sha256: sr.sha256 },
  },
  datasets: ["foundation", "sr_legacy"],
  nutrients: NUTRIENTS.map(({ key, unit }) => ({ key, unit })),
  energySources: ENERGY_SOURCES,
  foodFields: ["fdcId", "dataset", "description", "category", "energySource", "values", "portions", "calorieFactors"],
  portionFields: ["amount", "unit", "label", "grams"],
  categories,
  foods,
};
const body = JSON.stringify(db);
const version = `F${fnd.release}-S${sr.release}-${sha256(body).slice(0, 10)}`;
const out = JSON.stringify({ version, ...db });
await mkdir(join(root, "public/data"), { recursive: true });
await writeFile(outFile, out);
const noEnergy = foods.filter((f) => f[4] === -1).length;
console.log(`fooddb ${version}: ${foods.length} foods (${foundationCount} Foundation), ${noEnergy} without energy, ${(out.length / 1024 / 1024).toFixed(2)} MB`);
