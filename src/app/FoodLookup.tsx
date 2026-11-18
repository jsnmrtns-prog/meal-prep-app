import { useEffect, useMemo, useState, type ReactElement } from "react";
import { screenAllergens, type Food, type FoodDb, type EnergySource } from "../engine/index.ts";
import { loadFoodDb } from "./foodData.ts";

const ENERGY_LABEL: Record<EnergySource, string> = {
  usda_energy: "USDA energy value",
  atwater_specific: "USDA Atwater (specific factors)",
  atwater_general: "USDA Atwater (general factors)",
};

const ALLERGEN_LABEL: Record<string, string> = {
  milk: "Milk", egg: "Egg", fish: "Fish", crustacean_shellfish: "Shellfish (crustacean)",
  tree_nuts: "Tree nuts", peanuts: "Peanuts", wheat: "Wheat", soy: "Soy", sesame: "Sesame",
};

function useFoodDb(): { db: FoodDb | null; error: string | null } {
  const [db, setDb] = useState<FoodDb | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadFoodDb().then(setDb, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return { db, error };
}

// Shows USDA values exactly as published (no rounding).
const fmt = (v: number | null, unit: string) => (v === null ? "—" : `${v} ${unit}`);

export function FoodSearchScreen(): ReactElement {
  const { db, error } = useFoodDb();
  const [query, setQuery] = useState("");
  const results = useMemo(() => (db && query.trim().length >= 2 ? db.search(query, 30) : []), [db, query]);

  if (error) return <p className="lead">Couldn't load the food database: {error}</p>;
  return (
    <>
      <a className="back-link" href="#/settings">‹ Settings</a>
      <input
        className="search-field"
        type="search"
        inputMode="search"
        placeholder={db ? `Search ${db.size.toLocaleString()} USDA foods` : "Loading foods…"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={!db}
        aria-label="Search foods"
        autoFocus
      />
      {query.trim().length >= 2 && results.length === 0 && db && <p className="lead">No foods match.</p>}
      {results.length > 0 && (
        <div className="card">
          {results.map((f) => (
            <a key={f.fdcId} className="food-row" href={`#/foods/${f.fdcId}`}>
              <span className="food-row__name">{f.description}</span>
              <span className="food-row__meta">
                {f.usableForMacros
                  ? `${f.per100g.kcal} kcal · P ${f.per100g.protein} · C ${f.per100g.carbs} · F ${f.per100g.fat} per 100 g`
                  : "Incomplete USDA record (no calories); not usable in recipes"}
                {" · "}
                {f.dataset === "foundation" ? "Foundation" : "SR Legacy"}
              </span>
            </a>
          ))}
        </div>
      )}
      <p className="footnote">Values are per 100 g, exactly as USDA publishes them. "—" means USDA didn't report it.</p>
    </>
  );
}

export function FoodDetailScreen({ fdcId }: { fdcId: number }): ReactElement {
  const { db, error } = useFoodDb();
  if (error) return <p className="lead">Couldn't load the food database: {error}</p>;
  if (!db) return <p className="lead">Loading…</p>;
  if (!db.has(fdcId)) return <p className="lead">Food {fdcId} isn't in this database.</p>;
  return <FoodDetail food={db.get(fdcId)} />;
}

function FoodDetail({ food }: { food: Food }): ReactElement {
  const n = food.per100g;
  const allergens = screenAllergens(food);
  return (
    <>
      <a className="back-link" href="#/foods">‹ Food lookup</a>
      <h2 className="food-title">{food.description}</h2>
      <p className="lead">
        {food.dataset === "foundation" ? "USDA Foundation Foods" : "USDA SR Legacy"} · FDC ID {food.fdcId} · {food.category}
      </p>
      {!food.usableForMacros && (
        <p className="warning">This USDA record is incomplete (missing calories or a macro), so recipes can't use it.</p>
      )}
      <section className="section">
        <h3 className="section__title">Per 100 g</h3>
        <div className="card">
          <Row label="Calories" value={fmt(n.kcal, "kcal")} />
          <Row label="Protein" value={fmt(n.protein, "g")} />
          <Row label="Carbohydrates" value={fmt(n.carbs, "g")} />
          <Row label="Fat" value={fmt(n.fat, "g")} />
          <Row label="Fiber" value={fmt(n.fiber, "g")} />
          <Row label="Sugars" value={fmt(n.sugars, "g")} />
          <Row label="Saturated fat" value={fmt(n.satFat, "g")} />
          <Row label="Sodium" value={fmt(n.sodium, "mg")} />
          <Row label="Water" value={fmt(n.water, "g")} />
          <Row label="Calorie source" value={food.energySource ? ENERGY_LABEL[food.energySource] : "Not reported"} />
        </div>
      </section>
      {food.portions.length > 0 && (
        <section className="section">
          <h3 className="section__title">USDA portion weights</h3>
          <div className="card">
            {food.portions.map((p, i) => (
              <Row key={i} label={`${Number(p.amount.toFixed(3))} ${p.label || p.unit || "portion"}`} value={`${p.grams} g`} />
            ))}
          </div>
        </section>
      )}
      <section className="section">
        <h3 className="section__title">Allergen screen</h3>
        <div className="card">
          <div className="empty">
            <p>
              {allergens.allergens.length > 0
                ? allergens.allergens.map((a) => ALLERGEN_LABEL[a] ?? a).join(", ")
                : "None of the 9 major allergens detected in the USDA description."}
            </p>
            <p className="empty__note">
              {allergens.needsLabelCheck ? "Ingredients vary by product: check the label. " : ""}
              Based on the food's name and category, not lab data. Always confirm on the package.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className="row__value">{value}</span>
    </div>
  );
}
