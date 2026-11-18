"""Builds public/data/yields.json: weight-change factors for meal prep.

Three kinds, each with its source:
  cook       Raw → cooked weight for meat and poultry. Copied from the USDA Table
             of Cooking Yields for Meat and Poultry, Release 2 (xlsx, pinned).
  bone       Bone-in retail cut → usable raw meat. Transcribed by hand from
             USDA Agriculture Handbook No. 102 (1975), Table 1, page 14. The scan
             has no text layer, so every value below was read from the page
             image and double-checked against a zoomed view.
  hydration  Dry → cooked weight for grains and pasta. Derived from USDA SR Legacy
             raw/cooked record pairs by solids balance:
                 yield = (100 − water_dry) ÷ (100 − water_cooked)
             (assumes no solids are lost; the protein-balance value is kept as
             the low end of the range because some solids leach into the water).

These factors are used for purchase amounts and container weights only, never
for nutrition, which always comes from the raw/dry weight.

Run:  python3 -I scripts/build_yields.py   (after `npm run usda:fetch`)
"""
import csv
import hashlib
import json
import pathlib
import re
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
SOURCES = json.loads((ROOT / "scripts" / "usda-sources.json").read_text())
SR_DIR = RAW / "srLegacy" / "FoodData_Central_sr_legacy_food_csv_2018-04"
OUT = ROOT / "public" / "data" / "yields.json"

# Handbook 102, Table 1, page 14: "Retail cuts: Steaks", lean and fat meat (raw) after removing bone.
HANDBOOK_102_STEAKS = [
    (242, "Beef steak, club (bone-in)", 83, 79, 88),
    (243, "Beef steak, porterhouse (bone-in)", 91, 88, 92),
    (244, "Beef steak, round (bone-in)", 96, 95, 96),
    (245, "Beef steak, sirloin, wedge and round bone", 92, 90, 94),
    (246, "Beef steak, sirloin, hip bone, short hip, short loin and double bone", 83, 80, 87),
    (247, "Beef steak, T-bone", 88, 83, 91),
]

# SR Legacy (dry, cooked) pairs for grain hydration.
GRAIN_PAIRS = [
    ("rice-white-long-grain", "White rice, long-grain", 168877, 168878),
    ("rice-brown-long-grain", "Brown rice, long-grain", 169703, 169704),
    ("pasta-enriched", "Pasta, enriched (all shapes)", 169736, 169737),
]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_xlsx_rows(path):
    """Reads the first sheet of an .xlsx with the standard library (no openpyxl needed)."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row in sheet.iter(f"{{{ns['m']}}}row"):
        cells = {}
        for c in row.findall("m:c", ns):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", ns)
            if v is None:
                is_ = c.find("m:is", ns)
                val = "".join(t.text or "" for t in is_.iter(f"{{{ns['m']}}}t")) if is_ is not None else None
            elif c.get("t") == "s":
                val = shared[int(v.text)]
            else:
                val = v.text
            cells[col] = val
        rows.append(cells)
    return rows


def num(x):
    if x is None or str(x).strip().lower() in ("", "n/a", "na", "none"):
        return None
    return float(x)


def main():
    entries = []

    # --- cooking yields (USDA table) ---
    cy = SOURCES["extraFiles"]["cookingYields"]
    cy_path = RAW / cy["file"]
    assert sha256(cy_path) == cy["sha256"], "cooking yield file checksum mismatch"
    rows = read_xlsx_rows(cy_path)
    header = [rows[0].get(c, "") for c in "ABCDEFGHIJKL"]
    assert "NDB" in header[1] and "Cooking Yield" in header[4], f"unexpected header {header}"
    seen = set()
    for r in rows[1:]:
        if not r.get("B"):
            continue
        ndb = int(float(r["B"]))
        method = (r.get("D") or "").strip()
        yid = f"cook-{ndb}"
        assert yid not in seen, f"duplicate {yid}"
        seen.add(yid)
        n = num(r.get("F"))
        entries.append({
            "id": yid,
            "kind": "cook",
            "description": (r.get("C") or "").strip(),
            "method": method,
            "percent": num(r["E"]),
            "min": num(r.get("H")),
            "max": num(r.get("I")),
            "samples": int(n) if n is not None else None,
            "source": "usda_cooking_yields_r2",
            "ref": f"NDB {ndb}",
        })

    # --- bone removal (Handbook 102) ---
    hb = SOURCES["extraFiles"]["handbook102"]
    assert sha256(RAW / hb["file"]) == hb["sha256"], "handbook checksum mismatch"
    for item, desc, avg, lo, hi in HANDBOOK_102_STEAKS:
        entries.append({
            "id": f"bone-ah102-{item}", "kind": "bone", "description": desc, "method": "Bone removed, raw",
            "percent": float(avg), "min": float(lo), "max": float(hi), "samples": None,
            "source": "usda_ah102", "ref": f"Table 1, item {item}, page 14",
        })

    # --- grain hydration (derived from SR Legacy) ---
    with open(SR_DIR / "nutrient.csv", newline="") as fh:
        nid = {r["id"]: r["nutrient_nbr"] for r in csv.DictReader(fh)}
    want = {i for _, _, a, b in GRAIN_PAIRS for i in (a, b)}
    vals = {i: {} for i in want}
    with open(SR_DIR / "food_nutrient.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            i = int(r["fdc_id"])
            if i in vals and nid.get(r["nutrient_id"]) in ("255", "203") and r["amount"]:
                vals[i][nid[r["nutrient_id"]]] = float(r["amount"])
    for key, desc, dry, cooked in GRAIN_PAIRS:
        d, c = vals[dry], vals[cooked]
        solids = (100 - d["255"]) / (100 - c["255"])
        protein = d["203"] / c["203"]
        entries.append({
            "id": f"hydrate-{key}", "kind": "hydration", "description": desc, "method": "Boiled or steamed, drained",
            "percent": solids * 100, "min": min(solids, protein) * 100, "max": max(solids, protein) * 100,
            "samples": None, "source": "derived_sr_legacy",
            "ref": f"FDC {dry} (dry, water {d['255']} g) and FDC {cooked} (cooked, water {c['255']} g)",
        })

    out = {
        "schema": 1,
        "sources": {
            "usda_cooking_yields_r2": {"citation": cy["citation"], "file": cy["file"], "sha256": cy["sha256"]},
            "usda_ah102": {"citation": hb["citation"], "file": hb["file"], "sha256": hb["sha256"]},
            "derived_sr_legacy": {"citation": "Derived by this app from USDA SR Legacy (2018-04) raw and cooked records by solids balance."},
        },
        "entries": entries,
    }
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    kinds = {k: sum(e["kind"] == k for e in entries) for k in ("cook", "bone", "hydration")}
    print(f"Wrote {OUT.relative_to(ROOT)}: {kinds}")
    for e in entries:
        if e["kind"] == "hydration":
            print(f"  {e['description']}: ×{e['percent'] / 100:.3f} (range ×{e['min'] / 100:.2f}–×{e['max'] / 100:.2f})")


if __name__ == "__main__":
    main()
