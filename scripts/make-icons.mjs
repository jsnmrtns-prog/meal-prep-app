// Generates the app icons from an inline SVG. Run with `npm run icons`
// (needs the `sharp` package). The PNGs are committed, so builds don't need sharp.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const out = new URL("../public/icons/", import.meta.url);
await mkdir(out, { recursive: true });

// Macrosmith: a meal-prep container on a dark tile, its compartments in the
// app's green / orange / red, with a bold stripe across the top.
const icon = (inset) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3DDC6E"/><stop offset="0.58" stop-color="#FF8C42"/><stop offset="1" stop-color="#FF5C52"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#0A0C0B"/>
  <g transform="translate(${inset} ${inset}) scale(${(512 - 2 * inset) / 512})">
    <rect x="84" y="96" width="344" height="40" rx="20" fill="url(#g)"/>
    <rect x="84" y="160" width="344" height="256" rx="46" fill="#F4F6F5"/>
    <rect x="112" y="188" width="160" height="200" rx="26" fill="#FF5C52"/>
    <rect x="288" y="188" width="112" height="92" rx="22" fill="#FF8C42"/>
    <rect x="288" y="296" width="112" height="92" rx="22" fill="#3DDC6E"/>
  </g>
</svg>`;

const render = (svg, size, name) =>
  sharp(Buffer.from(svg)).resize(size, size).png().toFile(new URL(name, out).pathname);

await render(icon(0), 180, "apple-touch-icon.png");
await render(icon(0), 192, "icon-192.png");
await render(icon(0), 512, "icon-512.png");
await render(icon(56), 512, "icon-512-maskable.png");
console.log("Icons written to public/icons/");
