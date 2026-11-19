// Smoke test for the built site at iPhone size, served under a subpath the way
// GitHub Pages serves a project site (https://<user>.github.io/<repo>/).
// Runs in Chromium; real Safari behaviour still needs a check on the iPhone.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../..", import.meta.url).pathname;
const dist = join(root, "dist");
const outDir = join(root, "tests/e2e/output");
const BASE = "/meal-prep-app/";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!path.startsWith(BASE)) {
    res.writeHead(404).end("Not found");
    return;
  }
  let file = normalize(join(dist, path.slice(BASE.length)));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (path.endsWith("/")) file = join(file, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}${BASE}`;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
});
const page = await context.newPage();
// The report's "Shopping list" and "Nutrition & checks" folds start closed for you; the older checks look inside them.
// The cooking-view check below closes them again to see the screen as you do.
await page.addInitScript(() => {
  const open = () => document.querySelectorAll("details.fold:not([data-seen])").forEach((d) => { if (!sessionStorage.getItem("keepFoldsClosed")) d.open = true; d.setAttribute("data-seen", "1"); });
  new MutationObserver(open).observe(document, { subtree: true, childList: true });
});
page.setDefaultTimeout(10000);
page.on("crash", () => console.log("  [page crashed]"));
browser.on("disconnected", () => console.log("  [browser disconnected]"));
console.log(`Testing ${url}`);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok - ${name}\n  ${error.message.split("\n").join("\n  ")}`);
  }
}

await mkdir(outDir, { recursive: true });
await page.goto(url);

