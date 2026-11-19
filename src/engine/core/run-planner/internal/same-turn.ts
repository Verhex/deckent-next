import { isDeepStrictEqual } from 'node:util';
import { parseModelInvocationCommand, parseModelInvocationReceipt, modelInvocationRequestEvidence, brainPlanCommandInputSchema, type BrainPlanCommand,
  type ModelInvocationCommand, type ModelInvocationReceipt } from '#domain/index.js';
import { SAME_TURN_PLANNING_POLICY, SAME_TURN_CHALLENGE_PREFIX, brainPlannerConfigSchema, parseBrainDraft, prepareBrainPrompt,
  type NativeAgentToolResult, type SameTurnPlanningPort, type SameTurnPlanningPin, type SameTurnPlanningCall,
  type SameTurnPlanningCustody, type SameTurnPlanningEnvelope, type SameTurnPlanningFinish, type SameTurnPlanningRefusal } from '#capabilities/index.js';
import { ErrorRegistry, redactForRecord, combineKnownSecrets, knownSecretValues, EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot } from '#platform/index.js';
import { modelInvocationRequestDigest, modelInvocationResponseContentDescriptor, type ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import type { RunProposalResult, PlanningMemoryNote } from '#engine/core/run-proposal/index.js';
import type { BrainQuotaWaitPolicy } from './quota-wait.js';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface BrainPreparation { readonly invocation: ModelInvocationCommand; readonly prompt: ReturnType<typeof prepareBrainPrompt>; readonly kinds?: readonly string[];
  readonly unavailableKinds?: readonly import('#engine/core/toolchain-currency/index.js').WorkerKindAvailability[];
  /** S4B-6: the planning call's memory note for the card (response-only). */ readonly planningMemory?: PlanningMemoryNote;
  /** f3 (owner Q-H4): the configured quota wait bounds; absent: a quota refusal is the typed refusal at once. */ readonly quotaWait?: BrainQuotaWaitPolicy;
  /** D-02: corrective re-plans after a correctable validation refusal; absent or 0: none. */ readonly correctionRetries?: number;
  /** Owner 2026-11-06: the Brain model is below the recommended class (response-only note for the card). */ readonly brainBelowRecommended?: boolean }
type SameTurnBrainFinalizer = (command: BrainPlanCommand, prepared: BrainPreparation, invocation: ModelInvocationCommand,
  result: ModelInvocationResult, credential?: unknown, signal?: AbortSignal) => Promise<RunProposalResult>;

/** Authored origin is separate from the resolved Brain requirement. Terminal request policy is never cap application evidence. */
type Origin = 'person' | 'project' | 'company' | 'brain-default' | 'unknown';
export interface SameTurnBrainSettings {
  readonly cap: Readonly<{ value: number | null; origin: Origin }>;
  readonly reasoning: Readonly<{ value: 'model-default' | 'off'; origin: Origin }>;
  /** Evidence from this exact started call, never the request's max_completion_tokens field. */
  readonly applied: Readonly<{ invocationId: string; requestDigest: string; maxCompletionTokens: number | null;
    reasoningOff: boolean }> | null;
}
export interface SameTurnPlanningInput {
  readonly command: BrainPlanCommand;
  readonly prepared: BrainPreparation;
  readonly config: unknown;
  readonly settings: SameTurnBrainSettings;
  readonly call: SameTurnPlanningCall;
  /** Effective outer/Brain/bridge bounds supplied by the host; all framing bytes count. */
  readonly bounds: Readonly<{ preparationMaxBytes: number; draftMaxBytes: number }>;
}
export interface SameTurnPlanningPorts {
  randomBytes(size: number): Uint8Array;
  /** The existing configured-secret/bridge projection. Never put the challenge in its credential snapshot. */
  readonly projectDelivery?: (value: NativeAgentToolResult) => NativeAgentToolResult;
  toolResultDigest(content: string): string;
  /** Composition privately reads this turn's retained outer invocation under the content-read permission of the
   * person verified on this chat connection in the same installation and scope. Throw if the person, permission
   * or binding to the completed receipt cannot be verified. Never expose the body to the actor. */
  readResult(completedReceipt: ModelInvocationReceipt): Promise<ModelInvocationResult>;
  text(result: ModelInvocationResult): string | null;
  /** Re-read Brain model role, activation/binding/profile, model-use/delegation, policy and settings on this actual chat model.
   * Return the current preparation snapshot; any drift is refused. This port cannot invoke a model or admit a Run. */
  revalidate(input: SameTurnPlanningInput, receipt: ModelInvocationReceipt): Promise<SameTurnPlanningInput>;
  readonly knownSecrets?: KnownSecretSnapshot;
  /** K3 supplies a rendered TR/EN catalog status, never model text. */
  readonly publicText: string;
  readonly credential?: unknown;
}
const frozenCopy = <T>(value: T): T => {
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  const copied = structuredClone(value); freeze(copied); return copied;
};
const identity = (receipt: ModelInvocationReceipt) => ({ ...receipt, outcome: null });
const SAME_TURN_FRAMING_INSTRUCTION = 'For this same-turn preparation, copy the first line of this preparation result exactly at byte zero, then one LF and exactly one BrainDraft JSON object conforming to the supplied schema. Call no more tools and write no other text.';

/** One ephemeral claim, one preparation and one finalization owner. Restart deliberately loses this capability. */
export class SameTurnPlanningApplication implements SameTurnPlanningPort {
  private currentPin: SameTurnPlanningPin | null = null;
  private invocation: ModelInvocationCommand | null = null;
  private receipt: ModelInvocationReceipt | null = null;
  private sessionId: string | null = null;
  private input: SameTurnPlanningInput | null = null;
  private preparing: Promise<NativeAgentToolResult> | null = null;
  private preparationStarted = false;
  private result: NativeAgentToolResult | null = null;
  private custody: SameTurnPlanningCustody | null = null;
  private delivered = false;
  private terminal: SameTurnPlanningEnvelope | null = null;
  private normal = false;
  private failure: SameTurnPlanningRefusal | null = null;
  private finalizing: Promise<RunProposalResult> | null = null;
  private challenge: string | null = null;
  private privateKnown: KnownSecretSnapshot | undefined;
  private deliveryProjection: SameTurnPlanningPorts['projectDelivery'];
  private deliveryKnown: KnownSecretSnapshot;
  readonly #complete: SameTurnBrainFinalizer;
  constructor(complete: SameTurnBrainFinalizer, private readonly ports: SameTurnPlanningPorts) {
    this.#complete = complete;
    this.deliveryProjection = ports.projectDelivery; this.deliveryKnown = ports.knownSecrets ?? EMPTY_KNOWN_SECRETS;
  }
  get pin(): SameTurnPlanningPin | null { return this.currentPin; }
  /** Stays closed to publication through finalize/refusal, even after challenge custody has been erased. */
  get active() { return this.preparationStarted; }
  get normalClosed() { return this.normal && this.failure === null; }
  private refuse(reason: SameTurnPlanningRefusal): never {
    this.failure ??= reason; this.challenge = null; this.privateKnown = undefined;
    this.result = null; this.custody = null; this.terminal = null; this.preparing = null;
    throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason: this.failure } });
  }
  private check(pin: SameTurnPlanningPin) {
    if (pin !== this.currentPin || !this.receipt || this.failure) this.refuse(this.failure ?? 'stale-terminal');
  }
  /** Only the invocation runtime's post-permit callback may call this; register and receipt replay never do. */
  claimed(invocation: ModelInvocationCommand, receipt: ModelInvocationReceipt): SameTurnPlanningPin {
    if (this.currentPin) this.refuse('stale-terminal');
    const checked = parseModelInvocationCommand(invocation), kept = parseModelInvocationReceipt(receipt);
    if (kept.outcome !== null || !isDeepStrictEqual(kept.request, modelInvocationRequestEvidence(checked, modelInvocationRequestDigest(checked)))) this.refuse('stale-terminal');
    this.invocation = checked; this.receipt = kept;
    this.currentPin = Object.freeze({}) as SameTurnPlanningPin;
    return this.currentPin;
  }
  bindNativeSession(pin: SameTurnPlanningPin, sessionId: string): void {
    this.check(pin);
    if (!sessionId || this.sessionId !== null && this.sessionId !== sessionId) this.refuse('stale-terminal');
    this.sessionId = sessionId;
  }
  bindDeliveryProjection(pin: SameTurnPlanningPin, project: (result: NativeAgentToolResult) => NativeAgentToolResult, known: KnownSecretSnapshot): void {
    this.check(pin);
    if (this.active || this.deliveryProjection && this.deliveryProjection !== project) this.refuse('preparation-unsettled');
    this.deliveryProjection = project; this.deliveryKnown = combineKnownSecrets(this.deliveryKnown, known);
  }
  private settings(input: SameTurnPlanningInput) {
    const config = brainPlannerConfigSchema.parse(input.config), { cap, reasoning, applied } = input.settings;
    const origins: readonly string[] = ['person', 'project', 'company', 'brain-default'];
    if (!origins.includes(cap.origin) || !origins.includes(reasoning.origin) || cap.value !== config.maxCompletionTokens || reasoning.value !== config.reasoning)
      this.refuse('settings-mismatch');
    if (cap.value !== null || reasoning.value === 'off') {
      if (!applied || applied.invocationId !== this.receipt!.claim.invocationId || applied.requestDigest !== this.receipt!.request.requestDigest
        || cap.value !== null && applied.maxCompletionTokens !== cap.value || reasoning.value === 'off' && applied.reasoningOff !== true) this.refuse('settings-mismatch');
    }
  }
  prepare(pin: SameTurnPlanningPin, raw: SameTurnPlanningInput): Promise<NativeAgentToolResult> {
    // Keep rejected operations asynchronous, but return the EXACT same promise for an identical replay.
    try {
      this.check(pin);
      if (this.finalizing) this.refuse('stale-terminal');
      if (this.preparing) {
        if (!isDeepStrictEqual(raw, this.input)) this.refuse('stale-terminal');
        return this.preparing;
      }
      const input = frozenCopy(raw); this.input = input; this.preparationStarted = true;
      this.preparing = Promise.resolve().then(async () => {
        this.check(pin); this.settings(input);
        const command = brainPlanCommandInputSchema.parse(input.command), invocation = parseModelInvocationCommand(input.prepared.invocation);
        if (command.scopeId !== this.receipt!.request.scopeId || !isDeepStrictEqual(invocation, this.invocation)
          || !input.call.callId || !input.call.turnId || !Number.isSafeInteger(input.call.generation) || input.call.generation <= 0
          || !/^[a-f0-9]{64}$/u.test(input.call.argsDigest)
          || !Object.values(input.bounds).every(value => Number.isSafeInteger(value) && value > 0)) this.refuse('stale-terminal');
        const refreshed = await this.ports.revalidate(input, this.receipt!);
        this.check(pin);
        if (!isDeepStrictEqual(refreshed, input)) this.refuse('settings-mismatch');
        if (!this.deliveryProjection) this.refuse('preparation-unsettled');
        const bytes = this.ports.randomBytes(SAME_TURN_PLANNING_POLICY.challengeBytes);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SAME_TURN_PLANNING_POLICY.challengeBytes || SAME_TURN_PLANNING_POLICY.encoding !== 'hex') this.refuse('preparation-unsettled');
        this.challenge = Buffer.from(bytes).toString('hex');
        this.privateKnown = combineKnownSecrets(this.deliveryKnown, knownSecretValues([this.challenge]));
        const content = `${SAME_TURN_CHALLENGE_PREFIX}${this.challenge}\n${JSON.stringify(input.prepared.prompt.messages)}\n${SAME_TURN_FRAMING_INSTRUCTION}`;
        if (redactForRecord(content, this.deliveryKnown) !== content) this.refuse('preparation-unsettled');
        const rawResult: NativeAgentToolResult = frozenCopy({ schemaVersion: 1, turnId: input.call.turnId, generation: input.call.generation,
          deckentCallId: input.call.callId, outcome: { status: 'ok', text: content } });
        const requestBytes = Buffer.byteLength(JSON.stringify(this.invocation!.nativeRequest), 'utf8');
        const envelopeBytes = Buffer.byteLength(JSON.stringify(rawResult), 'utf8'), limits = brainPlannerConfigSchema.parse(input.config).context;
        if (envelopeBytes > input.bounds.preparationMaxBytes || requestBytes + envelopeBytes > Math.min(limits.requestMaxBytes, this.receipt!.profile.limits.requestMaxBytes)) this.refuse('output-truncated');
        const projected = this.deliveryProjection(rawResult);
        // Existing redaction always runs. A conflict closes the candidate; there is no whitelist, regeneration or retry.
        if (!isDeepStrictEqual(projected, rawResult) || redactForRecord(this.ports.publicText, this.privateKnown) !== this.ports.publicText) this.refuse('preparation-unsettled');
        this.result = frozenCopy(projected);
        return this.result;
      }).catch(error => {
        if (this.failure) throw error;
        return this.refuse('preparation-unsettled');
      });
      return this.preparing;
    } catch (error) { return Promise.reject(error); }
  }
  beforeTool(callId: string, argsDigest: string): void {
    if (!this.active) return;
    if (this.failure || !this.input || callId !== this.input.call.callId || argsDigest !== this.input.call.argsDigest || this.normal) this.refuse(this.failure ?? 'stale-terminal');
  }
  privateResult(callId: string, content: string) {
    if (!this.active) return null;
    if (this.failure || !this.input || callId !== this.input.call.callId || !this.result || content !== this.result.outcome.text) this.refuse(this.failure ?? 'preparation-unsettled');
    return Object.freeze({ content: this.result.outcome.text, publicText: this.ports.publicText, call: this.input.call });
  }
  preparationSettled(pin: SameTurnPlanningPin, custody: SameTurnPlanningCustody): void {
    this.check(pin);
    if (!this.input || !this.result) this.refuse('preparation-unsettled');
    const content = this.result.outcome.text;
    const expected = { ...this.input.call, content, bytes: Buffer.byteLength(content, 'utf8'), resultDigest: this.ports.toolResultDigest(content) };
    if (!isDeepStrictEqual(custody, expected) || this.custody && !isDeepStrictEqual(custody, this.custody)) this.refuse('preparation-unsettled');
    this.custody ??= frozenCopy(custody);
  }
  preparationDelivered(pin: SameTurnPlanningPin, observedEnvelope: NativeAgentToolResult): void {
    this.check(pin);
    if (!this.custody || !this.result || !isDeepStrictEqual(observedEnvelope, this.result)) this.refuse('preparation-unsettled');
    this.delivered = true;
  }
  terminalEnvelope(pin: SameTurnPlanningPin, envelope: SameTurnPlanningEnvelope): string {
    this.check(pin);
    const input = this.input;
    if (!input || !this.delivered || !this.challenge || this.terminal || !this.sessionId || envelope.sessionId !== this.sessionId
      || !envelope.messageId || envelope.parentId !== null || envelope.line !== `${SAME_TURN_CHALLENGE_PREFIX}${this.challenge}`
      || !isDeepStrictEqual({ turnId: envelope.turnId, generation: envelope.generation, callId: envelope.callId, argsDigest: envelope.argsDigest }, input.call)) this.refuse('stale-terminal');
    if (Buffer.byteLength(`${envelope.line}\n${envelope.draft}`, 'utf8') > Math.min(input.bounds.draftMaxBytes, this.receipt!.profile.limits.responseMaxBytes)) this.refuse('output-truncated');
    this.terminal = frozenCopy(envelope);
    return envelope.draft;
  }
  nativeClosed(pin: SameTurnPlanningPin, finish: SameTurnPlanningFinish): void {
    this.check(pin);
    if (finish.state !== 'normal' || !finish.closed || !finish.drained || !this.terminal) this.refuse(finish.state === 'length' ? 'output-truncated'
      : finish.state === 'cancelled' ? 'cancelled' : finish.state === 'failed' ? 'native-failed' : 'completion-unknown');
    // Normal completion is independently proved BEFORE parsing any Brain draft, even an apparently valid JSON body.
    try { parseBrainDraft(this.terminal.draft, this.privateKnown, { exact: true, requireCurrentGraph: true }); }
    catch { this.refuse('stale-terminal'); }
    this.normal = true;
  }
  responseBody(pin: SameTurnPlanningPin, projectedBody: string): string {
    this.check(pin);
    if (!this.normal || !this.terminal || projectedBody !== this.terminal.draft) this.refuse('completion-unknown');
    return projectedBody;
  }
  abandon(pin: SameTurnPlanningPin, reason: SameTurnPlanningRefusal): void {
    if (pin !== this.currentPin) this.refuse('stale-terminal');
    this.failure ??= reason; this.challenge = null; this.privateKnown = undefined;
    this.result = null; this.custody = null; this.terminal = null; this.preparing = null;
  }
  /** This is the ONE finalizer. Keep the original promise, including unknown writes, instead of re-running source/card/admission. */
  finalize(pin: SameTurnPlanningPin, retained: ModelInvocationResult, parentSignal?: AbortSignal): Promise<RunProposalResult> {
    if (pin === this.currentPin && this.finalizing) return this.finalizing;
    try { this.check(pin); } catch (error) { return Promise.reject(error); }
    this.finalizing = Promise.resolve().then(async () => {
      this.check(pin);
      if (parentSignal?.aborted) this.refuse('cancelled');
      if (!this.normal || !this.custody || !this.delivered || !this.terminal || !this.input) this.refuse('completion-unknown');
      const input = this.input, selected = this.terminal.draft, completed = frozenCopy(retained);
      const { receipt, response } = completed;
      if (completed.replayed || completed.contentStatus !== 'retained' || completed.purge !== null || receipt.outcome?.state !== 'responded'
        || !isDeepStrictEqual(identity(receipt), this.receipt) || this.ports.text(completed) !== selected) this.refuse('completion-unknown');
      if (!response || !isDeepStrictEqual(modelInvocationResponseContentDescriptor(response), receipt.outcome.content)) this.refuse('completion-unknown');
      let readback: ModelInvocationResult;
      try { readback = await this.ports.readResult(receipt); }
      catch { this.refuse(parentSignal?.aborted ? 'cancelled' : 'completion-unknown'); }
      if (parentSignal?.aborted) this.refuse('cancelled');
      this.check(pin);
      // Store readback can be marked replayed by the reader, but its receipt, body and content status must be identical.
      if (!isDeepStrictEqual({ ...readback, replayed: completed.replayed }, completed) || this.ports.text(readback) !== selected) this.refuse('completion-unknown');
      parseBrainDraft(selected, this.privateKnown, { exact: true, requireCurrentGraph: true });
      const refreshed = await this.ports.revalidate(input, this.receipt!);
      this.check(pin);
      if (!isDeepStrictEqual(refreshed, input)) this.refuse('settings-mismatch');
      if (parentSignal?.aborted) this.refuse('cancelled');
      return this.#complete(input.command, input.prepared, this.invocation!, readback, this.ports.credential, parentSignal);
    }).finally(() => { this.challenge = null; this.privateKnown = undefined; this.result = null; this.custody = null; this.terminal = null; this.preparing = null; });
    return this.finalizing;
  }
}
