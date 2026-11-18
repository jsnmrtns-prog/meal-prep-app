// Small shared building blocks for screens.
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { FoodDb, YieldDb } from "../engine/index.ts";
import { loadFoodDb, loadYields } from "./foodData.ts";

export function Section({ title, children, footnote, testId }: { title: string; children: ReactNode; footnote?: ReactNode; testId?: string }): ReactElement {
  return (
    <section className="section" data-testid={testId}>
      <h2 className="section__title">{title}</h2>
      <div className="card">{children}</div>
      {footnote && <p className="footnote">{footnote}</p>}
    </section>
  );
}

export function Empty({ children, milestone }: { children: ReactNode; milestone?: string }): ReactElement {
  return (
    <div className="empty">
      <p>{children}</p>
      {milestone && <p className="empty__note">Arrives in milestone {milestone}</p>}
    </div>
  );
}

export function Row({ label, value, small = false, testId }: { label: ReactNode; value: ReactNode; small?: boolean; testId?: string }): ReactElement {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className={`row__value ${small ? "row__value--small" : ""}`} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export function LinkRow({ href, label, value }: { href: string; label: ReactNode; value?: ReactNode }): ReactElement {
  return (
    <a className="row row--link" href={href}>
      <span className="row__label">{label}</span>
      <span className="row__value row__value--small">{value}</span>
      <span className="chevron" aria-hidden="true">›</span>
    </a>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return <a className="back-link" href={href}>‹ {children}</a>;
}

/** A labelled form field; the control goes in `children`. */
export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }): ReactElement {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}

/** Number input that keeps what you type until it's a valid number. */
export function NumberInput({ value, onChange, label, min, step = "any", inputMode = "decimal" }: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  min?: number;
  step?: string;
  inputMode?: "decimal" | "numeric";
}): ReactElement {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    const parsed = text.trim() === "" ? null : Number(text);
    if (parsed !== value) setText(value === null ? "" : String(value));
    // Only react to outside changes of `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="input"
      type="text"
      inputMode={inputMode}
      aria-label={label}
      value={text}
      min={min}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        if (t === "") onChange(null);
        else if (Number.isFinite(Number(t))) onChange(Number(t));
      }}
    />
  );
}

export interface Engine {
  db: FoodDb;
  yields: YieldDb;
}

/** USDA foods and yields, loaded once and shared. */
export function useEngine(): { engine: Engine | null; error: string | null } {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([loadFoodDb(), loadYields()])
      .then(([db, yields]) => setEngine({ db, yields }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return { engine, error };
}

export function go(hash: string): void {
  window.location.hash = hash;
  window.scrollTo(0, 0);
}
