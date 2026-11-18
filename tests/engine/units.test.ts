import { test } from "node:test";
import assert from "node:assert/strict";
import {
  massToGrams,
  gramsToMass,
  volumeToMl,
  mlToVolume,
  roundForDisplay,
  isMassUnit,
  isVolumeUnit,
  InvalidQuantityError,
} from "../../src/engine/units.ts";

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  );

test("pound and ounce use exact legal definitions", () => {
  assert.equal(massToGrams(1, "lb"), 453.59237);
  assert.equal(massToGrams(1, "oz"), 28.349523125);
  close(massToGrams(16, "oz"), massToGrams(1, "lb"));
  assert.equal(massToGrams(2.5, "kg"), 2500);
});

test("US kitchen volumes are consistent with each other", () => {
  close(volumeToMl(3, "tsp"), volumeToMl(1, "tbsp"));
  close(volumeToMl(16, "tbsp"), volumeToMl(1, "cup"));
  close(volumeToMl(8, "fl_oz"), volumeToMl(1, "cup"));
  close(volumeToMl(2, "tbsp"), volumeToMl(1, "fl_oz"));
});

test("conversions round-trip without drift", () => {
  for (const unit of ["g", "kg", "oz", "lb"] as const) {
    close(gramsToMass(massToGrams(3.7, unit), unit), 3.7);
  }
  for (const unit of ["ml", "l", "tsp", "tbsp", "fl_oz", "cup"] as const) {
    close(mlToVolume(volumeToMl(1.25, unit), unit), 1.25);
  }
});

test("zero is allowed; negative and non-finite quantities are rejected", () => {
  assert.equal(massToGrams(0, "lb"), 0);
  assert.throws(() => massToGrams(-1, "g"), InvalidQuantityError);
  assert.throws(() => volumeToMl(Number.NaN, "cup"), InvalidQuantityError);
  assert.throws(() => massToGrams(Number.POSITIVE_INFINITY, "oz"), InvalidQuantityError);
});

test("unit guards recognise only supported units", () => {
  assert.ok(isMassUnit("lb"));
  assert.ok(!isMassUnit("cup"));
  assert.ok(isVolumeUnit("tbsp"));
  assert.ok(!isVolumeUnit("toString"));
});

test("display rounding is clean and never changes the stored value", () => {
  const stored = massToGrams(1.37, "lb");
  const shown = roundForDisplay(gramsToMass(stored, "oz"), 0.1);
  assert.equal(shown, 21.9);
  assert.equal(stored, 1.37 * 453.59237);
  assert.equal(roundForDisplay(0.1 + 0.2, 0.1), 0.3);
  assert.equal(roundForDisplay(747.6, 1), 748);
  assert.throws(() => roundForDisplay(1, 0), InvalidQuantityError);
});
