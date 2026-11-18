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

await check("home screen renders with title and import button", async () => {
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
