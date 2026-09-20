import { ProviderSpendError } from './error.js';

const FIXED = /^(?:0|[1-9]\d*)(?:\.(\d*[1-9]))?$/;
const NUMERIC = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_FRACTION_DIGITS = 256;
const MAX_NUMERIC_LENGTH = 1024;
const MAX_FIXED_LENGTH = String(Number.MAX_SAFE_INTEGER).length + 1 + MAX_FRACTION_DIGITS;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
interface Decimal { readonly coefficient: bigint; readonly scale: number }
function invalid(): never { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
function normalize(coefficient: bigint, scale: number): Decimal {
  if (coefficient < 0n || !Number.isSafeInteger(scale) || scale < 0 || scale > MAX_FRACTION_DIGITS) invalid();
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  const divisor = 10n ** BigInt(scale);
  const ceiling = coefficient / divisor + (coefficient % divisor === 0n ? 0n : 1n);
  if (ceiling > MAX_SAFE) invalid();
  return { coefficient, scale };
}
function fixed(decimal: Decimal): string {
  if (decimal.coefficient === 0n) return '0';
  const digits = decimal.coefficient.toString();
  if (decimal.scale === 0) return digits;
  const padded = digits.padStart(decimal.scale + 1, '0');
  return `${padded.slice(0, -decimal.scale)}.${padded.slice(-decimal.scale)}`;
}
function parseFixed(value: string): Decimal {
  if (value.length < 1 || value.length > MAX_FIXED_LENGTH) invalid();
  const match = FIXED.exec(value);
  if (!match) invalid();
  const fraction = match[1] ?? '';
  if (fraction.length > MAX_FRACTION_DIGITS) invalid();
  return normalize(BigInt(value.replace('.', '')), fraction.length);
}
export function providerSpendExactFromNumericSource(numericSource: string, minorUnitsPerCurrencyUnit: number): string {
  if (typeof numericSource !== 'string' || numericSource.length < 1 || numericSource.length > MAX_NUMERIC_LENGTH
    || !Number.isSafeInteger(minorUnitsPerCurrencyUnit) || minorUnitsPerCurrencyUnit <= 0) invalid();
  const match = NUMERIC.exec(numericSource);
  if (!match) invalid();
  const whole = match[1]!, fraction = match[2] ?? '', exponentText = match[3] ?? '0';
  if (fraction.length > MAX_FRACTION_DIGITS || exponentText.length > 4) invalid();
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_FRACTION_DIGITS) invalid();
  let coefficient = BigInt(`${whole}${fraction}`) * BigInt(minorUnitsPerCurrencyUnit);
  let scale = fraction.length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return fixed(normalize(coefficient, scale));
}
export function canonicalProviderSpendExactMinorUnits(input: unknown): string {
  if (typeof input !== 'string') invalid();
  const result = fixed(parseFixed(input));
  if (result !== input) invalid();
  return result;
}
export function addProviderSpendExactMinorUnits(leftInput: unknown, rightInput: unknown): string {
  if (typeof leftInput !== 'string' || typeof rightInput !== 'string') invalid();
  const left = parseFixed(leftInput), right = parseFixed(rightInput), scale = Math.max(left.scale, right.scale);
  return fixed(normalize(left.coefficient * 10n ** BigInt(scale - left.scale)
    + right.coefficient * 10n ** BigInt(scale - right.scale), scale));
}
export function ceilProviderSpendExactMinorUnits(input: unknown): number {
  if (typeof input !== 'string') invalid();
  const value = parseFixed(input), divisor = 10n ** BigInt(value.scale);
  const ceiling = value.coefficient / divisor + (value.coefficient % divisor === 0n ? 0n : 1n);
  if (ceiling > MAX_SAFE) invalid();
  return Number(ceiling);
}
