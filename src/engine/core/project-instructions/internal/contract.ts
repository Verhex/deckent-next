/** Instruction content is model context, never permission, policy or execution authority. */
export interface ProjectInstructionSource {
  readonly path: string; readonly bytes: number; readonly digest: string; readonly content: string;
  /** What was read: a working-tree file's verified identity (no-follow, single link: a byte-identical replacement is a different file),
   * or the committed blob a work target's ref named (alpha.54 R1: the commit is shown and sealed, the content digest is what trust binds). */
  readonly identity: ProjectInstructionIdentity;
}
export type ProjectInstructionIdentity = Readonly<{ kind: 'file'; dev: number; ino: number }> | Readonly<{ kind: 'ref'; ref: string; commit: string; blobOid: string }>;
/** A committed source of instruction files (a Git work target's base ref): `read` resolves the ref's commit again on every call and returns the
 * bounded blob of `name`, null when the commit has no such entry; it throws `unsafe` (link, submodule, non-tree parent) or `size` (above `maxBytes`). */
export interface CommittedInstructionSource {
  readonly ref: string;
  read(name: string, maxBytes: number): Promise<Readonly<{ commit: string; blobOid: string; bytes: Buffer }> | null>;
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
