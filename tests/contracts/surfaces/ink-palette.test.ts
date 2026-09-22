import { describe, expect, it } from 'vitest';
import { resolveWorklinePalette } from '#surfaces/core/terminal/index.js';

describe('workline ink palette', () => {
  it('strips color on none tier', () => {
    const palette = resolveWorklinePalette('none');
    expect(palette.accent).toEqual({});
    expect(palette.user).toEqual({});
  });

  it('maps semantic roles on ansi16 tier', () => {
    const palette = resolveWorklinePalette('ansi16');
    expect(palette.user.color).toBe('green');
    expect(palette.assistant.color).toBe('blueBright');
    expect(palette.accent.color).toBe('cyan');
  });

  it('uses truecolor hex when tier admits it', () => {
    const palette = resolveWorklinePalette('truecolor');
    expect(palette.error.color).toBe('#FF6B5E');
  });
});
