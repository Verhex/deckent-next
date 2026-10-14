import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../src/', import.meta.url);
registerHooks({ resolve(specifier, context, next) {
  if (/^#(?:platform|domain|capabilities|engine|adapters|surfaces|composition)\//u.test(specifier)) return next(new URL(specifier.slice(1).replace(/\.js$/, '.ts'), root).href, context);
  try { return next(specifier, context); } catch (error) {
    if (specifier.endsWith('.js') && context.parentURL) {
      const target = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(target))) return next(target.href, context);
    }
    throw error;
  }
} });
