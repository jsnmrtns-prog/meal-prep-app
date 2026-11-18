// Downloads the pinned USDA FoodData Central releases into data-raw/ and
// verifies each file's SHA-256 before unpacking. Run with `npm run usda:fetch`.
// Needs network access to fdc.nal.usda.gov and the `unzip` command.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const rawDir = join(root, "data-raw");
const sources = JSON.parse(await readFile(join(root, "scripts/usda-sources.json"), "utf8"));

await mkdir(rawDir, { recursive: true });

for (const [name, ds] of Object.entries(sources.datasets)) {
  const zipPath = join(rawDir, ds.file);
  let bytes = existsSync(zipPath) ? await readFile(zipPath) : null;
  if (!bytes || sha256(bytes) !== ds.sha256) {
    const url = sources.baseUrl + ds.file;
    console.log(`Downloading ${name}: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(zipPath, bytes);
  }
  const actual = sha256(bytes);
  if (actual !== ds.sha256) {
    throw new Error(`Checksum mismatch for ${ds.file}\n  expected ${ds.sha256}\n  actual   ${actual}`);
  }
  execFileSync("unzip", ["-qo", zipPath, "-d", join(rawDir, name)]);
  console.log(`ok ${name} ${ds.release} (sha256 verified)`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
