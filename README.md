# Meal Prep

Scale recipes to your macro targets, verify nutrition against USDA data, and build grocery lists. It runs as a Home Screen web app on iPhone.

- **Plan:** "Meal Prep App — Product Development Plan v1" (Claude doc)
- **Status:** milestone M1 (USDA food database, lookup, allergen screen)

## How it fits together

| Folder | What's in it |
| --- | --- |
| `src/engine/` | MealPrepEngine: pure TypeScript with no UI, network or AI. Every number the app shows comes from here. |
| `src/app/` | The web app (React), service worker template, styles |
| `public/` | Static files: `index.html`, web manifest, icons |
| `scripts/` | `build.mjs` (bundles into `dist/`), USDA fetch/build/golden scripts, `make-icons.mjs` |
| `public/data/` | Bundled USDA food database (generated) |
| `tests/fixtures/` | Reference values from the independent Python check |
| `tests/engine/` | Engine unit tests (`node:test`) |
| `tests/e2e/` | Browser smoke test at iPhone size, served under a subpath like GitHub Pages |

## Commands

```sh
npm install          # once
npm test             # engine tests + engine type-check
npm run build        # builds dist/
npm run test:e2e     # browser smoke test (run after build)
npm run check        # all of the above
```

### USDA food data

The app bundles `public/data/fooddb.json`, built from pinned USDA FoodData Central releases
(see `scripts/usda-sources.json` for files and SHA-256 checksums). To rebuild it:

```sh
npm run usda:fetch   # downloads and verifies the USDA files into data-raw/
npm run usda:build   # writes public/data/fooddb.json
npm run usda:golden  # independent Python check values → tests/fixtures/golden-foods.json
```

Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2026.
fdc.nal.usda.gov. Public domain (CC0).

The project requires Node 22.18 or later, which runs TypeScript test files directly.

## One-time GitHub setup

1. Create a free account at github.com.
2. Create a new **public** repository named `meal-prep-app`. Leave it empty: no README, license or .gitignore.
3. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. In claude.ai, connect GitHub under **Settings → Connectors** so Claude can push to the repository.

Every push to `main` then runs the tests, builds the site and publishes it to
`https://<your-username>.github.io/meal-prep-app/`.

## Install on iPhone

1. Open the site address in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Meal Prep from the Home Screen icon. In **Settings**, "Opened from" should say **Home Screen**.

Data is stored only on your iPhone. Home Screen web apps keep their own storage, separate from Safari tabs.
