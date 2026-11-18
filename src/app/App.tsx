import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { ENGINE_VERSION } from "../engine/index.ts";
import { HomeIcon, ImportIcon, RecipesIcon, SettingsIcon, ShoppingIcon } from "./icons.tsx";
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

function tabFromHash(): TabId {
  const id = window.location.hash.replace(/^#\/?/, "");
  return TABS.some((t) => t.id === id) ? (id as TabId) : "home";
}

export function App(): ReactElement {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    registerServiceWorker(() => setUpdateReady(true));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((id: TabId) => {
    window.location.hash = `/${id}`;
    window.scrollTo(0, 0);
  }, []);

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

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
          {current.title}
        </h1>
        {tab === "home" && <HomeScreen onNavigate={go} />}
        {tab === "import" && <ImportScreen />}
        {tab === "recipes" && <RecipesScreen />}
        {tab === "shopping" && <ShoppingScreen />}
        {tab === "settings" && <SettingsScreen />}
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
        <Empty milestone="M5">Your presets, such as 750 kcal · 75 g protein · 6 meals.</Empty>
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
      <p className="lead">Your ChatGPT or Claude app reads the recipe. This app does all the math.</p>
      <Section title="How import will work">
        <ol className="steps">
          <li>Tap the button below. The app copies a prompt and opens your AI app.</li>
          <li>Paste the prompt there and attach the recipe photo, PDF or text.</li>
          <li>Copy the AI's reply and paste it back here to review.</li>
        </ol>
      </Section>
      <button className="primary-action" disabled>
        Copy prompt and open AI app
      </button>
      <p className="footnote">Arrives in milestone M6. Manual entry arrives in M5.</p>
    </>
  );
}

function RecipesScreen(): ReactElement {
  return (
    <Section title="Library">
      <Empty milestone="M5">Saved recipes, categories, favorites and search.</Empty>
    </Section>
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
      <Section title="About">
        <Row label="App version" value={__APP_VERSION__} />
        <Row label="Engine version" value={ENGINE_VERSION} />
        <Row label="Build" value={__BUILD_ID__} small />
        <Row label="Built" value={new Date(__BUILT_AT__).toLocaleString()} />
      </Section>
    </>
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
