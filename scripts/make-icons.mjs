// Generates the app icons from an inline SVG. Run with `npm run icons`
// (needs the `sharp` package). The PNGs are committed, so builds don't need sharp.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const out = new URL("../public/icons/", import.meta.url);
await mkdir(out, { recursive: true });

// A meal-prep container: one large compartment and two small ones.
const icon = (inset) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2E7D4F"/>
  <g transform="translate(${inset} ${inset}) scale(${(512 - 2 * inset) / 512})">
    <rect x="96" y="136" width="320" height="240" rx="44" fill="#FFFFFF"/>
    <rect x="124" y="164" width="150" height="184" rx="22" fill="#2E7D4F" opacity="0.22"/>
    <rect x="290" y="164" width="98" height="84" rx="20" fill="#2E7D4F" opacity="0.22"/>
    <rect x="290" y="264" width="98" height="84" rx="20" fill="#2E7D4F" opacity="0.22"/>
  </g>
</svg>`;

const render = (svg, size, name) =>
  sharp(Buffer.from(svg)).resize(size, size).png().toFile(new URL(name, out).pathname);

await render(icon(0), 180, "apple-touch-icon.png");
await render(icon(0), 192, "icon-192.png");
await render(icon(0), 512, "icon-512.png");
await render(icon(56), 512, "icon-512-maskable.png");
console.log("Icons written to public/icons/");
