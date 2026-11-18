// Tab bar icons: simple 24×24 line drawings using currentColor.
import type { ReactElement } from "react";

const base = {
  width: 26,
  height: 26,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const HomeIcon = (): ReactElement => (
  <svg {...base}>
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />
  </svg>
);

export const ImportIcon = (): ReactElement => (
  <svg {...base}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

export const RecipesIcon = (): ReactElement => (
  <svg {...base}>
    <rect x="3.5" y="6" width="17" height="13" rx="3" />
    <path d="M12 6v13M12 12.5h8.5" />
  </svg>
);

export const ShoppingIcon = (): ReactElement => (
  <svg {...base}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11" />
    <circle cx="5" cy="18" r="1.2" />
  </svg>
);

export const SettingsIcon = (): ReactElement => (
  <svg {...base}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);