await check("first run shows setup, then the home screen", async () => {
  await page.getByTestId("onboarding").waitFor();
  await page.screenshot({ path: join(outDir, "onboarding.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Any food allergies?").waitFor();
  await page.getByRole("button", { name: "No allergies, next" }).click();
  await page.getByText("Light garlic", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Start using the app" }).click();
  await page.getByRole("heading", { level: 1, name: "Meal Prep" }).waitFor();
  await page.getByRole("button", { name: "Import a recipe" }).waitFor();
  await page.screenshot({ path: join(outDir, "home.png"), animations: "disabled" });
});

await check("install hint shows in a Safari tab", async () => {
  await page.getByText("Add to Home Screen").waitFor();
});

await check("all five tabs navigate", async () => {
  const tabs = [
    ["Import", "Import Recipe"],
    ["My Recipes", "My Recipes"],
    ["Shopping", "Shopping Lists"],
    ["Settings", "Settings"],
    ["Home", "Meal Prep"],
  ];
  for (const [label, title] of tabs) {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }).click();
    await page.getByRole("heading", { level: 1, name: title }).waitFor();
  }
});

/** Answer every line under "Needs you": pick the first USDA size, or enter 100 g, then tick it. */
async function clearNeeds() {
  for (let guard = 0; guard < 30; guard++) {
    const row = page.getByTestId("review-needs").locator('[data-testid^="review-row-"]').first();
    if (!(await row.count())) return;
    const chip = row.locator(".chip").first();
    const size = row.locator('select[aria-label^="Size"]');
    const grams = row.locator('input[aria-label^="Grams"]');
    const tick = row.locator('input[aria-label$="checked"]');
    if (await chip.count()) await chip.click();
    else if (await size.count()) await size.selectOption({ index: 1 });
    else if (await grams.count()) {
      await grams.fill("100");
      await row.getByRole("button", { name: "Use grams" }).click();
    } else await tick.check();
    await page.waitForTimeout(50);
  }
  throw new Error("lines under Needs you didn't clear");
}

async function openTextBox() {
  const link = page.getByRole("button", { name: "Type or paste the text yourself" });
  if (await link.count()) await link.click();
}

await check("home import button opens the Import tab", async () => {
  await page.getByRole("button", { name: "Import a recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Import Recipe" }).waitFor();
  await page.screenshot({ path: join(outDir, "import.png"), animations: "disabled" });
});

await check("settings shows engine version and device status", async () => {
  await page.goto(`${url}#/settings`);
  await page.getByText("Engine version").waitFor();
  assert.equal(await page.getByTestId("opened-from").textContent(), "Browser tab");
  await page.screenshot({ path: join(outDir, "settings.png"), animations: "disabled" });
});

await check("settings shows the USDA database and citation", async () => {
  await page.goto(`${url}#/settings`);
  await page.getByTestId("food-count").getByText("8,217").waitFor();
  await page.getByText("U.S. Department of Agriculture, Agricultural Research Service. FoodData Central").waitFor();
});

await check("food lookup finds chicken breast and shows USDA values", async () => {
  await page.getByRole("link", { name: "Look up a food" }).click();
  await page.getByRole("heading", { level: 1, name: "Food Lookup" }).waitFor();
  await page.getByLabel("Search foods").fill("chicken breast boneless skinless raw");
  await page.getByRole("link", { name: /Chicken, breast, boneless, skinless, raw/ }).first().waitFor();
  await page.screenshot({ path: join(outDir, "food-search.png"), animations: "disabled" });
  await page.getByRole("link", { name: /Chicken, breast, boneless, skinless, raw/ }).first().click();
  await page.getByRole("heading", { level: 1, name: "Food Details" }).waitFor();
  await page.getByText("112 kcal").waitFor();
  await page.getByText("USDA Atwater (specific factors)").waitFor();
  await page.screenshot({ path: join(outDir, "food-detail.png"), animations: "disabled", fullPage: true });
  // Settings tab stays highlighted inside the lookup screens.
  const active = await page.locator(".tab--active").textContent();
  assert.equal(active, "Settings");
});

await check("incomplete USDA records are labelled unusable", async () => {
  await page.goto(`${url}#/foods/748608`); // Foundation olive oil record without calories
  await page.getByText("This USDA record is incomplete").waitFor();
});

await check("allergen screen shows on food details", async () => {
  await page.goto(`${url}#/foods/173410`); // Butter, salted
  await page.getByText("Milk", { exact: true }).waitFor();
});

await check("My Recipes lists both reference recipes with calculated values", async () => {
  await page.goto(`${url}#/recipes`);
  await page.getByRole("link", { name: /Teriyaki Chicken Fried Rice.*588 kcal/ }).waitFor();
  await page.getByRole("link", { name: /Taco Mac N Cheese.*577 kcal/ }).waitFor();
  await page.screenshot({ path: join(outDir, "recipes.png"), animations: "disabled" });
});

await check("nutrition report shows status, printed comparison, sources and checks", async () => {
  await page.getByRole("link", { name: /Teriyaki Chicken Fried Rice/ }).click();
  await page.getByRole("heading", { level: 1, name: "Recipe" }).waitFor();
  await page.getByTestId("recipe-status").getByText("Estimate").waitFor();
  await page.getByText("515 kcal").waitFor(); // what the recipe says
  await page.getByTestId("details-fold").getByText("588 kcal").waitFor(); // calculated
  await page.getByText(/Stand-in: Alcoholic beverage, rice \(sake\) for mirin/).waitFor();
  await page.getByText("Kept 50%: 3 → 1.5").waitFor();
  for (const id of [2, 3, 4]) assert.equal(await page.getByTestId(`audit-${id}`).locator(".badge").textContent(), "Passed");
  assert.equal(await page.getByTestId("audit-5").locator(".badge").textContent(), "Passed, notes");
  const shop = page.getByTestId("shopping");
  await shop.getByText("1 × 2 lb bag").waitFor();
  await shop.getByText("1 lb 9.0 oz by weight").waitFor();
  await shop.getByText("1 × dozen large eggs").waitFor();
  await shop.getByText("Pantry: check you have these").waitFor();
  assert.equal(await shop.getByText("cold water").count(), 0);
  await page.getByTestId("per-container").getByText("15.1 oz (428 g)").waitFor();
  assert.equal(await page.locator(".tab--active").textContent(), "My Recipes");
  await page.screenshot({ path: join(outDir, "report.png"), animations: "disabled", fullPage: true });
});

await check("taco shopping list buys whole items and one 1 lb package of beef", async () => {
  await page.goto(`${url}#/recipes/taco-mac-n-cheese`);
  const shop = page.getByTestId("shopping");
  await shop.getByText("1 × 1 lb package").waitFor();
  assert.equal(await shop.getByText("2 large peppers").count(), 2);
  await shop.getByText("1 medium onion").waitFor();
  await page.screenshot({ path: join(outDir, "shopping.png"), animations: "disabled", fullPage: true });
});

await check("home lists the two macro presets", async () => {
  await page.goto(`${url}#/home`);
  await page.getByText("750 kcal · at least 75 g protein · at least 50 g carbs · 6 meals · ±2%").waitFor();
  await page.getByText("850 kcal · 75–85 g protein · at least 60 g carbs · 6 meals · ±2%").waitFor();
});

await check("the recipe opens on a simple cooking view: summary, ingredients, steps with the amounts written in; details folded", async () => {
  await page.goto(`${url}#/recipes/teriyaki-chicken-fried-rice`);
  await page.evaluate(() => sessionStorage.setItem("keepFoldsClosed", "1"));
  await page.reload();
  const cook = page.getByTestId("cook");
  await cook.getByText("Makes 5 containers", { exact: false }).waitFor();
  await cook.getByText("588 kcal", { exact: false }).waitFor();
  assert.ok((await page.getByTestId("cook-ingredients").locator(".row").count()) >= 10);
  assert.ok((await page.getByTestId("cook-steps").locator(".amt").count()) >= 5, "amounts are written into the steps");
  assert.equal(await page.getByTestId("shopping-fold").getAttribute("open"), null, "shopping list starts folded");
  assert.equal(await page.getByTestId("details-fold").getAttribute("open"), null, "nutrition & checks start folded");
  await page.screenshot({ path: join(outDir, "cook-view.png"), animations: "disabled", fullPage: true });
  await page.getByTestId("preset-picker").getByRole("link", { name: "850 kcal" }).click();
  await page.getByTestId("cook-summary").getByText("Makes 6 containers", { exact: false }).waitFor();
  await page.getByTestId("cook-summary").getByText(/kcal ✓/).waitFor();
  await page.screenshot({ path: join(outDir, "cook-view-850.png"), animations: "disabled", fullPage: true });
  await page.evaluate(() => sessionStorage.removeItem("keepFoldsClosed"));
});

await check("teriyaki at 750 kcal: thighs leave no room for 50 g carbs, so options are offered; chicken breast meets every target", async () => {
  await page.goto(`${url}#/recipes/teriyaki-chicken-fried-rice`);
  await page.getByTestId("preset-picker").getByRole("link", { name: "750 kcal" }).click();
  await page.getByTestId("preset-line").getByText(/Standard Meal Prep/).waitFor();
  await page.getByTestId("conflict").getByText(/there isn't room for at least 50 g carbs within 750 kcal/).waitFor();
  assert.equal(await page.locator('.seg__item--active').textContent(), "750 kcal");
  await page.screenshot({ path: join(outDir, "scaled-750.png"), animations: "disabled", fullPage: true });
  await page.getByTestId("options").getByRole("button", { name: /Use chicken breast instead of thighs/ }).click();
  await page.getByTestId("picked-option").getByText("Option: Use chicken breast instead of thighs").waitFor();
  for (const t of ["kcal", "protein", "carbs"]) assert.equal(await page.getByTestId(`target-${t}`).locator(".badge").textContent(), "Met", t);
  await page.getByTestId("cook-summary").getByText("Makes 6 containers", { exact: false }).waitFor();
  await page.getByTestId("cook-steps").getByText(/Divide into 6 servings/).waitFor();
  await page.getByTestId("cook").getByText(/chicken breast wherever the steps say/).waitFor();
  await page.getByTestId("ingredients").getByText("Chicken, breast, boneless, skinless, raw", { exact: false }).first().waitFor();
  for (const id of [1, 2, 3, 4, 5]) assert.notEqual(await page.getByTestId(`audit-${id}`).locator(".badge").textContent(), "Failed");
  await page.screenshot({ path: join(outDir, "scaled-750-breast.png"), animations: "disabled", fullPage: true });
  await page.getByRole("button", { name: "‹ Back to all options" }).click();
  await page.getByTestId("conflict").waitFor();
});

await check("taco scaled to 850 kcal meets the targets", async () => {
  await page.goto(`${url}#/recipes/taco-mac-n-cheese/higher-850`);
  assert.equal(await page.getByTestId("target-kcal").locator(".badge").textContent(), "Met");
  assert.equal(await page.getByTestId("target-protein").locator(".badge").textContent(), "Met");
  await page.getByTestId("changes").getByText("93% lean ground beef").waitFor();
  await page.getByTestId("changes").getByText("2% cottage cheese").waitFor();
  assert.equal(await page.getByTestId("audit-4").locator(".badge").textContent(), "Passed");
  await page.screenshot({ path: join(outDir, "scaled-850-taco.png"), animations: "disabled", fullPage: true });
});

await check("M5 gate: a typed-in recipe is verified and still there after reopening", async () => {
  await page.goto(`${url}#/recipes`);
  await page.getByRole("button", { name: "New recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "New Recipe" }).waitFor();
  await page.getByLabel("Recipe name").fill("Chicken and Rice Bowl");
  await page.getByLabel("Servings").fill("4");
  await page.getByLabel("Step 1").fill("Cook the white rice according to the package.");
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByLabel("Step 2").fill("Season and grill the chicken breast, then slice it and serve over the rice.");

  const addIngredient = async (name, query, result, amount, step) => {
    await page.getByRole("button", { name: "Add an ingredient" }).click();
    const form = page.getByTestId("ingredient-form");
    await form.getByLabel("Ingredient name").fill(name);
    await form.getByLabel("Search USDA foods").fill(query);
    await form.getByRole("button", { name: new RegExp(`^${result}`) }).first().click();
    await form.getByTestId("picked-food").getByText(result).waitFor();
    await form.getByLabel("Amount").fill(String(amount));
    await form.getByLabel(new RegExp(`^Step ${step}`)).check();
    if (step === 2) await form.screenshot({ path: join(outDir, "ingredient-form.png"), animations: "disabled" });
    await form.getByRole("button", { name: "Done" }).click();
  };
  await addIngredient("chicken breast", "chicken breast boneless skinless raw", "Chicken, breast, boneless, skinless, raw", 900, 2);
  await addIngredient("white rice", "white rice long grain raw", "Rice, white, long-grain, regular, raw, enriched", 300, 1);
  const status = page.getByTestId("editor-status");
  await status.waitFor();
  assert.match(await status.locator("strong").textContent(), /^Verified/);
  await page.screenshot({ path: join(outDir, "editor.png"), animations: "disabled", fullPage: true });
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Recipe" }).waitFor();
  await page.getByRole("heading", { name: "Chicken and Rice Bowl" }).waitFor();
  assert.match(await page.getByTestId("recipe-status").locator("strong").textContent(), /^Verified/);
  for (const id of [1, 2, 3, 4, 5]) assert.notEqual(await page.getByTestId(`audit-${id}`).locator(".badge").textContent(), "Failed");

  // Close and reopen: the recipe comes back from the phone's storage.
  await page.goto("about:blank");
  await page.goto(`${url}#/recipes`);
  await page.getByTestId("library").getByRole("link", { name: /Chicken and Rice Bowl.*Verified/ }).waitFor();
  await page.screenshot({ path: join(outDir, "library.png"), animations: "disabled" });
});

await check("editing keeps the previous version, and it can be restored", async () => {
  await page.getByTestId("library").getByRole("link", { name: /Chicken and Rice Bowl/ }).click();
  await page.getByTestId("recipe-actions").getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Servings").fill("5");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByTestId("recipe-actions").getByRole("link", { name: "Versions (1)" }).click();
  await page.getByText("4 servings", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("heading", { level: 1, name: "Recipe" }).waitFor();
  await page.getByText("4 servings ·", { exact: false }).waitFor();
});

await check("a new preset can be made and used to scale a recipe", async () => {
  await page.goto(`${url}#/settings/presets`);
  await page.getByRole("button", { name: "New preset" }).click();
  await page.getByRole("heading", { level: 1, name: "Edit Preset" }).waitFor();
  await page.getByLabel("Preset name").fill("Lean cut");
  await page.getByLabel("Calories per meal").fill("600");
  await page.getByLabel("Protein grams").fill("60");
  await page.getByLabel("Meals").fill("5");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved on this phone.").waitFor();
  await page.goto(`${url}#/recipes/chicken-and-rice-bowl`);
  await page.getByTestId("preset-picker").locator("select").selectOption({ label: "Lean cut (600 kcal)" });
  await page.getByTestId("preset-line").getByText(/Lean cut: 600 kcal · at least 60 g protein · 5 meals/).waitFor();
  assert.equal(await page.getByTestId("target-kcal").locator(".badge").textContent(), "Met");
  assert.equal(await page.getByTestId("target-protein").locator(".badge").textContent(), "Met");
  await page.screenshot({ path: join(outDir, "scaled-custom.png"), animations: "disabled", fullPage: true });
});

await check("a food to avoid flags recipes that contain it", async () => {
  await page.goto(`${url}#/settings/allergies`);
  await page.getByRole("button", { name: "Add a food to avoid" }).click();
  await page.getByLabel("Avoid item 1 name").fill("Rice");
  await page.getByLabel("Avoid item 1 words").fill("rice");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved on this phone.").waitFor();
  await page.goto(`${url}#/recipes/chicken-and-rice-bowl`);
  await page.getByTestId("recipe-status").getByText("Needs review").waitFor();
  await page.getByText(/which is on your avoid list \(Rice\)/).first().waitFor();
  await page.goto(`${url}#/settings/allergies`);
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved on this phone.").waitFor();
});

await check("backup exports, a damaged file is refused, and restore brings data back", async () => {
  await page.goto(`${url}#/settings/backup`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export a backup/ }).click()]);
  const file = join(outDir, "backup.json");
  await download.saveAs(file);
  const backup = JSON.parse(await readFile(file, "utf8"));
  assert.equal(backup.app, "meal-prep-app");
  assert.ok(backup.recipes.some((r) => r.id === "chicken-and-rice-bowl"));

  await page.getByLabel("Backup file").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"app":"meal-prep-app","schema":1}') });
  await page.getByTestId("backup-problems").getByText("Can't restore this file:").waitFor();

  // Delete the recipe, then restore it from the backup.
  await page.goto(`${url}#/recipes/chicken-and-rice-bowl`);
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("recipe-actions").getByRole("button", { name: "Delete" }).click();
  await page.getByTestId("library").waitFor();
  assert.equal(await page.getByTestId("library").getByRole("link", { name: /Chicken and Rice Bowl/ }).count(), 0);
  await page.goto(`${url}#/settings/backup`);
  await page.getByLabel("Backup file").setInputFiles(file);
  await page.getByTestId("backup-preview").getByRole("button", { name: "Replace everything with this backup" }).click();
  await page.getByText("Restored.", { exact: false }).waitFor();
  await page.goto(`${url}#/recipes`);
  await page.getByTestId("library").getByRole("link", { name: /Chicken and Rice Bowl/ }).waitFor();
});

await check("M6: a pasted web recipe is read, every line checked, and saved with its original text", async () => {
  const text = await readFile(new URL("../fixtures/import/01-web-chicken-burrito-bowls.txt", import.meta.url), "utf8");
  await page.goto(`${url}#/import`);
  await openTextBox();
  await page.getByLabel("Recipe text").fill(text);
  await page.getByRole("button", { name: "Read recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Check the Import" }).waitFor();
  assert.equal(await page.getByLabel("Recipe name").inputValue(), "Chicken Burrito Bowls");
  assert.equal(await page.getByLabel("Servings").inputValue(), "4");
  // Only the lines that need you are open; the rest start ticked and folded into one short list.
  const needs = await page.getByTestId("review-needs").locator('[data-testid^="review-row-"]').count();
  assert.ok(needs <= 3, `${needs} lines need you`);
  await page.screenshot({ path: join(outDir, "import-review.png"), animations: "disabled", fullPage: true });
  await page.getByTestId("review-sure").getByRole("button", { name: /lines look right/ }).click();
  assert.equal(await page.locator('[data-testid^="review-row-"]').count(), 11);
  // Notes worth a glance still show on folded lines.
  await page.getByTestId("review-row-2").getByText(/Uses the package size given/).waitFor();
  await page.getByTestId("review-row-8").getByText(/No amount given: using ¼ tsp/).waitFor();
  await page.getByTestId("review-row-9").getByText(/No amount given: using ¼ tsp/).waitFor();
  await page.screenshot({ path: join(outDir, "import-review-open.png"), animations: "disabled", fullPage: true });
  // Tapping a folded line reopens it; leave the pepper out from there.
  await page.getByTestId("review-row-9").click();
  await page.getByTestId("review-needs").getByTestId("review-row-9").getByRole("button", { name: "Leave out" }).click();
  await clearNeeds();
  await page.getByRole("button", { name: "Continue to the recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "New Recipe" }).waitFor();
  await page.getByTestId("from-import").waitFor();
  const status = await page.getByTestId("editor-status").locator("strong").textContent();
  assert.ok(status === "Verified with assumptions" || status === "Verified", `status ${status}`);
  // Nothing to fix; the notes are folded away.
  assert.equal(await page.getByTestId("editor-fixes").count(), 0);
  await page.getByTestId("editor-notes").locator("summary").getByText(/nothing you need to do/).waitFor();
  await page.getByTestId("editor-notes").locator("summary").click();
  await page.getByTestId("editor-status").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, "import-editor-checks.png"), animations: "disabled", fullPage: false });
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Recipe" }).waitFor();
  await page.getByRole("heading", { name: "Chicken Burrito Bowls" }).waitFor();
  for (const id of [1, 2, 3, 4, 5]) assert.notEqual(await page.getByTestId(`audit-${id}`).locator(".badge").textContent(), "Failed");
  await page.getByTestId("source").locator("summary").click();
  await page.getByTestId("source").getByText("▢ 1 ½ lbs boneless skinless chicken breasts").waitFor();
  await page.screenshot({ path: join(outDir, "import-saved.png"), animations: "disabled", fullPage: true });
});

