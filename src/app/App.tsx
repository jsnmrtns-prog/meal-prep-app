import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { DEFAULT_PRESETS, ENGINE_VERSION, describePreset } from "../engine/index.ts";
import { HomeIcon, ImportIcon, RecipesIcon, SettingsIcon, ShoppingIcon } from "./icons.tsx";
import { FoodDetailScreen, FoodSearchScreen } from "./FoodLookup.tsx";
import { loadFoodDb } from "./foodData.ts";
import { RecipeReportScreen, SampleRecipeList } from "./RecipeReport.tsx";
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
  { id: "shopping", label: "Shopping", title: "Shopping Lists", Icon: ShoppingIcon },
  { id: "settings", label: "Settings", title: "Settings", Icon: SettingsIcon },
];

type Route =
  | { tab: TabId; screen: "tab" }
  | { tab: "recipes"; screen: "recipe"; recipeId: string; presetId: string | null }
  | { tab: "settings"; screen: "foods" }
  | { tab: "settings"; screen: "food"; fdcId: number };

function routeFromHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "foods") {
    const id = Number(parts[1]);
    return parts[1] && Number.isInteger(id) ? { tab: "settings", screen: "food", fdcId: id } : { tab: "settings", screen: "foods" };
  }
  if (parts[0] === "recipes" && parts[1]) {
    return { tab: "recipes", screen: "recipe", recipeId: decodeURIComponent(parts[1]), presetId: parts[2] ? decodeURIComponent(parts[2]) : null };
  }
  const id = parts[0] ?? "";
  return { tab: TABS.some((t) => t.id === id) ? (id as TabId) : "home", screen: "tab" };
}

export function App(): ReactElement {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [updateReady, setUpdateReady] = useState(false);
  const tab = route.tab;

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    registerServiceWorker(() => setUpdateReady(true));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((id: TabId) => {
    window.location.hash = `/${id}`;
    window.scrollTo(0, 0);
  }, []);

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  const title =
    route.screen === "foods" ? "Food Lookup" : route.screen === "food" ? "Food Details" : route.screen === "recipe" ? "Nutrition Report" : current.title;

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
          {title}
        </h1>
        {route.screen === "foods" && <FoodSearchScreen />}
        {route.screen === "food" && <FoodDetailScreen fdcId={route.fdcId} />}
        {route.screen === "recipe" && <RecipeReportScreen key={`${route.recipeId}/${route.presetId ?? ""}`} id={route.recipeId} presetId={route.presetId} />}
        {route.screen === "tab" && tab === "home" && <HomeScreen onNavigate={go} />}
        {route.screen === "tab" && tab === "import" && <ImportScreen />}
        {route.screen === "tab" && tab === "recipes" && <RecipesScreen />}
        {route.screen === "tab" && tab === "shopping" && <ShoppingScreen />}
        {route.screen === "tab" && tab === "settings" && <SettingsScreen />}
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

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="section">
      <h2 className="section__title">{title}</h2>
      <div className="card">{children}</div>
    </section>
  );
}

function Empty({ children, milestone }: { children: ReactNode; milestone?: string }): ReactElement {
  return (
    <div className="empty">
      <p>{children}</p>
      {milestone && <p className="empty__note">Arrives in milestone {milestone}</p>}
    </div>
  );
}

function HomeScreen({ onNavigate }: { onNavigate: (id: TabId) => void }): ReactElement {
  return (
    <>
      <button className="primary-action" onClick={() => onNavigate("import")}>
        <ImportIcon />
        Import a recipe
      </button>
      <Section title="Recent recipes">
        <Empty milestone="M5">Recipes you save will show up here.</Empty>
      </Section>
      <Section title="Macro presets">
        {DEFAULT_PRESETS.map((p) => (
          <div key={p.id} className="row">
            <span className="row__label">{p.name}</span>
            <span className="row__value row__value--small">{describePreset(p)} · ±{p.kcalTolerancePct}%</span>
          </div>
        ))}
        <Empty milestone="M5">Creating and editing your own presets.</Empty>
      </Section>
      <Section title="Current shopping list">
        <Empty milestone="M7">Your latest shopping list will show up here.</Empty>
      </Section>
    </>
  );
}

function ImportScreen(): ReactElement {
  return (
    <>
      <p className="lead">The app reads recipes itself and does all the math. No AI app needed.</p>
      <Section title="How import will work">
        <ol className="steps">
          <li>Paste the recipe text (copy it from a photo with Live Text, a website or notes), or open a PDF.</li>
          <li>The app splits out each amount and ingredient and flags anything unclear.</li>
          <li>You review it, confirm the USDA food for each ingredient, and save.</li>
        </ol>
      </Section>
      <button className="primary-action" disabled>
        Paste or open a recipe
      </button>
      <p className="footnote">Optional shortcut: have ChatGPT or Claude format a recipe, then paste the result here.</p>
      <p className="footnote">Arrives in milestone M6. Manual entry arrives in M5.</p>
    </>
  );
}

function RecipesScreen(): ReactElement {
  return (
    <>
      <SampleRecipeList />
      <Section title="Library">
        <Empty milestone="M5">Saved recipes, categories, favorites and search.</Empty>
      </Section>
    </>
  );
}

function ShoppingScreen(): ReactElement {
  return (
    <Section title="Lists">
      <Empty milestone="M7">Shopping lists built from one or more saved recipes.</Empty>
    </Section>
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
      <Section title="Profile">
        <Empty milestone="M5">Allergies, ingredient preferences, macro presets, units and stores.</Empty>
      </Section>
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

function Row({
  label,
  value,
  small = false,
  testId,
}: {
  label: string;
  value: string;
  small?: boolean;
  testId?: string;
}): ReactElement {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className={`row__value ${small ? "row__value--small" : ""}`} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
