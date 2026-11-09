export type { BeuserSurface, BeuserSurfaceOptions, BeuserRealmChannel, RealmDriverIO, SurfaceBounds } from './internal/pty.js';
// The terminal half evaluates @xterm/headless; only a walk loads it, so a process that imports the adapters barrel stays off it (KG9 F2).
export function loadBeuserTerminal(): Promise<typeof import('./internal/pty.js')> { return import('./internal/pty.js'); }
export type { ScreenSize, RenderedScreen } from './internal/screen.js';
export { BeuserSurfaceError, type SurfaceFailure } from './internal/input.js';
export { pinBeuserDriverBoot, type BeuserDriverBoot } from './internal/boot.js';
export type { SurfaceCommand } from './internal/argv.js';
export type { HarnessEvent, HarnessSink, HarnessAction, HarnessProcess } from './internal/capture.js';
export { beuserTerminalFixture, beuserTerminalFixtureSchema, type BeuserTerminalFixture, type CellRun } from './internal/measurement.js';
