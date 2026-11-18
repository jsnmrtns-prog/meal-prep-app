"""Independent reference totals for the golden recipes (M2 gate).

Shares no code with the TypeScript engine. Reads the raw USDA files and the
recipe fixtures, applies the hand-written `expectedAfterPreferences`, converts
every quantity to grams with its own unit table and USDA portion lookup, and
computes per-ingredient, batch and per-serving nutrition.

Run:  python3 -I scripts/golden_recipes.py   (after `npm run usda:fetch`)
Writes tests/fixtures/golden-recipes-expected.json.
"""
import csv
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
FOUNDATION_JSON = RAW / "foundation" / "FoodData_Central_foundation_food_json_2026-10-29.json"
SR_DIR = RAW / "srLegacy" / "FoodData_Central_sr_legacy_food_csv_2018-04"
FIXTURES = ROOT / "tests" / "fixtures" / "recipes"
OUT = ROOT / "tests" / "fixtures" / "golden-recipes-expected.json"

GRAMS = {"g": 1.0, "kg": 1000.0, "oz": 28.349523125, "lb": 453.59237}
KEYS = {"kcal": None, "protein": "203", "fat": "204", "carbs": "205", "fiber": "291", "sugars": ("269", "269.3"), "sodium": "307", "satFat": "606"}
ENERGY = ("208", "958", "957")


def nutrient_row(nums):
    row = {}
    for key, num in KEYS.items():
        if key == "kcal":
            row[key] = next((nums[n] for n in ENERGY if n in nums), None)
        elif isinstance(num, tuple):
            row[key] = next((nums[n] for n in num if n in nums), None)
        else:
            row[key] = nums.get(num)
    return row


def load():
    foods, portions = {}, {}
    for f in json.loads(FOUNDATION_JSON.read_text())["FoundationFoods"]:
        nums = {str(n["nutrient"]["number"]): float(n["amount"]) for n in f.get("foodNutrients", []) if n.get("amount") is not None}
        foods[f["fdcId"]] = (f["description"], nutrient_row(nums))
        portions[f["fdcId"]] = []
    with open(SR_DIR / "nutrient.csv", newline="") as fh:
        number_by_id = {r["id"]: r["nutrient_nbr"] for r in csv.DictReader(fh)}
    sr_desc, sr_nums = {}, {}
    with open(SR_DIR / "food.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            sr_desc[int(r["fdc_id"])] = r["description"]
            sr_nums[int(r["fdc_id"])] = {}
    with open(SR_DIR / "food_nutrient.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["amount"] != "":
                sr_nums[int(r["fdc_id"])][number_by_id[r["nutrient_id"]]] = float(r["amount"])
    for i, d in sr_desc.items():
        foods[i] = (d, nutrient_row(sr_nums[i]))
        portions[i] = []
    with open(SR_DIR / "food_portion.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            label = ", ".join(x for x in (r["portion_description"], r["modifier"]) if x)
            portions[int(r["fdc_id"])].append((float(r["amount"] or 1), label, float(r["gram_weight"])))
    return foods, portions


def grams_for(line, portions):
    q = line["quantity"]
    if q["kind"] == "mass":
        return q["amount"] * GRAMS[q["unit"]]
    fid = line["food"]["fdcId"]
    if q["kind"] == "count":
        label = q["portionLabel"]
    else:  # volume: the USDA portion stated in exactly this unit
        label = {"tsp": "tsp", "tbsp": "tbsp"}[q["unit"]]
    matches = [p for p in portions[fid] if p[1] == label]
    if len(matches) != 1:
        raise SystemExit(f"{line['id']}: expected one USDA portion '{label}' for {fid}, found {len(matches)}")
    amount, _, grams = matches[0]
    return q["amount"] * grams / amount


def main():
    foods, portions = load()
    result = {"source": "scripts/golden_recipes.py (independent of the TypeScript engine)", "recipes": {}}
    for path in sorted(FIXTURES.glob("*.json")):
        fx = json.loads(path.read_text())
        recipe, after = fx["recipe"], fx["expectedAfterPreferences"]
        lines_out = []
        batch = {k: 0.0 for k in KEYS}
        complete = {k: True for k in KEYS}
        for line in recipe["lines"]:
            if line["id"] in after["removed"]:
                continue
            line = json.loads(json.dumps(line))
            if line["id"] in after["amounts"]:
                line["quantity"]["amount"] = after["amounts"][line["id"]]
            food = line["food"]
            if food["kind"] == "builtin":
                desc, per100 = food["id"], {k: 0.0 for k in KEYS}
                grams = line["quantity"]["amount"] * GRAMS[line["quantity"]["unit"]]
            else:
                desc, per100 = foods[food["fdcId"]]
                grams = grams_for(line, portions)
            contrib = {k: (None if per100[k] is None else grams * per100[k] / 100) for k in KEYS}
            for k in KEYS:
                if contrib[k] is None:
                    complete[k] = False
                else:
                    batch[k] += contrib[k]
            lines_out.append({"id": line["id"], "description": desc, "grams": grams, "nutrients": contrib})
        n = recipe["portions"]
        result["recipes"][recipe["id"]] = {
            "portions": n,
            "lines": lines_out,
            "batch": batch,
            "complete": complete,
            "perPortion": {k: v / n for k, v in batch.items()},
            "batchGrams": sum(l["grams"] for l in lines_out),
        }
        pp = result["recipes"][recipe["id"]]["perPortion"]
        print(f"{recipe['name']}: {pp['kcal']:.1f} kcal, P {pp['protein']:.1f}, C {pp['carbs']:.1f}, F {pp['fat']:.1f} per serving")
    OUT.write_text(json.dumps(result, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
