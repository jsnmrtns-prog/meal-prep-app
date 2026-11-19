// Recipe formats seen around the web, rewritten as original recipes in
// tests/fixtures/import-formats: words glued together ("2 Tbspolive oil",
// "400gcan"), the amount on one line and the food on the next, "subheading:"
// lines, section labels without colons, "250g / 8oz", "(Note 1)", "($0.40)"
// prices, "1 15oz. can", "3 x 400g cans", UK "heaped tsp" and "about 200g",
// print-page clutter ("Print Recipe", "5 from 1 vote", "Prep Time20 minutes"),
// "Yield: 1 loaf, 16 slices", and a PDF where two ingredients share a line.
// expected.json was checked by hand line by line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseRecipeText } from "../../src/engine/index.ts";

const dir = new URL("../fixtures/import-formats/", import.meta.url);
type Row = [number | null, string | null, string, string[]];
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")) as Record<string, { title: string | null; servings: number | null; steps: number; notes: number; ingredients: Row[] }>;

for (const f of readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()) {
  const key = f.replace(/\.txt$/, "");
  test(`format: ${key}`, () => {
    const want = expected[key]!;
    const r = parseRecipeText(readFileSync(new URL(f, dir), "utf8"));
    assert.equal(r.title, want.title, "title");
    assert.equal(r.servings, want.servings, "servings");
    assert.equal(r.steps.length, want.steps, `steps: ${JSON.stringify(r.steps)}`);
    assert.equal(r.notes.length, want.notes, `notes: ${JSON.stringify(r.notes)}`);
    const got: Row[] = r.ingredients.map((i) => [
      i.amount === null ? null : Math.round(i.amount * 1000) / 1000,
      i.unit ? (i.unit.kind === "count" ? `count:${i.unit.noun}` : i.unit.unit) : null,
      i.name,
      i.flags.filter((x) => x.severity === "fix").map((x) => x.code),
    ]);
    assert.deepEqual(got, want.ingredients);
  });
}
