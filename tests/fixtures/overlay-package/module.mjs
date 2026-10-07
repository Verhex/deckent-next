// A non-Core module (tier `custom`, namespace `overlay`): one target adapter and one operation, written against the public extension
// contract only. Its options schema is a hand-written Standard Schema v1 object, so the module depends on no schema library.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { CORE_API_VERSION, EffectTargetError } from 'deckent/extensions';

const optionsSchema = { '~standard': { version: 1, vendor: 'overlay-fixture', validate(value) {
  const ok = typeof value === 'object' && value !== null && Object.keys(value).every(key => key === 'kind' || key === 'directory')
    && typeof value.kind === 'string' && value.kind.length > 0 && typeof value.directory === 'string' && isAbsolute(value.directory);
  return ok ? { value: { kind: value.kind, directory: value.directory } } : { issues: [{ message: 'OVERLAY_OPTIONS_INVALID' }] };
} } };

/** A versioned record ledger in one JSON file: every applied idempotency key is kept, so a retry in another process finds its effect. */
class LedgerFileTarget {
  constructor(options) { this.kind = options.kind; this.file = join(options.directory, 'overlay-ledger.json'); }
  identity() { return `${this.kind}@overlay-ledger-file`; }
  async read() { try { return JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { records: {}, applied: {} }; throw error; } }
  async observe(target) { const version = (await this.read()).records[target.id]; return { version: version === undefined ? null : `"v${version}"` }; }
  async apply(request) {
    const state = await this.read(), current = state.records[request.target.id] ?? 0;
    if (request.expectedVersion !== null && request.expectedVersion !== `"v${current}"`) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
    state.records[request.target.id] = current + 1;
    const version = `"v${current + 1}"`; state.applied[request.idempotencyKey] = { version, input: request.input };
    await writeFile(`${this.file}.tmp`, JSON.stringify(state)); await rename(`${this.file}.tmp`, this.file);
    return { version };
  }
  async lookup(_target, key) { const entry = (await this.read()).applied[key]; return entry ? { status: 'applied', version: entry.version } : { status: 'absent' }; }
}

export const overlayModule = {
  manifest: { schemaVersion: 1, module: { id: 'overlay.ledger', version: '0.1.0', tier: 'custom', namespace: 'overlay' },
    requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } },
    provides: { targetAdapters: [{ adapterId: 'overlay.ledger-file', version: 1 }],
      operations: [{ schemaVersion: 1, operation: { id: 'overlay.post-entry', version: 1 }, targetKind: 'overlay-ledger', effectClass: 'write',
        approval: 'policy', precondition: 'none', compensation: null, inputMaxBytes: 4096 }] },
    signature: null },
  factories: { 'overlay.ledger-file': { optionsSchema, create: options => new LedgerFileTarget(options) } },
};
