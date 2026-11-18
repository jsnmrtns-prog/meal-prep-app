// Values injected by scripts/build.mjs at build time.
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __BUILT_AT__: string;

// CSS files are bundled by esbuild; importing one has no value.
declare module "*.css";

interface Navigator {
  /** Safari-only: true when launched from the Home Screen. */
  readonly standalone?: boolean;
}
