import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { BeuserScreenRenderer } from '#adapters/core/beuser-surface/index.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const renderer = (columns = 20, rows = 4) => new BeuserScreenRenderer({ columns, rows, scrollback: 8 }, 20000);

it('the emitted screen code loads in real Node ESM with the exact CommonJS dependency artifacts', async () => {
  const require = createRequire(import.meta.url);
  const compile = async (name: string) => ts.transpileModule(await readFile(new URL(`../../../src/adapters/core/beuser-surface/internal/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const input = 'data:text/javascript;base64,' + Buffer.from(await compile('input')).toString('base64');
  const screen = (await compile('screen')).replace(/from '(@xterm\/[^']+)'/gu, (_match, spec: string) => `from ${JSON.stringify(pathToFileURL(require.resolve(spec)).href)}`)
    .replace("from './input.js'", `from ${JSON.stringify(input)}`);
  const script = screen + `\nconst screen = new BeuserScreenRenderer({columns:20,rows:4,scrollback:8},20000);
    await screen.write(new TextEncoder().encode('Ready'));
    if(screen.snapshot().text !== 'Ready') throw new Error('SCREEN_MISMATCH');
    screen.dispose(); console.log('Ready');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: {}, timeout: 5000, maxBuffer: 2000 });
  expect(result.stdout.trim()).toBe('Ready');
});

it('uses the active visible viewport, preserves real duplicates and erases stale titles', async () => {
  const screen = renderer();
  try {
    await screen.write(bytes('Approval\r\nApproval\r\nDone'));
    expect(screen.snapshot().text).toBe('Approval\nApproval\nDone');
    await screen.write(bytes('\x1b[2J\x1b[HReady'));
    expect(screen.snapshot().text).toBe('Ready');
    await screen.write(bytes('\r\n1\r\n2\r\n3\r\n4'));
    expect(screen.snapshot().text).toBe('1\n2\n3\n4');
    expect(screen.snapshot().scrollback).toBe('Ready');
    expect(screen.snapshot().main).toBe('Ready\n1\n2\n3\n4');
  } finally { screen.dispose(); }
});

it('restores the main screen after alternate-buffer erasure, cursor movement and wrapping', async () => {
  const screen = renderer(6, 3);
  try {
    await screen.write(bytes('Main\x1b[?1049h\x1b[H1234567'));
    expect(screen.snapshot()).toMatchObject({ text: '123456\n7', main: 'Main', alternate: true, caret: { x: 1, y: 1 } });
    await screen.write(bytes('\x1b[1;1H\x1b[2KAlt\x1b[2;1H\x1b[K'));
    expect(screen.snapshot().text).toBe('Alt');
    await screen.write(bytes('\x1b[?1049l'));
    expect(screen.snapshot()).toMatchObject({ text: 'Main', alternate: false });
  } finally { screen.dispose(); }
});

it('joins split UTF-8 and escape sequences and renders narrow TR/EN with combining and wide cells', async () => {
  const screen = renderer(8, 4);
  try {
    const output = bytes('\x1b[2J\x1b[Hİzin\r\nSave界e\u0301');
    for (const byte of output) await screen.write(Uint8Array.of(byte));
    expect(screen.snapshot()).toMatchObject({ text: 'İzin\nSave界é', caret: { x: 7, y: 1 } });
    await screen.write(bytes('\r\n1234567界'));
    expect(screen.snapshot().text).toBe('İzin\nSave界é\n1234567\n界');
    screen.finish();
  } finally { screen.dispose(); }
});

it('waits for rendering completion and never returns a partially parsed screen', async () => {
  const screen = renderer();
  try {
    const completion = screen.write(bytes('Ready'));
    expect(() => screen.snapshot()).toThrow('BEUSER_SURFACE_INVALID');
    await completion;
    expect(screen.snapshot().text).toBe('Ready');
  } finally { screen.dispose(); }
});

it('unknown VT poisons observation instead of silently stripping unsupported controls', async () => {
  const screen = renderer();
  try {
    await screen.write(bytes('Good'));
    await expect(screen.write(bytes('\x1b[999z'))).rejects.toThrow('BEUSER_SURFACE_INVALID');
    expect(() => screen.snapshot()).toThrow('BEUSER_SURFACE_INVALID');
  } finally { screen.dispose(); }
  const incomplete = renderer();
  try {
    await incomplete.write(bytes('\x1b['));
    expect(() => incomplete.finish()).toThrow('BEUSER_SURFACE_INVALID');
  } finally { incomplete.dispose(); }
  const halfCharacter = renderer();
  try {
    await halfCharacter.write(Uint8Array.of(0xc4));
    expect(() => halfCharacter.snapshot()).toThrow('BEUSER_SURFACE_INVALID');
    await halfCharacter.write(Uint8Array.of(0xb0));
    expect(halfCharacter.snapshot().text).toBe('İ');
  } finally { halfCharacter.dispose(); }
});

it('bounds screen allocation, scrollback, resize and raw writes', async () => {
  expect(() => new BeuserScreenRenderer({ columns: 1000, rows: 1000, scrollback: 1 }, 1000)).toThrow('BEUSER_SURFACE_LIMIT');
  const screen = renderer();
  try {
    await screen.write(bytes('Ready'));
    screen.resize(10, 5);
    expect(screen.snapshot()).toMatchObject({ columns: 10, rows: 5, text: 'Ready' });
    expect(() => screen.resize(100000, 1)).toThrow('BEUSER_SURFACE_LIMIT');
    await expect(screen.write(bytes('x'.repeat(20001)))).rejects.toThrow('BEUSER_SURFACE_LIMIT');
  } finally { screen.dispose(); }
});
