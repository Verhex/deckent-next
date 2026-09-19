import type { Readable } from 'node:stream';
import { readJsonInput } from './json-input.js';

export function readGraphInput(source: string, maxBytes: number, stdin?: Readable & { isTTY?: boolean }): Promise<unknown> {
  return readJsonInput(source, maxBytes, { limit: 'CLI_GRAPH_INPUT_LIMIT', invalid: 'CLI_GRAPH_INPUT_INVALID',
    tty: 'CLI_GRAPH_INPUT_TTY', unavailable: 'CLI_GRAPH_INPUT_UNAVAILABLE' }, stdin);
}
