import { BeuserSurfaceError } from './input.js';

/** Exact tuples are taken from the validated command catalog, never a free-form command line. */
export interface SurfaceCommand { readonly commandId: string; readonly args: readonly string[] }
export function catalogCommand(command: SurfaceCommand, catalog: readonly SurfaceCommand[], maxBytes: number): SurfaceCommand {
  if (!command || typeof command.commandId !== 'string' || !Array.isArray(command.args)
    || command.args.some(arg => typeof arg !== 'string' || /[\p{Cc}\p{Cs}]/u.test(arg))
    || Buffer.byteLength(JSON.stringify(command)) > maxBytes
    || !catalog.some(row => row.commandId === command.commandId && JSON.stringify(row.args) === JSON.stringify(command.args))) {
    throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  }
  return { commandId: command.commandId, args: [...command.args] };
}
