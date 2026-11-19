import { useCallback, useEffect, useState, type ReactElement } from "react";
import { ENGINE_VERSION, MAJOR_ALLERGENS, describePreset, firstPreset, type Allergen } from "../engine/index.ts";
import { HomeIcon, ImportIcon, RecipesIcon, SettingsIcon, ShoppingIcon } from "./icons.tsx";
import { FoodDetailScreen, FoodSearchScreen } from "./FoodLookup.tsx";
import { loadFoodDb } from "./foodData.ts";
import { BookScreen, ImportReviewScreen, ImportScreen } from "./ImportScreens.tsx";
import { RecipeEditorScreen } from "./RecipeEditor.tsx";
import { PackageScreen, ShoppingScreen } from "./ShoppingScreen.tsx";
import { RecipeLibrary, RecipeReportScreen, RecipeVersionsScreen } from "./RecipeReport.tsx";
import {
  ALLERGEN_LABEL,
  AllergiesScreen,
  BackupScreen,
  LabelFoodEditorScreen,
  LabelFoodsScreen,
  LimitsScreen,
  PackagesScreen,
  PreferencesScreen,
  PresetEditorScreen,
  PresetsScreen,
  SettingsMenu,
} from "./SettingsScreens.tsx";
import { UserDataProvider, useUserData } from "./store.tsx";
import { Empty, Field, LinkRow, NumberInput, Row, Section, go } from "./ui.tsx";
import {
  formatBytes,
  getStorageStatus,
  isIOS,
  isStandalone,
  registerServiceWorker,
  requestPersistentStorage,
  type StorageStatus,
} from "./platform.ts";

type TabId = "home" | "import" | "recipes" | "shopping" | "settings";

const TABS: ReadonlyArray<{ id: TabId; label: string; title: string; Icon: () => ReactElement }> = [
  { id: "home", label: "Home", title: "Meal Prep", Icon: HomeIcon },
  { id: "import", label: "Import", title: "Import Recipe", Icon: ImportIcon },
  { id: "recipes", label: "My Recipes", title: "My Recipes", Icon: RecipesIcon },
  { id: "shopping", label: "Shopping", title: "Shopping List", Icon: ShoppingIcon },
  { id: "settings", label: "Settings", title: "Settings", Icon: SettingsIcon },
];

type Screen =
  | { kind: "tab" }
  | { kind: "foods" }
  | { kind: "food"; fdcId: number }
  | { kind: "recipe"; id: string; presetId: string | null }
  | { kind: "recipe-edit"; id: string | null }
  | { kind: "recipe-versions"; id: string }
  | { kind: "import-review" }
  | { kind: "book"; id: string }
  | { kind: "package" }
  | { kind: "settings"; page: string; id: string | null };

interface Route {
  tab: TabId;
  screen: Screen;
}

const SETTINGS_PAGES: Record<string, string> = {
  allergies: "Allergies",
  preferences: "Preferences",
  presets: "Macro Presets",
  limits: "Adjustment Limits",
  packages: "Package Sizes",
  labels: "Label Foods",
  backup: "Backup",
};

export function routeFromHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map((p) => decodeURIComponent(p));
  const [a = "", b, c] = parts;
  if (a === "foods") {
    const id = Number(b);
    return { tab: "settings", screen: b && Number.isInteger(id) ? { kind: "food", fdcId: id } : { kind: "foods" } };
  }
  if (a === "import" && b === "review") return { tab: "import", screen: { kind: "import-review" } };
  if (a === "shopping" && b === "package") return { tab: "shopping", screen: { kind: "package" } };
  if (a === "import" && b === "book" && c) return { tab: "import", screen: { kind: "book", id: decodeURIComponent(c) } };
  if (a === "recipes" && b) {
    if (b === "new") return { tab: "recipes", screen: { kind: "recipe-edit", id: null } };
    if (c === "edit") return { tab: "recipes", screen: { kind: "recipe-edit", id: b } };
    if (c === "versions") return { tab: "recipes", screen: { kind: "recipe-versions", id: b } };
    return { tab: "recipes", screen: { kind: "recipe", id: b, presetId: c ?? null } };
  }
  if (a === "settings" && b && b in SETTINGS_PAGES) return { tab: "settings", screen: { kind: "settings", page: b, id: c ?? null } };
  return { tab: TABS.some((t) => t.id === a) ? (a as TabId) : "home", screen: { kind: "tab" } };
}

