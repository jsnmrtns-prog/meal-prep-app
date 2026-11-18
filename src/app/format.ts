// Display-only formatting. Rounds for reading; never feeds back into calculations.
const OZ = 28.349523125;
const LB = 453.59237;

/** Imperial weight for shopping and portions: "1 lb 9.0 oz", "11.6 oz", "0.2 oz". */
export function imperial(grams: number): string {
  if (grams >= LB) {
    const lb = Math.floor(grams / LB);
    const oz = Math.round(((grams - lb * LB) / OZ) * 10) / 10;
    return oz >= 16 ? `${lb + 1} lb` : oz === 0 ? `${lb} lb` : `${lb} lb ${oz.toFixed(1)} oz`;
  }
  const oz = grams / OZ;
  return `${oz < 10 ? (Math.round(oz * 10) / 10).toFixed(1) : Math.round(oz * 10) / 10} oz`;
}

export function grams(g: number): string {
  return g >= 100 ? `${Math.round(g)} g` : `${Math.round(g * 10) / 10} g`;
}

/** Both, imperial first: "11.6 oz (330 g)". */
export function weight(g: number): string {
  return `${imperial(g)} (${grams(g)})`;
}
