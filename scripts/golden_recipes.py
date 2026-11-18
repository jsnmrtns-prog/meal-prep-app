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
        portions[f["fdcId"]] = [
            (float(p.get("amount") or 1), p.get("measureUnit", {}).get("name", ""), float(p["gramWeight"]))
            for p in f.get("foodPortions", []) if p.get("gramWeight")
        ]
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


# --- independent purchase / package / cooked-weight references ---
OZ, LB = 28.349523125, 453.59237
# fdcId -> (rule, grams per package or item). Typical sizes, mirroring the app's seed table.
PACKAGES = {
    2646171: ("by_weight", None), 173110: ("package", LB), 168877: ("package", 2 * LB),
    169736: ("package", 16 * OZ), 170471: ("package", 12 * OZ), 323697: ("package", 16 * OZ),
    328841: ("package", 16 * OZ), 171292: ("package", 8 * OZ), 172243: ("package", 30.0),
}
PORTION_PACKAGES = {  # (rule, USDA portion label, multiplier)
    171287: ("package", "large", 12), 746772: ("package", "cup", 8), 174074: ("package", "can", 1),
    169383: ("each", 'pepper, large (3-3/4" long, 3" dia)', 1),
    170108: ("each", 'large (2-1/4 per pound, approx 3-3/4" long, 3" dia.)', 1),
    170000: ("each", 'medium (2-1/2" dia)', 1),
}


def cook_factors():
    import openpyxl  # a different reader from the app's build script, on purpose
    ws = openpyxl.load_workbook(RAW / "USDA_CookingYields_MeatPoultry02.xlsx", read_only=True).worksheets[0]
    cook = {f"cook-{int(r[1])}": float(r[4]) / 100 for r in list(ws.iter_rows(values_only=True))[1:] if r[1]}
    water = {}
    with open(SR_DIR / "nutrient.csv", newline="") as fh:
        nid = {r["id"]: r["nutrient_nbr"] for r in csv.DictReader(fh)}
    with open(SR_DIR / "food_nutrient.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if nid.get(r["nutrient_id"]) == "255" and int(r["fdc_id"]) in (168877, 168878, 169736, 169737):
                water[int(r["fdc_id"])] = float(r["amount"])
    cook["hydrate-rice-white-long-grain"] = (100 - water[168877]) / (100 - water[168878])
    cook["hydrate-pasta-enriched"] = (100 - water[169736]) / (100 - water[169737])
    return cook


def plan(recipe_lines, grams_by_id, portions, cook):
    items = {}
    for line in recipe_lines:
        food = line["food"]
        if food["kind"] == "builtin" and food["id"] == "water":
            continue
        key = f"usda-{food['fdcId']}" if food["kind"] == "usda" else f"line-{line['id']}"
        it = items.setdefault(key, {"grams": 0.0, "lines": []})
        it["grams"] += grams_by_id[line["id"]]
        it["lines"].append(line["id"])
    for key, it in items.items():
        fid = int(key.split("-")[1]) if key.startswith("usda-") else None
        if fid in PACKAGES:
            rule, size = PACKAGES[fid]
        elif fid in PORTION_PACKAGES:
            rule, label, mult = PORTION_PACKAGES[fid]
            (amt, _, g), = [p for p in portions[fid] if p[1] == label]
            size = mult * g / amt
        else:
            rule, size = "other", None
        it["rule"] = rule
        if size:
            n = 1
            while n * size < it["grams"] - 1e-9:
                n += 1
            it["count"] = n
            it["unitGrams"] = size
    cooked = 0.0
    for line in recipe_lines:
        c = line.get("cook", {"kind": "unchanged"})
        g = grams_by_id[line["id"]]
        cooked += g * (cook[c["yieldId"]] if c["kind"] == "yield" else 0.0 if c["kind"] == "absorbed" else 1.0)
    return items, cooked


def main():
    foods, portions = load()
    cook = cook_factors()
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
        kept = [l for l in recipe["lines"] if l["id"] not in after["removed"]]
        items, cooked = plan(kept, {l["id"]: l["grams"] for l in lines_out}, portions, cook)
        result["recipes"].setdefault(recipe["id"], {})
        result["recipes"][recipe["id"]] = {
            "shopping": items,
            "cookedBatchGrams": cooked,
            "perContainerGrams": cooked / n,
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