function titleFor(route: Route): string {
  const s = route.screen;
  switch (s.kind) {
    case "foods": return "Food Lookup";
    case "food": return "Food Details";
    case "recipe": return "Recipe";
    case "recipe-edit": return s.id ? "Edit Recipe" : "New Recipe";
    case "recipe-versions": return "Versions";
    case "import-review": return "Check the Import";
    case "book": return "Cookbook";
    case "package": return "Recipe Package";
    case "settings":
      if (s.page === "presets" && s.id) return "Edit Preset";
      if (s.page === "labels" && s.id) return s.id === "new" ? "New Label Food" : "Edit Label Food";
      return SETTINGS_PAGES[s.page] ?? "Settings";
    case "tab": return TABS.find((t) => t.id === route.tab)!.title;
  }
}

export function App(): ReactElement {
  return (
    <UserDataProvider>
      <Shell />
    </UserDataProvider>
  );
}

function Shell(): ReactElement {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [updateReady, setUpdateReady] = useState(false);
  const tab = route.tab;

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    registerServiceWorker(() => setUpdateReady(true));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const s = route.screen;
  const key = window.location.hash;
  return (
    <div className="app">
      {updateReady && (
        <button className="banner banner--update" onClick={() => window.location.reload()}>
          A new version is ready. Tap to reload.
        </button>
      )}
      <InstallHint />
      <main className="screen" aria-labelledby="screen-title">
        <h1 id="screen-title" className="large-title">
          {titleFor(route)}
        </h1>
        {s.kind === "foods" && <FoodSearchScreen />}
        {s.kind === "food" && <FoodDetailScreen fdcId={s.fdcId} />}
        {s.kind === "recipe" && <RecipeReportScreen key={key} id={s.id} presetId={s.presetId} />}
        {s.kind === "recipe-edit" && <RecipeEditorScreen key={key} id={s.id} />}
        {s.kind === "recipe-versions" && <RecipeVersionsScreen key={key} id={s.id} />}
        {s.kind === "import-review" && <ImportReviewScreen key={key} />}
        {s.kind === "book" && <BookScreen key={key} id={s.id} />}
        {s.kind === "package" && <PackageScreen key={key} />}
        {s.kind === "settings" && <SettingsPage key={key} page={s.page} id={s.id} />}
        {s.kind === "tab" && tab === "home" && <HomeScreen />}
        {s.kind === "tab" && tab === "import" && <ImportScreen />}
        {s.kind === "tab" && tab === "recipes" && <RecipeLibrary />}
        {s.kind === "tab" && tab === "shopping" && <ShoppingScreen />}
        {s.kind === "tab" && tab === "settings" && <SettingsScreen />}
      </main>
      <nav className="tab-bar" aria-label="Main">
        {TABS.map(({ id, label, Icon }) => (
          <a
            key={id}
            href={`#/${id}`}
            className={`tab ${id === tab ? "tab--active" : ""}`}
            aria-current={id === tab ? "page" : undefined}
          >
            <Icon />
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

function SettingsPage({ page, id }: { page: string; id: string | null }): ReactElement {
  switch (page) {
    case "allergies": return <AllergiesScreen />;
    case "preferences": return <PreferencesScreen />;
    case "presets": return id ? <PresetEditorScreen id={id} /> : <PresetsScreen />;
    case "limits": return <LimitsScreen />;
    case "packages": return <PackagesScreen />;
    case "labels": return id ? <LabelFoodEditorScreen id={id === "new" ? null : id} /> : <LabelFoodsScreen />;
    case "backup": return <BackupScreen />;
    default: return <SettingsMenu />;
  }
}

function InstallHint(): ReactElement | null {
  const [hidden, setHidden] = useState(false);
  if (hidden || isStandalone() || !isIOS()) return null;
  return (
    <div className="banner banner--install" role="note">
      <span>
        To install, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      </span>
      <button className="banner__close" aria-label="Dismiss" onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  );
}

function HomeScreen(): ReactElement {
  const { settings, recipes } = useUserData();
  if (!settings.onboarded) return <Onboarding />;
  const recent = [...recipes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  return (
    <>
      <button className="primary-action" onClick={() => go("/import")}>
        <ImportIcon />
        Import a recipe
      </button>
      <button className="secondary-action" onClick={() => go("/recipes/new")}>Type in a recipe</button>
      <Section title="Recent recipes">
        {recent.length === 0 ? <Empty>Recipes you save will show up here.</Empty> : recent.map((r) => <LinkRow key={r.id} href={`#/recipes/${encodeURIComponent(r.id)}`} label={r.recipe.name} />)}
      </Section>
      <Section title="Macro presets">
        {settings.presets.map((p) => (
          <LinkRow key={p.id} href={`#/settings/presets/${p.id}`} label={<>{p.name}<span className="row__sub">{describePreset(p)} · ±{p.kcalTolerancePct}%</span></>} />
        ))}
      </Section>
      <Section title="Shopping list">
        {(settings.shopping?.entries.length ?? 0) === 0
          ? <Empty>Add recipes from their page to build one list for the week.</Empty>
          : <LinkRow href="#/shopping" label={<>{settings.shopping!.entries.length} {settings.shopping!.entries.length === 1 ? "recipe" : "recipes"} on your list<span className="row__sub">Tap to see what to buy</span></>} />}
      </Section>
    </>
  );
}

function Onboarding(): ReactElement {
  const { settings, saveSettings } = useUserData();
  const [step, setStep] = useState(0);
  const [allergies, setAllergies] = useState<Allergen[]>(settings.profile.allergies);
  // A blank start asks for the first meal plan; a demo start already has its presets.
  const needsPlan = settings.presets.length === 0;
  const [kcal, setKcal] = useState<number | null>(750);
  const [protein, setProtein] = useState<number | null>(75);
  const [carbs, setCarbs] = useState<number | null>(50);
  const [meals, setMeals] = useState<number | null>(6);
  const planOk = !needsPlan || (kcal !== null && kcal >= 100 && protein !== null && protein >= 0 && meals !== null && Number.isInteger(meals) && meals >= 1 && (carbs === null || carbs >= 0) && 4 * protein + 4 * (carbs ?? 0) <= kcal * 1.05);
  const finish = async () => {
    const plan = needsPlan ? firstPreset({ kcal: kcal!, protein: protein!, carbsMin: carbs, meals: meals! }) : null;
    await saveSettings({
      ...settings,
      profile: { ...settings.profile, allergies },
      ...(plan ? { presets: [plan], defaultPresetId: plan.id } : {}),
      onboarded: true,
    });
    void requestPersistentStorage();
  };
  return (
    <div className="onboarding" data-testid="onboarding">
      <p className="onboarding__step">Step {step + 1} of 3</p>
      {step === 0 && (
        <>
          <h2 className="food-title">Welcome</h2>
          <p className="lead">This app scales your meal-prep recipes to your calories and protein, checks every number against USDA data, and makes your shopping list.</p>
          <p className="lead">Everything you enter stays on this phone. Nothing is sent anywhere, and there's no account.</p>
          <button className="primary-action" onClick={() => setStep(1)}>Next</button>
        </>
      )}
      {step === 1 && (
        <>
          <h2 className="food-title">Any food allergies?</h2>
          <p className="lead">Recipes with a matching ingredient will be flagged. You can change this, and add other foods to avoid, in Settings.</p>
          <div className="card">
            {MAJOR_ALLERGENS.map((a) => (
              <label key={a} className="check check--row">
                <input type="checkbox" checked={allergies.includes(a)} onChange={(e) => setAllergies(e.target.checked ? [...allergies, a] : allergies.filter((x) => x !== a))} />
                {ALLERGEN_LABEL[a]}
              </label>
            ))}
          </div>
          <button className="primary-action" onClick={() => setStep(2)}>{allergies.length === 0 ? "No allergies, next" : "Next"}</button>
        </>
      )}
      {step === 2 && needsPlan && (
        <>
          <h2 className="food-title">Your meal plan</h2>
          <p className="lead">What each container should give you. Recipes are scaled to this. You can add more plans, like a higher-calorie one, in Settings.</p>
          <div className="card card--form" data-testid="first-plan">
            <Field label="Calories per meal"><NumberInput label="Calories per meal" value={kcal} onChange={setKcal} /></Field>
            <Field label="Protein per meal, at least (g)"><NumberInput label="Protein per meal" value={protein} onChange={setProtein} /></Field>
            <Field label="Carbs per meal, at least (g)" hint="About 45 g is 1 cup of cooked white rice. Leave empty for no minimum."><NumberInput label="Carbs per meal" value={carbs} onChange={setCarbs} /></Field>
            <Field label="Meals per batch"><NumberInput label="Meals per batch" inputMode="numeric" value={meals} onChange={setMeals} /></Field>
          </div>
          {!planOk && <p className="warning">Check the numbers: protein and carbs can't add up to more calories than the meal has.</p>}
          <button className="primary-action" disabled={!planOk} onClick={() => void finish()}>Start using the app</button>
        </>
      )}
      {step === 2 && !needsPlan && (
        <>
          <h2 className="food-title">Your starting setup</h2>
          <Section title="Macro presets">
            {settings.presets.map((p) => <Row key={p.id} label={p.name} value={`${describePreset(p)}`} small />)}
          </Section>
          <Section title="Ingredient preferences">
            <div className="empty"><p className="empty__note">{settings.profile.preferences.map((p) => p.label).join(" · ")}</p></div>
          </Section>
          <p className="lead">All of these can be changed in Settings at any time.</p>
          <button className="primary-action" onClick={() => void finish()}>Start using the app</button>
        </>
      )}
    </div>
  );
}

function SettingsScreen(): ReactElement {
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const refresh = useCallback(() => {
    void getStorageStatus().then(setStorage);
  }, []);
  useEffect(refresh, [refresh]);

  const protect = async () => {
    await requestPersistentStorage();
    refresh();
  };

  const persistedLabel =
    storage?.persisted === true ? "Protected" : storage?.persisted === false ? "Not yet" : "Unknown";

  return (
    <>
      <SettingsMenu />
      <Section title="This device">
        <Row label="Opened from" value={isStandalone() ? "Home Screen" : "Browser tab"} testId="opened-from" />
        <Row label="Storage protection" value={persistedLabel} testId="storage-protection" />
        <Row label="Storage used" value={formatBytes(storage?.usageBytes ?? null)} />
        {storage?.persisted !== true && (
          <button className="row-button" onClick={() => void protect()}>
            Protect my data from cleanup
          </button>
        )}
      </Section>
      <NutritionDataSection />
      <Section title="About">
        <Row label="App version" value={__APP_VERSION__} />
        <Row label="Engine version" value={ENGINE_VERSION} />
        <Row label="Build" value={__BUILD_ID__} small />
        <Row label="Built" value={new Date(__BUILT_AT__).toLocaleString()} />
      </Section>
    </>
  );
}

function NutritionDataSection(): ReactElement {
  const [info, setInfo] = useState<{ size: number; version: string; releases: { foundation: string; srLegacy: string }; citation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadFoodDb().then(
      (db) => setInfo({ size: db.size, version: db.version, releases: db.releases, citation: db.citation }),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  return (
    <Section title="Nutrition data">
      {error && <Row label="Status" value={`Not loaded: ${error}`} />}
      {!error && !info && <Row label="Status" value="Loading…" />}
      {info && (
        <>
          <Row label="Source" value="USDA FoodData Central" />
          <Row label="Foods" value={info.size.toLocaleString()} testId="food-count" />
          <Row label="Foundation Foods" value={info.releases.foundation} />
          <Row label="SR Legacy" value={info.releases.srLegacy} />
          <Row label="Data version" value={info.version} small />
          <a className="row-button" href="#/foods">Look up a food</a>
          <div className="empty">
            <p className="empty__note">Source: {info.citation} Public domain (CC0).</p>
          </div>
        </>
      )}
    </Section>
  );
}

