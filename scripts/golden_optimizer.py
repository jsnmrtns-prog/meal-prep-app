"""Independent check of the optimizer's results for the golden recipes (M4 gate).

Shares no code with the TypeScript engine. Reads tests/fixtures/optimized-plans.json
(written by `node scripts/export-optimized.ts`) and, from the raw USDA files:

  1. confirms each plan starts from the recipe with your preferences applied
     (checked against the hand-written `expectedAfterPreferences`);
  2. recomputes per-meal calories, protein, carbs and fat and checks every target
     (calories within tolerance, protein from the minimum to +5 g);
  3. checks that only the adjustable ingredients moved: proteins (plus dairy with
     at least 10 g protein per 100 kcal), carbs and added fats; everything else
     keeps its per-meal amount, rounded to a kitchen-friendly size;
  4. checks each adjustable group stays within its limits per meal and keeps its
     weighed ingredients in their original proportions (to the gram).

Run:  python3 -I scripts/golden_optimizer.py   (after `npm run usda:fetch`)
Writes tests/fixtures/golden-optimized-expected.json.
"""
import importlib.util
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLANS = ROOT / "tests" / "fixtures" / "optimized-plans.json"
FIXTURES = ROOT / "tests" / "fixtures" / "recipes"
OUT = ROOT / "tests" / "fixtures" / "golden-optimized-expected.json"

# Reuse the independent USDA reader and unit conversion from the M2 reference script.
spec = importlib.util.spec_from_file_location("golden_recipes", ROOT / "scripts" / "golden_recipes.py")
gr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gr)

MACROS = ("kcal", "protein", "carbs", "fat")


def grams(line, portions):
    food = line["food"]
    if food["kind"] == "builtin":
        return line["quantity"]["amount"] * gr.GRAMS[line["quantity"]["unit"]]
    return gr.grams_for(line, portions)


def per100(line, foods):
    food = line["food"]
    if food["kind"] == "builtin":
        return {k: 0.0 for k in MACROS}
    return foods[food["fdcId"]][1]


def macros(lines, foods, portions, n):
    tot = {k: 0.0 for k in MACROS}
    for line in lines:
        g = grams(line, portions)
        p = per100(line, foods)
        for k in MACROS:
            tot[k] += g * p[k] / 100
    return {k: v / n for k, v in tot.items()}


def lever(line, foods, portions):
    role = line["role"]
    if role in ("protein", "carb", "fat"):
        return role
    if role == "dairy":
        p = per100(line, foods)
        if p["kcal"] and 100 * p["protein"] / p["kcal"] >= 10:
            return "protein"
    return "fixed"


def kitchen_round(q):
    """The rounding sizes the plan promises for ingredients that aren't adjusted."""
    a, kind = q["amount"], q["kind"]
    if a == 0:
        return 0
    if kind == "count":
        size = 1 if a >= 10 else 0.5
    elif kind == "volume":
        size = {"cup": 0.125, "ml": 1, "l": 0.01}.get(q["unit"], 0.25)
    else:
        size = {"g": 0.5 if a < 10 else 1, "kg": 0.005, "oz": 0.25}.get(q["unit"], 0.05)
    return max(size, math.floor(a / size + 0.5) * size)


def check_preferences(entry):
    rid = entry["key"].split("/")[0]
    fx = next(json.loads(p.read_text()) for p in FIXTURES.glob("*.json") if json.loads(p.read_text())["recipe"]["id"] == rid)
    after = fx["expectedAfterPreferences"]
    want = [l for l in fx["recipe"]["lines"] if l["id"] not in after["removed"]]
    got = entry["original"]["lines"]
    assert [l["id"] for l in got] == [l["id"] for l in want], f"{entry['key']}: wrong starting ingredients"
    for l in got:
        expect = after["amounts"].get(l["id"], next(w for w in want if w["id"] == l["id"])["quantity"]["amount"])
        assert abs(l["quantity"]["amount"] - expect) < 1e-12, f"{entry['key']}: {l['id']} starts at {l['quantity']['amount']}, expected {expect}"


