// Builds the static site into dist/: bundles the app, copies public/, and
// generates a service worker that precaches every file for offline use.
import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function commitId() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "local";
  }
}

const builtAt = new Date().toISOString();
const buildId = `${pkg.version}-${commitId()}-${builtAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "public"), dist, { recursive: true });

await build({
  entryPoints: { app: join(root, "src/app/main.tsx") },
  outdir: join(dist, "assets"),
  bundle: true,
  format: "esm",
  splitting: true, // pdf.js loads only when a PDF is opened
  chunkNames: "chunks/[name]-[hash]",
  target: ["safari17"],
  jsx: "automatic",
  minify: true,
  sourcemap: true,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILT_AT__: JSON.stringify(builtAt),
  },
  logLevel: "warning",
});

// pdf.js reads PDFs in a separate worker script.
await cp(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"), join(dist, "assets/pdf.worker.min.js"));

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return files.flat();
}

const precache = (await listFiles(dist))
  .map((f) => `./${relative(dist, f)}`)
  .filter((f) => !f.endsWith(".map"))
  .sort();
precache.unshift("./");

const swTemplate = await readFile(join(root, "src/app/sw.template.js"), "utf8");
await writeFile(
  join(dist, "sw.js"),
  swTemplate.replace("__BUILD_ID__", buildId).replace("__PRECACHE__", JSON.stringify(precache, null, 2)),
);

// GitHub Pages: skip Jekyll processing.
await writeFile(join(dist, ".nojekyll"), "");

const { size } = await stat(join(dist, "assets/app.js"));
console.log(`Built ${buildId} → dist/ (${precache.length} precached files, app.js ${(size / 1024).toFixed(1)} KB)`);
