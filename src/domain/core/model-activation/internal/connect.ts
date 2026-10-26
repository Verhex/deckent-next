import { z } from 'zod';
import { clientCommandIdSchema, identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, modelReferenceSchema } from '#domain/core/provider-catalog/index.js';

/**
 * `models.connect` (T4-B, owner 2026-10-08 D2): one governed operation, one typed contract for the CLI (`deckent models connect`), the SDK
 * (`connectModel`), MCP (`connect_model`) and the terminal (`/provider` → model). From a connection kind of the provider-connect registry and a
 * model it declares the model (packaged catalog seed, exact vendor ids), writes the scope's invocation profile (endpoint preset, the connection's
 * secret NAME as `credentialRef`, published tariff where the adapter carries one, limits, binding digest) and activates it — every write on its
 * existing governed path (config writer with policy and approval, ledger catalog register, chat activation), each with its own decision and
 * audit, plus one `model-connect` audit record. The command/result never carries a key value; seedless discovery resolves the stored key only
 * behind the configured HTTPS reader, before these writes.
 */
export const MODEL_CONNECT_OPERATION_ID = 'models.connect';
export const MODEL_CONNECT_SCHEMA_VERSION = 1;
/** Leaves room for the derived step ids (`<commandId>.profile.global` …) inside the identity bound. */
const commandIdSchema = clientCommandIdSchema.refine(value => value.length <= 192);
const absolutePath = z.string().min(2).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'));
export const modelConnectCommandSchema = z.object({
  schemaVersion: z.literal(MODEL_CONNECT_SCHEMA_VERSION),
  commandId: commandIdSchema,
  scopeId: identitySchema,
  /** The registry kind id (`anthropic-api`, `openai-compatible`, …): data, never a free vendor name. */
  connection: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  /** The address, only where the kind takes one (a chosen list row or a validated new address); null = the kind's own. */
  endpoint: z.string().min(1).max(2048).nullable().default(null),
  /** An exact API id from the kind's seed or freshly read endpoint list, or a previously declared exact catalog reference. */
  model: z.union([z.object({ nativeId: exactModelIdSchema }).strict(), z.object({ reference: modelReferenceSchema }).strict(), z.object({ pull: z.literal('available') }).strict()]),
  workspaceId: z.string().regex(/^wrkspc_[A-Za-z0-9]{1,120}$/u).optional(),
  /** S3-3, a CLI kind only (additive): the absolute executable and login directory (absent: the first in PATH; s3c the Brain's own login dir). */
  cli: z.object({ executable: absolutePath.optional(), configDir: absolutePath.optional() }).strict().readonly().optional(),
  /** S3-3 delegated-use consent (owner Q-H3), written only by the person: who besides them may spend the login. Absent keeps it; [] withdraws it. */
  delegate: z.array(z.enum(['ai', 'system'])).max(2).readonly().optional(),
}).strict().readonly();
export type ModelConnectCommand = z.infer<typeof modelConnectCommandSchema>;

export type ModelConnectStepState = 'written' | 'present' | 'skipped';
export type ModelConnectResult = Readonly<{
  schemaVersion: 1; operation: typeof MODEL_CONNECT_OPERATION_ID; commandId: string; scopeId: string; connection: string;
  status: 'connected' | 'approval-pending';
  reference: z.infer<typeof modelReferenceSchema>;
  models?: readonly Readonly<{ nativeId: string; reference?: z.infer<typeof modelReferenceSchema>; state: 'connected' | 'unpriced' | 'notOnKey' | 'notInCatalog'; code?: string }>[];
  /** The secret NAME the profile reads (`credentialRef`), never a value; null = no key is sent (a keyless or plain-http local server). */
  credentialRef: string | null;
  /** Whether that name is in the secret store now (null: the store was not listed). */
  keyStored: boolean | null;
  steps: Readonly<{ catalog: ModelConnectStepState; declaration: ModelConnectStepState; profile: ModelConnectStepState; activation: ModelConnectStepState;
    /** Models of this scope whose activation was carried to the new catalog revision (their bindings unchanged). */
    carried: number }>;
  /** Models of this scope that were active under the replaced catalog revision and could NOT be carried (with the typed reason): they need a
   * fresh activation (`deckent models activate`); every other step still completed. */
  notCarried: readonly Readonly<{ reference: z.infer<typeof modelReferenceSchema>; code: string }>[];
  /** K5 (owner 2026-10-08, Jev e3dcf2eb): the models whose activation was carried (`steps.carried` of them), shown in the result window. */
  carriedModels: readonly z.infer<typeof modelReferenceSchema>[];
  /** `published`: the profile carries the vendor's published tariff; `unmetered`: the adapter takes only a zero-rate tariff, spend is not metered. */
  tariff: 'published' | 'unmetered';
  /** İ-12 (owner 2026-10-25), a connected `published` model only (additive): whether the scope has a budget for its priced turns — `present`, `missing`
   * (Budget: 0 USD; priced turns stay refused until the person sets one) or `unknown` (not readable for this caller, with the typed code). */
  budget?: Readonly<{ state: 'present' | 'missing' | 'unknown'; code?: string }>;
  /** S3-3, a CLI kind only: the connected login directory (s3c `owned`: the Brain's own) and who besides the person may spend it (empty: nobody). */
  cli?: Readonly<{ configDir: string; owned?: boolean; delegate: readonly ('ai' | 'system')[] }>;
  /** The pending approval that stopped the run (the same command continues after it is allowed). */
  approval: Readonly<{ approvalId: string; keyPath: string; layer: 'project' | 'global' }> | null;
  /** The running service against the configuration on disk (restart-apply sections): `stale` = restart to apply; null = not asked. */
  service: 'current' | 'stale' | 'unknown' | 'stopped' | null;
}>;