def check(entry, foods, portions):
    problems = []
    key, preset, bounds = entry["key"], entry["preset"], entry["bounds"]
    orig, new = entry["original"], entry["recipe"]
    n0, n = orig["portions"], new["portions"]
    if n != preset["meals"]:
        problems.append(f"makes {n} meals, preset asks for {preset['meals']}")
    pm = macros(new["lines"], foods, portions, n)

    kd = preset["kcal"] * preset["kcalTolerancePct"] / 100
    if not (preset["kcal"] - kd - 1e-9 <= pm["kcal"] <= preset["kcal"] + kd + 1e-9):
        problems.append(f"calories {pm['kcal']:.2f} outside {preset['kcal']} ±{preset['kcalTolerancePct']}%")
    pr = preset["protein"]
    if pr["mode"] == "minimum":
        lo, hi = pr["grams"], pr["grams"] + 5
    else:
        t = pr.get("tolerancePct", preset["kcalTolerancePct"]) / 100
        lo, hi = pr["grams"] * (1 - t), pr["grams"] * (1 + t)
    if not (lo - 1e-9 <= pm["protein"] <= hi + 1e-9):
        problems.append(f"protein {pm['protein']:.2f} outside {lo}–{hi} g")
    for k in ("carbs", "fat"):
        if k in preset:
            t = preset[k]
            lo, hi = t["grams"] * (1 - t["tolerancePct"] / 100), t["grams"] * (1 + t["tolerancePct"] / 100)
            if not (lo - 1e-9 <= pm[k] <= hi + 1e-9):
                problems.append(f"{k} {pm[k]:.2f} outside {lo:.2f}–{hi:.2f} g")

    groups = {}
    for lo_line, hi_line in zip(orig["lines"], new["lines"]):
        assert lo_line["id"] == hi_line["id"]
        lv = lever(lo_line, foods, portions)
        g0 = grams(lo_line, portions) / n0
        g1 = grams(hi_line, portions) / n
        if lv == "fixed" or g0 == 0:
            if hi_line["food"] != lo_line["food"]:
                problems.append(f"{lo_line['id']}: food changed but it isn't adjustable")
            scaled = dict(lo_line["quantity"], amount=lo_line["quantity"]["amount"] * n / n0)
            want = kitchen_round(scaled)
            q = hi_line["quantity"]
            if q["kind"] != scaled["kind"] or q.get("unit") != scaled.get("unit") or abs(q["amount"] - want) > 1e-9:
                problems.append(f"{lo_line['id']}: fixed ingredient is {q['amount']}, expected {want} {scaled.get('unit', '')}")
            continue
        f = g1 / g0
        b = bounds[lv]
        if not (b["min"] - 1e-9 <= f <= b["max"] + 1e-9):
            problems.append(f"{lo_line['id']}: {f:.3f}× per meal is outside {b['min']}–{b['max']}×")
        if hi_line["quantity"]["kind"] == "mass":
            groups.setdefault(lv, []).append((lo_line["id"], g0 * n, g1 * n))
        elif hi_line["quantity"]["kind"] == "count" and abs(hi_line["quantity"]["amount"] - round(hi_line["quantity"]["amount"])) > 1e-9:
            problems.append(f"{lo_line['id']}: adjusted count {hi_line['quantity']['amount']} isn't a whole number")

    for lv, rows in groups.items():
        # One factor for the group, from the largest weighed line. Each line is rounded to
        # the gram (½ g under 10 g), and so is the largest line the factor comes from.
        _, base, now = max(rows, key=lambda r: r[1])
        f = now / base
        for lid, b0, b1 in rows:
            own = 0.25 if b0 * f < 10 else 0.5
            if abs(b1 - b0 * f) > own + 0.5 * b0 / base + 1e-9:
                problems.append(f"{lid}: {b1:.1f} g breaks the {lv} group's proportions ({b0 * f:.1f} g expected)")
    return pm, problems


def main():
    foods, portions = gr.load()
    plans = json.loads(PLANS.read_text())["plans"]
    out = {"source": "scripts/golden_optimizer.py (independent of the TypeScript engine)", "plans": {}}
    failed = 0
    for entry in plans:
        if entry["kind"] == "conflict":
            print(f"{entry['key']}: no plan within limits ({entry['conflicts'][0][:80]}…)")
            continue
        check_preferences(entry)
        pm, problems = check(entry, foods, portions)
        out["plans"][entry["key"]] = {"perMeal": pm}
        status = "OK" if not problems else "FAIL"
        failed += bool(problems)
        print(f"{status} {entry['key']}: {pm['kcal']:.1f} kcal, P {pm['protein']:.1f}, C {pm['carbs']:.1f}, F {pm['fat']:.1f}")
        for p in problems:
            print(f"    {p}")
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}")
    if failed:
        raise SystemExit(f"{failed} plan(s) failed the independent check")


if __name__ == "__main__":
    main()
