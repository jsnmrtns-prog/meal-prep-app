// M5: saved data, versions and backups. A backup must round-trip exactly, and a
// damaged file must be rejected with reasons instead of being half-loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FoodDb,
  MAX_VERSIONS,
  STARTING_PROFILE,
  applyPreferences,
  auditRecipe,
  calculateRecipe,
  checkBackup,
  customAllergenHit,
  defaultSettings,
  duplicateSavedRecipe,
  makeBackup,
  newSavedRecipe,
  optimizeRecipe,
  recipeIdFor,
  recipeProblems,
  revertSavedRecipe,
  updateSavedRecipe,
  withSeedPackages,
  type FoodDbFile,
  type Recipe,
  type UserProfile,
} from "../../src/engine/index.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const db = new FoodDb(read("../../public/data/fooddb.json") as FoodDbFile);
const teriyaki = read("../fixtures/recipes/teriyaki-fried-rice.json").recipe as Recipe;
const taco = read("../fixtures/recipes/taco-mac-and-cheese.json").recipe as Recipe;
const t0 = new Date("2026-11-18T12:00:00Z");
const t1 = new Date("2026-11-18T13:00:00Z");

test("the starting profile is the spec's test profile", () => {
  const fixture = read("../fixtures/profile.json") as UserProfile;
  assert.deepEqual(STARTING_PROFILE.preferences, fixture.preferences);
  assert.deepEqual(STARTING_PROFILE.allergies, fixture.allergies);
});

test("default settings and both reference recipes pass the backup checks", () => {
  const backup = makeBackup(defaultSettings(), [newSavedRecipe(teriyaki, "reference", t0), newSavedRecipe(taco, "reference", t0)], t1);
  const check = checkBackup(JSON.parse(JSON.stringify(backup)));
  assert.ok(check.ok, check.ok ? "" : check.problems.join("; "));
  if (check.ok) assert.deepEqual(check.backup, backup, "round trip is exact");
});

test("damaged backups are rejected with plain reasons", () => {
  assert.deepEqual(checkBackup({ hello: 1 }), { ok: false, problems: ["This isn't a Meal Prep backup file."] });
  const good = makeBackup(defaultSettings(), [newSavedRecipe(teriyaki, "reference", t0)], t1);
  const newer = { ...good, schema: 99 };
  assert.match((checkBackup(newer) as { problems: string[] }).problems[0]!, /newer version/);

  const bad = JSON.parse(JSON.stringify(good));
  bad.settings.presets[0].kcal = 200; // 75 g protein can't fit
  bad.settings.bounds.carb.min = 0;
  bad.recipes[0].recipe.lines[0].quantity.amount = -1;
  bad.recipes[0].recipe.lines[1].role = "candy";
  bad.settings.profile.allergies = ["gluten"];
  const r = checkBackup(bad);
  assert.equal(r.ok, false);
  const text = (r as { problems: string[] }).problems.join(" | ");
  assert.match(text, /Preset 1: 75 g protein \+ 50 g carbs alone/);
  assert.match(text, /limits for carb are invalid/);
  assert.match(text, /ingredient 1: amount must be zero or more/);
  assert.match(text, /ingredient 2: unknown role/);
  assert.match(text, /Unknown allergen "gluten"/);
});

test("recipe checks catch what the editor must never save", () => {
  assert.deepEqual(recipeProblems(teriyaki), []);
  const broken = { ...teriyaki, portions: 0, lines: [...teriyaki.lines, teriyaki.lines[0]] };
  const p = recipeProblems(broken).join(" | ");
  assert.match(p, /servings must be a whole number/);
  assert.match(p, /missing or repeated ID/);
});

