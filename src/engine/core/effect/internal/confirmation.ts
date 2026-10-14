/** A trusted effect broker capability, never a command flag or a model/SDK answer.
 * Future rule-based brokers can implement the same port; this slice wires human-terminal only. */
export interface EffectConfirmationView {
  readonly operation: string; readonly scopeId: string; readonly commandId: string; readonly actor: Readonly<{ id: string; issuer: string; subject: string }>;
  readonly resource: string; readonly from: string; readonly to: string;
  readonly runId: string; readonly taskId: string; readonly title: string;
  readonly files: readonly string[]; readonly added: number; readonly removed: number;
}
export interface EffectConfirmation {
  /** Refuse unavailable authority before candidate preparation or a journal claim. */
  assertAvailable(): Promise<void>;
  /** The returned guard revalidates the witness immediately before the effect. */
  confirm(view: EffectConfirmationView): Promise<() => Promise<void>>;
}
