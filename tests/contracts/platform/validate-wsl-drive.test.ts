import { expect, it } from 'vitest';
import { validatePath } from '#platform/core/validate/index.js';

const wsl = { WSL_DISTRO_NAME: 'Ubuntu' };
it('treats /mnt/c and /mnt/C as one root on WSL and keeps containment', () => {
  expect(validatePath('/mnt/c/proj', '/mnt/C/proj/src/a.ts', 'linux', wsl)).toBe('/mnt/c/proj/src/a.ts');
  expect(validatePath('/mnt/C/proj', 'src/a.ts', 'linux', wsl)).toBe('/mnt/c/proj/src/a.ts');
  expect(validatePath('/mnt/c/proj', '/mnt/C/proj/src/a.ts', 'wsl', {})).toBe('/mnt/c/proj/src/a.ts');
  // Only the drive letter folds: the rest stays case-sensitive, and escapes are still refused.
  expect(() => validatePath('/mnt/c/proj', '/mnt/C/Proj/a.ts', 'linux', wsl)).toThrow();
  expect(() => validatePath('/mnt/c/proj', '/mnt/D/proj/a.ts', 'linux', wsl)).toThrow();
  expect(() => validatePath('/mnt/c/proj', '/mnt/C/proj/../other', 'linux', wsl)).toThrow();
  expect(() => validatePath('/mnt/c/proj', '/mnt/cc/proj', 'linux', wsl)).toThrow();
});
it('keeps drive-letter case significant on plain Linux', () => {
  expect(() => validatePath('/mnt/c/proj', '/mnt/C/proj/a.ts', 'linux', {})).toThrow();
  expect(validatePath('/mnt/c/proj', '/mnt/c/proj/a.ts', 'linux', {})).toBe('/mnt/c/proj/a.ts');
});