await check("importing a recipe you already have offers to replace it, and you end up with one copy", async () => {
  const text = await readFile(new URL("../fixtures/import/01-web-chicken-burrito-bowls.txt", import.meta.url), "utf8");
  await page.goto(`${url}#/import`);
  await openTextBox();
  await page.getByLabel("Recipe text").fill(text);
  await page.getByRole("button", { name: "Read recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Check the Import" }).waitFor();
  const dup = page.getByTestId("duplicate");
  await dup.getByText("You already have “Chicken Burrito Bowls”.").waitFor();
  assert.equal(await dup.getByRole("radio", { name: "Replace it" }).getAttribute("aria-checked"), "true");
  await page.screenshot({ path: join(outDir, "import-duplicate.png"), animations: "disabled", fullPage: false });
  await clearNeeds();
  await page.getByRole("button", { name: "Continue to the recipe" }).click();
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Recipe" }).waitFor();
  await page.goto(`${url}#/recipes`);
  await page.getByRole("heading", { level: 1, name: "My Recipes" }).waitFor();
  await page.screenshot({ path: join(outDir, "recipes-after-dup.png"), animations: "disabled", fullPage: true });
  assert.equal(await page.getByText("Chicken Burrito Bowls", { exact: true }).count(), 1);
});

await check("M6: a PDF with two columns of ingredients opens straight into the review", async () => {
  await page.goto(`${url}#/import`);
  await page.getByLabel("Recipe file").setInputFiles(new URL("../fixtures/import-files/two-column.pdf", import.meta.url).pathname);
  await page.getByRole("heading", { level: 1, name: "Check the Import" }).waitFor({ timeout: 20000 });
  await page.getByTestId("review-sure").getByRole("button", { name: /look right/ }).click();
  assert.equal(await page.locator('[data-testid^="review-row-"]').count(), 9);
  assert.equal(await page.getByLabel("Recipe name").inputValue(), "SPICY CHICKEN PASTA");
  const original = await page.getByTestId("original-text").textContent();
  assert.ok(original.indexOf("tomato passata") < original.indexOf("280g (10oz) penne"), "left column is read before the right one");
});

