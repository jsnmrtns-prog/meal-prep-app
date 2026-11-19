// M6 gate, part 1: the built-in reader on 20 sample recipes (web, printed and
// handwritten text), checked against hand-written expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseRecipeText, type ParsedIngredient } from "../../src/engine/index.ts";

const dir = new URL("../fixtures/import/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")).recipes as Record<string, {
  title: string; servings: number; steps: number; flags: string[];
  ingredients: { amount: number | null; unit: string | null; name: string; flags: string[] }[];
}>;
const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();

const unitKey = (i: ParsedIngredient) =>
  i.unit ? (i.unit.kind === "count" ? `count:${i.unit.noun}` : i.unit.unit) : i.sizeWord ? `size:${i.sizeWord}` : null;

test("there are 20 samples, each with expectations", () => {
  assert.equal(files.length, 20);
  for (const f of files) assert.ok(expected[f.replace(/\.txt$/, "")], f);
});

for (const f of files) {
  const key = f.replace(/\.txt$/, "");
  test(`reads ${key}`, () => {
    const want = expected[key]!;
    const got = parseRecipeText(readFileSync(new URL(f, dir), "utf8"));
    assert.equal(got.title, want.title, "title");
    assert.equal(got.servings, want.servings, "servings");
    assert.equal(got.steps.length, want.steps, `steps: ${JSON.stringify(got.steps)}`);
    assert.deepEqual(got.flags.map((x) => x.code).sort(), [...want.flags].sort(), "recipe flags");
    assert.equal(got.ingredients.length, want.ingredients.length, `ingredients: ${got.ingredients.map((i) => i.raw).join(" | ")}`);
    want.ingredients.forEach((w, i) => {
      const g = got.ingredients[i]!;
      const where = `${key} #${i + 1} "${g.raw}"`;
      if (w.amount === null) assert.equal(g.amount, null, `${where} amount`);
      else assert.ok(g.amount !== null && Math.abs(g.amount - w.amount) < 1e-9, `${where} amount ${g.amount} ≠ ${w.amount}`);
      assert.equal(unitKey(g), w.unit, `${where} unit`);
      assert.ok(g.name.toLowerCase().includes(w.name.toLowerCase()), `${where} name "${g.name}" should include "${w.name}"`);
      assert.deepEqual(g.flags.map((x) => x.code).sort(), [...w.flags].sort(), `${where} flags: ${g.flags.map((x) => x.message).join(" / ")}`);
    });
  });
}

test("every line that needs an answer carries a 'fix' flag", () => {
  for (const f of files) {
    const got = parseRecipeText(readFileSync(new URL(f, dir), "utf8"));
    for (const i of got.ingredients) {
      if (i.amount === null) assert.ok(i.flags.some((x) => x.severity === "fix"), `${f}: "${i.raw}" has no amount but no fix flag`);
    }
  }
});
