import { z } from 'zod';
import { persistedInteger, persistedString } from '#domain/index.js';

export const text = persistedString(z.string().min(1)).refine(value => !value.includes('\0'));
const argumentValue = z.string().refine(value => !value.includes('\0'));
export const args = z.array(argumentValue).readonly();
export const positive = persistedInteger().positive().max(Number.MAX_SAFE_INTEGER);
export const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
export const flag = z.string().regex(/^--[a-z][a-z-]*$/u);
export const hexDigest = z.string().regex(/^[a-f0-9]{64}$/u);
export const cliVersion = z.string().regex(/^\d+\.\d+\.\d+$/u);