await check("M6: a whole cookbook PDF becomes a list of its recipes; one opens into the review with the book's calories", async () => {
  await page.goto(`${url}#/import`);
  await page.getByLabel("Recipe file").setInputFiles(new URL("../fixtures/import-files/sample-cookbook.pdf", import.meta.url).pathname);
  await page.getByRole("heading", { level: 1, name: "Cookbook" }).waitFor({ timeout: 20000 });
  const list = page.getByTestId("book-recipes");
  for (const t of ["Lemon Herb Turkey Rice Bowls", "Smoky Chicken Wraps", "GARLIC BEEF NOODLES"]) await list.getByText(t).waitFor();
  await list.getByText("book says 512 kcal", { exact: false }).waitFor();
  await page.screenshot({ path: join(outDir, "import-book.png"), animations: "disabled", fullPage: true });
  await page.getByLabel("Search recipes").fill("wraps");
  assert.equal(await list.getByText("Lemon Herb Turkey Rice Bowls").count(), 0);
  await list.getByText("Smoky Chicken Wraps").click();
  await page.getByRole("heading", { level: 1, name: "Check the Import" }).waitFor();
  assert.equal(await page.getByLabel("Recipe name").inputValue(), "Smoky Chicken Wraps");
  // The book stays listed on the Import screen.
  await page.goto(`${url}#/import`);
  await page.getByTestId("cookbooks").getByText("sample cookbook", { exact: false }).waitFor();
  await page.screenshot({ path: join(outDir, "import.png"), animations: "disabled", fullPage: true });
});