test("saving keeps earlier versions, newest first, up to the limit; revert restores one", () => {
  let s = newSavedRecipe(teriyaki, "manual", t0);
  assert.equal(updateSavedRecipe(s, teriyaki, t1), s, "an unchanged save isn't a new version");
  for (let i = 1; i <= MAX_VERSIONS + 5; i++) {
    s = updateSavedRecipe(s, { ...s.recipe, portions: i + 5 }, new Date(t1.getTime() + i * 1000));
  }
  assert.equal(s.versions.length, MAX_VERSIONS);
  assert.equal(s.recipe.portions, MAX_VERSIONS + 10);
  assert.equal(s.versions[0]!.recipe.portions, MAX_VERSIONS + 9);
  const back = revertSavedRecipe(s, 0, new Date(t1.getTime() + 999_000));
  assert.equal(back.recipe.portions, MAX_VERSIONS + 9);
  assert.equal(back.versions[0]!.recipe.portions, MAX_VERSIONS + 10, "the replaced recipe can be restored too");
});

test("duplicates get a fresh readable ID and keep the ingredients", () => {
  const s = newSavedRecipe(taco, "reference", t0);
  const d = duplicateSavedRecipe(s, new Set([s.id]), t1);
  assert.equal(d.id, "taco-mac-n-cheese-copy");
  assert.equal(d.recipe.name, "Taco Mac N Cheese (copy)");
  assert.equal(d.origin, "manual");
  assert.deepEqual(d.recipe.lines, taco.lines);
  assert.equal(recipeIdFor("Taco Mac N Cheese (copy)", new Set(["taco-mac-n-cheese-copy"])), "taco-mac-n-cheese-copy-2");
  assert.equal(recipeIdFor("!!!", new Set()), "recipe");
});

test("custom allergens are caught by audit 1, by name or USDA description", () => {
  assert.equal(customAllergenHit("Mollusks, scallop, mixed species, raw", { label: "Mollusks", matches: ["scallop"] }), "scallop");
  assert.equal(customAllergenHit("clams in sauce", { label: "Mollusks", matches: ["clam"] }), "clam");
  assert.equal(customAllergenHit("clamato", { label: "Mollusks", matches: ["clam"] }), null);
  const profile: UserProfile = { ...STARTING_PROFILE, customAllergens: [{ label: "Corn", matches: ["corn", "cornstarch"] }] };
  const recipe = applyPreferences(teriyaki, profile.preferences).recipe;
  const report = auditRecipe(recipe, calculateRecipe(recipe, db), db, profile);
  assert.equal(report.audits[0]!.status, "fail");
  assert.match(report.audits[0]!.findings.join(" "), /"cornstarch" matches "cornstarch", which is on your avoid list \(Corn\)/);
});

test("your adjustment limits change what the optimizer may do", () => {
  const recipe = applyPreferences(teriyaki, STARTING_PROFILE.preferences).recipe;
  const preset = defaultSettings().presets[0]!;
  const strict = { ...defaultSettings().bounds, carb: { min: 0.8, max: 1.5 } };
  const r = optimizeRecipe(recipe, preset, db, { bounds: strict });
  assert.equal(r.ok, false, "with rice kept at 80% or more, thighs can't reach 750 kcal / 75 g");
  if (!r.ok) assert.ok(r.options.some((o) => /chicken breast/.test(o.title)));
});

test("new seed package sizes are added without touching yours", () => {
  const mine = defaultSettings().packages.slice(0, 3).map((p) => ({ ...p, verified: true }));
  const merged = withSeedPackages(mine);
  assert.equal(merged.length, defaultSettings().packages.length);
  assert.ok(merged.slice(0, 3).every((p) => p.verified));
});

test("newly linked USDA foods are added to your package entries without changing your sizes", () => {
  const mine = defaultSettings().packages.map((p) => (p.key === "white-rice-2lb" ? { ...p, fdcIds: [168877, 169756], verified: true } : p));
  const merged = withSeedPackages(mine);
  const rice = merged.find((p) => p.key === "white-rice-2lb")!;
  assert.deepEqual(rice.fdcIds, [168877, 169756, 2512381]);
  assert.equal(rice.verified, true);
});
