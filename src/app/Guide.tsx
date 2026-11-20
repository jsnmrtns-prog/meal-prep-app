import type { ReactElement } from "react";

/** How to use the app, in five plain steps. Shown at the end of setup and under Settings. */
const STEPS: { title: string; text: string }[] = [
  { title: "Bring in a recipe", text: "On the Import tab, paste a recipe you copied (from a website, a post or a photo with Live Text) or open a PDF. You can also type one in." },
  { title: "Check it", text: "The app works out every ingredient on its own and only asks about the few it can't tell. Then tap Save recipe." },
  { title: "Scale it", text: "Open the recipe and pick your meal plan at the top. Every amount changes to hit your calories and protein, and the steps show the new amounts in bold." },
  { title: "Add it to your list", text: "Tap Add to shopping list on each recipe you're making. The Shopping tab adds them up into one list, sorted by store section." },
  { title: "Send it", text: "On the Shopping tab, tap Share recipe package to send the list and every recipe as one PDF to whoever shops and cooks." },
];

export function Guide(): ReactElement {
  return (
    <ol className="guide" data-testid="guide">
      {STEPS.map((s, i) => (
        <li key={s.title} className="guide__step">
          <span className="guide__num" aria-hidden="true">{i + 1}</span>
          <span><strong className="guide__title">{s.title}</strong><span className="guide__text">{s.text}</span></span>
        </li>
      ))}
    </ol>
  );
}

export function GuideScreen(): ReactElement {
  return (
    <>
      <p className="lead">Five steps from a recipe to meals in containers.</p>
      <div className="card"><Guide /></div>
      <p className="footnote">Your meal plans, allergies and package sizes are all in Settings.</p>
    </>
  );
}