await check("cookbook-style text: groups, steps and the Accept button for lines with nothing to fix", async () => {
  const text = await readFile(new URL("../fixtures/import-files/cookbook-layout.txt", import.meta.url), "utf8");
  await page.goto(`${url}#/import`);
  await openTextBox();
  await page.getByLabel("Recipe text").fill(text);
  await page.getByRole("button", { name: "Read recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Check the Import" }).waitFor();
  const needs = await page.getByTestId("review-needs").locator('[data-testid^="review-row-"]').count();
  assert.ok(needs <= 3, `${needs} of 13 lines need you`);
  await page.getByTestId("review-sure").getByText(`${13 - needs} lines look right`).waitFor();
  await page.getByRole("button", { name: /^Instructions \(3 steps\)/ }).click();
  assert.equal(await page.getByLabel(/^Step \d+$/).count(), 3);
  await page.screenshot({ path: join(outDir, "import-cookbook.png"), animations: "disabled", fullPage: true });
});

await check("M6: the AI shortcut shows the prompt and checks a pasted AI reply", async () => {
  await page.goto(`${url}#/import`);
  await page.getByTestId("ai-shortcut").locator("summary").first().click();
  await page.getByTestId("ai-shortcut").getByText("Show the prompt").click();
  await page.getByTestId("ai-prompt").getByText(/meal-prep-recipe-v1/).first().waitFor();
  const reply = await readFile(new URL("../fixtures/import-files/ai-reply-chatgpt-style.txt", import.meta.url), "utf8");
  await openTextBox();
  await page.getByLabel("Recipe text").fill(reply);
  await page.getByRole("button", { name: "Read recipe" }).click();
  await page.getByRole("heading", { level: 1, name: "Check the Import" }).waitFor();
  assert.equal(await page.getByLabel("Recipe name").inputValue(), "Mom's chicken & rice");
  await page.getByTestId("review-row-3").getByText(/The AI read this as 2 cups, but the app reads 3 cup/).waitFor();
  await page.getByTestId("recipe-flags").getByText(/The AI wasn't sure/).waitFor();
  // A damaged reply is refused with a reason.
  await page.goto(`${url}#/import`);
  await openTextBox();
  await page.getByLabel("Recipe text").fill('```json\n{"format":"meal-prep-recipe-v1","title":"x","ingredients":[],"steps":[]}\n```');
  await page.getByRole("button", { name: "Read recipe" }).click();
  await page.getByTestId("import-error").getByText("No ingredients in the block.").waitFor();
});

await check("manifest is valid for Home Screen install", async () => {
  const res = await page.request.get(`${url}manifest.webmanifest`);
  assert.equal(res.status(), 200);
  const manifest = await res.json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  for (const icon of manifest.icons) {
    const iconRes = await page.request.get(new URL(icon.src, `${url}manifest.webmanifest`).href);
    assert.equal(iconRes.status(), 200, `icon ${icon.src}`);
  }
  const touch = await page.request.get(`${url}icons/apple-touch-icon.png`);
  assert.equal(touch.status(), 200);
});

await check("service worker installs and the app opens offline", async () => {
  await page.goto(url);
  const registered = await page.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
    ]),
  );
  assert.ok(registered, "service worker did not become ready within 10 s");
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "Meal Prep" }).waitFor({ timeout: 5000 });
  await page.goto(`${url}#/shopping`);
  await page.getByRole("heading", { level: 1, name: "Shopping Lists" }).waitFor({ timeout: 5000 });
  await page.goto(`${url}#/foods/171077`);
  await page.getByText("120 kcal").waitFor({ timeout: 5000 });
  await context.setOffline(false);
});

await check("dark mode renders", async () => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${url}#/home`);
  await page.getByRole("heading", { level: 1, name: "Meal Prep" }).waitFor();
  await page.screenshot({ path: join(outDir, "home-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
});

await check("no JavaScript errors", async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
