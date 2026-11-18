/**
 * Unit conversions for the nutrition engine.
 *
 * All internal calculations use grams (mass) or millilitres (volume).
 * Imperial units are converted with their exact legal definitions:
 *   1 lb  = 453.59237 g          (international pound, 1959)
 *   1 oz  = 1/16 lb = 28.349523125 g
 *   1 US cup = 236.5882365 mL     (8 US fl oz)
 *   1 US fl oz = 29.5735295625 mL
 *   1 US tbsp = 1/2 fl oz = 14.78676478125 mL
 *   1 US tsp = 1/3 tbsp = 4.92892159375 mL
 *
 * Volume-to-mass conversion depends on the food, so it is NOT done here; it
 * uses USDA portion weights or measured densities in a later module.
 */

export const GRAMS_PER_MASS_UNIT = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
} as const;

export const ML_PER_VOLUME_UNIT = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  fl_oz: 29.5735295625,
  cup: 236.5882365,
} as const;

export type MassUnit = keyof typeof GRAMS_PER_MASS_UNIT;
export type VolumeUnit = keyof typeof ML_PER_VOLUME_UNIT;

export class InvalidQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuantityError";
  }
}

function assertQuantity(amount: number, label: string): void {
  if (!Number.isFinite(amount)) {
    throw new InvalidQuantityError(`${label} must be a finite number, got ${amount}`);
  }
  if (amount < 0) {
    throw new InvalidQuantityError(`${label} must not be negative, got ${amount}`);
  }
}

export function isMassUnit(unit: string): unit is MassUnit {
  return Object.hasOwn(GRAMS_PER_MASS_UNIT, unit);
}

export function isVolumeUnit(unit: string): unit is VolumeUnit {
  return Object.hasOwn(ML_PER_VOLUME_UNIT, unit);
}

/** Converts a mass in the given unit to grams. */
export function massToGrams(amount: number, unit: MassUnit): number {
  assertQuantity(amount, "Mass");
  return amount * GRAMS_PER_MASS_UNIT[unit];
}

/** Converts grams to the given mass unit. */
export function gramsToMass(grams: number, unit: MassUnit): number {
  assertQuantity(grams, "Mass");
  return grams / GRAMS_PER_MASS_UNIT[unit];
}

/** Converts a volume in the given unit to millilitres. */
export function volumeToMl(amount: number, unit: VolumeUnit): number {
  assertQuantity(amount, "Volume");
  return amount * ML_PER_VOLUME_UNIT[unit];
}

/** Converts millilitres to the given volume unit. */
export function mlToVolume(ml: number, unit: VolumeUnit): number {
  assertQuantity(ml, "Volume");
  return ml / ML_PER_VOLUME_UNIT[unit];
}

/**
 * Rounds a value for display only. Returns a new number and never feeds back
 * into calculations; stored values keep full precision.
 */
export function roundForDisplay(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new InvalidQuantityError(`Rounding step must be a positive number, got ${step}`);
  }
  if (!Number.isFinite(value)) {
    throw new InvalidQuantityError(`Value must be a finite number, got ${value}`);
  }
  const rounded = Math.round(value / step) * step;
  // Remove floating-point noise such as 0.30000000000000004.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(rounded.toFixed(decimals));
}
