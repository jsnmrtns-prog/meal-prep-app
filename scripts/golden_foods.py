"""Independent reference values for the 50+ common meal-prep foods (M1 gate).

This script deliberately shares NO code with the TypeScript build pipeline
(scripts/build-fooddb.mjs) or the engine. It reads the raw USDA files directly
with Python's csv and json modules and applies the energy rule from scratch.
The engine test (tests/engine/golden-foods.test.ts) then checks the bundled
database against this file, so a bug in either path shows up as a mismatch.

Run:  python3 -I scripts/golden_foods.py   (after `npm run usda:fetch`)
Writes tests/fixtures/golden-foods.json.
"""
import csv
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
FOUNDATION_JSON = RAW / "foundation" / "FoodData_Central_foundation_food_json_2026-10-29.json"
SR_DIR = RAW / "srLegacy" / "FoodData_Central_sr_legacy_food_csv_2018-04"
OUT = ROOT / "tests" / "fixtures" / "golden-foods.json"

# (key, fdcId, expected dataset) chosen by hand for typical meal-prep ingredients.
FOODS = [
    ("chicken_breast_raw", 2646170, "foundation"),
    ("chicken_breast_raw_sr", 171077, "sr_legacy"),
    ("chicken_thigh_raw", 2646171, "foundation"),
    ("ground_beef_80_20_raw", 2514744, "foundation"),
    ("ground_beef_90_10_raw", 2514743, "foundation"),
    ("ground_beef_93_7_raw", 173110, "sr_legacy"),
    ("ground_turkey_93_7_raw", 2514747, "foundation"),
    ("top_sirloin_steak_raw", 2727574, "foundation"),
    ("pork_tenderloin_raw", 2646169, "foundation"),
    ("salmon_atlantic_farmed_raw", 2684441, "foundation"),
    ("shrimp_raw", 2684443, "foundation"),
    ("egg_whole_raw", 171287, "sr_legacy"),
    ("egg_white_raw", 172183, "sr_legacy"),
    ("tuna_light_canned_water", 334194, "foundation"),
    ("tofu_firm", 172475, "sr_legacy"),
    ("rice_white_long_grain_dry", 168877, "sr_legacy"),
    ("rice_brown_long_grain_dry", 169703, "sr_legacy"),
    ("spaghetti_dry_enriched", 2758998, "foundation"),
    ("potato_russet_raw", 2346401, "foundation"),
    ("sweet_potato_raw", 2346404, "foundation"),
    ("oats_rolled", 2346396, "foundation"),
    ("tortilla_flour", 175037, "sr_legacy"),
    ("tortilla_corn", 175036, "sr_legacy"),
    ("bread_white", 2758993, "foundation"),
    ("black_beans_canned_drained", 2644285, "foundation"),
    ("cheddar", 328637, "foundation"),
    ("mozzarella_part_skim", 329370, "foundation"),
    ("milk_2_percent", 746778, "foundation"),
    ("greek_yogurt_nonfat_plain", 330137, "foundation"),
    ("butter_salted", 173410, "sr_legacy"),
    ("sour_cream", 2346387, "foundation"),
    ("cream_cheese", 173418, "sr_legacy"),
    ("parmesan_grated", 325036, "foundation"),
    ("olive_oil", 171413, "sr_legacy"),
    ("canola_oil", 172336, "sr_legacy"),
    ("onion_yellow_raw", 790646, "foundation"),
    ("garlic_raw", 1104647, "foundation"),
    ("bell_pepper_red_raw", 2258590, "foundation"),
    ("broccoli_raw", 747447, "foundation"),
    ("carrots_raw", 170393, "sr_legacy"),
    ("spinach_raw", 1999633, "foundation"),
    ("peas_frozen", 170016, "sr_legacy"),
    ("corn_kernels_raw", 2710826, "foundation"),
    ("tomatoes_canned_diced", 333281, "foundation"),
    ("green_beans_raw", 2346400, "foundation"),
    ("soy_sauce", 174277, "sr_legacy"),
    ("salt", 173468, "sr_legacy"),
    ("black_pepper", 170931, "sr_legacy"),
    ("paprika", 171329, "sr_legacy"),
    ("chili_powder", 171319, "sr_legacy"),
    ("cumin", 170923, "sr_legacy"),
    ("honey", 169640, "sr_legacy"),
    ("sugar_granulated", 746784, "foundation"),
    ("chicken_broth", 174536, "sr_legacy"),
    ("flour_all_purpose", 168936, "sr_legacy"),
]

FIELDS = {"protein": "203", "fat": "204", "carbs": "205", "fiber": "291", "sodium": "307", "satFat": "606", "water": "255"}
ENERGY = [("208", "usda_energy"), ("958", "atwater_specific"), ("957", "atwater_general")]


def from_numbers(nums):
    kcal, source = None, None
    for number, name in ENERGY:
        if number in nums:
            kcal, source = nums[number], name
            break
    row = {"kcal": kcal, "energySource": source}
    for key, number in FIELDS.items():
        row[key] = nums.get(number)
    return row


def load_foundation():
    data = json.loads(FOUNDATION_JSON.read_text())
    out = {}
    for f in data["FoundationFoods"]:
        nums = {}
        for fn in f.get("foodNutrients", []):
            if fn.get("amount") is not None:
                nums[str(fn["nutrient"]["number"])] = float(fn["amount"])
        out[f["fdcId"]] = (f["description"], nums)
    return out


def load_sr(wanted):
    with open(SR_DIR / "nutrient.csv", newline="") as fh:
        number_by_id = {r["id"]: r["nutrient_nbr"] for r in csv.DictReader(fh)}
    with open(SR_DIR / "food.csv", newline="") as fh:
        desc = {int(r["fdc_id"]): r["description"] for r in csv.DictReader(fh) if int(r["fdc_id"]) in wanted}
    nums = {i: {} for i in desc}
    with open(SR_DIR / "food_nutrient.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            i = int(r["fdc_id"])
            if i in nums and r["amount"] != "":
                nums[i][number_by_id[r["nutrient_id"]]] = float(r["amount"])
    return {i: (desc[i], nums[i]) for i in desc}


def main():
    foundation = load_foundation()
    sr = load_sr({fid for _, fid, ds in FOODS if ds == "sr_legacy"})
    rows, problems = [], []
    for key, fid, dataset in FOODS:
        source = foundation if dataset == "foundation" else sr
        if fid not in source:
            problems.append(f"{key}: {fid} not found in {dataset}")
            continue
        description, nums = source[fid]
        row = {"key": key, "fdcId": fid, "dataset": dataset, "description": description, **from_numbers(nums)}
        missing = [k for k in ("kcal", "protein", "fat", "carbs") if row[k] is None]
        if missing:
            problems.append(f"{key} ({fid} {description}): missing {', '.join(missing)}")
        rows.append(row)
    if problems:
        print("Problems:\n  " + "\n  ".join(problems))
        sys.exit(1)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": "scripts/golden_foods.py (independent of the TypeScript pipeline)", "foods": rows}, indent=1) + "\n")
    print(f"Wrote {len(rows)} reference foods to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
