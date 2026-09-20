import { OpenRouterPricingError } from './error.js';

/** Exact nonnegative decimal rates. Bounds here limit hostile arithmetic inputs, not product prices. */
export interface DecimalRate { readonly coefficient: bigint; readonly scale: number }
export function decimalRate(input: unknown): DecimalRate {
  if (typeof input !== 'string' || input.length > 128) throw new OpenRouterPricingError('INVALID_METADATA');
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(input);
  if (!match) throw new OpenRouterPricingError('INVALID_METADATA');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 128) throw new OpenRouterPricingError('INVALID_METADATA');
  let coefficient = BigInt(match[1]! + fraction), scale = fraction.length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  return Object.freeze({ coefficient, scale });
}

export function multiplyRate(rate: DecimalRate, count: number): DecimalRate {
  if (!Number.isSafeInteger(count) || count < 0) throw new OpenRouterPricingError('INVALID_REQUEST');
  return { coefficient: rate.coefficient * BigInt(count), scale: rate.scale };
}
export function decimalText(rate: DecimalRate): string {
  if (rate.scale === 0) return rate.coefficient.toString();
  const digits = rate.coefficient.toString().padStart(rate.scale + 1, '0');
  const text = `${digits.slice(0, -rate.scale)}.${digits.slice(-rate.scale)}`;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}
/** Round a single supported charge dimension upwards to USD cents, without floating point money. */
export function ceilUsdCents(rate: DecimalRate): number {
  const denominator = 10n ** BigInt(rate.scale), numerator = rate.coefficient * 100n;
  const cents = (numerator + denominator - 1n) / denominator;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new OpenRouterPricingError('AMOUNT_OVERFLOW');
  return Number(cents);
}

/** Local per-dimension envelope, not an assertion about external invoice rounding or line splitting. */
export function sumCeilUsdCents(dimensions: readonly DecimalRate[]): number {
  const cents = dimensions.reduce((sum, dimension) => sum + BigInt(ceilUsdCents(dimension)), 0n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new OpenRouterPricingError('AMOUNT_OVERFLOW');
  return Number(cents);
}
