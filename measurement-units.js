/**
 * MEASUREMENT UNITS — single source of truth for body-measurement units.
 *
 * The site stores and shows every measurement in INCHES. Records written
 * before the switch were centimetres and carry no unit marker, so:
 *   - anything saved from now on is stamped  unit: "in"
 *   - anything WITHOUT unit: "in" is treated as legacy centimetres and is
 *     converted to inches whenever it is displayed or pre-filled into a form
 *     (so an old cm value can never be re-saved as if it were inches).
 *
 * Keep this file free of Firebase / DOM dependencies (it is unit-tested in Node).
 */

export const MEASUREMENT_UNIT = "in";
export const MEASUREMENT_UNIT_LABEL = "in";
export const CM_PER_INCH = 2.54;

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Centimetres -> inches, rounded to 0.1 in. Returns null for missing/invalid input. */
export function cmToInches(cm) {
  const n = toNumber(cm);
  return n === null ? null : Math.round((n / CM_PER_INCH) * 10) / 10;
}

/** The unit a stored measurement container (blueprint / tailoringMetrics) was recorded in. */
export function unitOf(container) {
  return container && container.unit === MEASUREMENT_UNIT ? "in" : "cm";
}

/** A single stored value -> inches, honouring the unit it was stored in. */
export function toInches(value, unit) {
  const n = toNumber(value);
  if (n === null) return null;
  return unit === MEASUREMENT_UNIT ? n : cmToInches(n);
}

/** Converts every metric in { neck: 42, ... } to inches. Missing/invalid metrics become null. */
export function groupToInches(group, unit) {
  const out = {};
  for (const [key, value] of Object.entries(group || {})) {
    out[key] = toInches(value, unit);
  }
  return out;
}

/** "16.5 in", or "--" when there is no value. */
export function formatInches(value) {
  const n = toNumber(value);
  if (n === null) return "--";
  return `${Number(n.toFixed(2))} ${MEASUREMENT_UNIT_LABEL}`;
}

/** True when a stored container was recorded in cm AND actually holds at least one value. */
export function holdsLegacyCentimetres(container) {
  if (!container || unitOf(container) === MEASUREMENT_UNIT) return false;
  const groups = [container.upperBody, container.lowerBody];
  return groups.some((g) => g && Object.values(g).some((v) => toNumber(v) !== null));
}