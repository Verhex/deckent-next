/** Instruction content is model context, never permission, policy or execution authority. */
export interface ProjectInstructionSource {
  readonly path: string; readonly bytes: number; readonly digest: string; readonly content: string;
}
export type ProjectInstructionView =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'blocked'; reason: 'size' | 'unsafe' | 'unreadable' }>
  | Readonly<{ status: 'trust-required' | 'ready'; source: ProjectInstructionSource }>;
export interface InstructionBridge {
  readonly id: string; readonly path: string; readonly line: string; readonly detected: boolean;
}
export interface InstructionFileChange {
  readonly path: string; readonly before: string | null; readonly beforeDigest: string;
  readonly after: string; readonly append: string;
}
export interface InstructionInitPreview {
  readonly schemaVersion: 1; readonly digest: string; readonly changes: readonly InstructionFileChange[];
  readonly bridges: readonly InstructionBridge[];
}
/** Host-bound contract shared by terminal and bootstrap; no model-origin trust choice is admitted. */
export interface ProjectInstructionPort {
  inspect(): Promise<ProjectInstructionView>;
  trust(digest: string): Promise<ProjectInstructionView>;
  preview(bridges: readonly string[], skeleton: (name: string, commands: readonly string[]) => string): Promise<InstructionInitPreview>;
  initialize(preview: InstructionInitPreview): Promise<readonly Readonly<{ path: string; status: string }>[] >;
}
