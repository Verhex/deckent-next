/** Read-only in-process publications. Access results are control messages, never ledger events/cursors. */
export type SurfacePublicationKind = 'approval' | 'run' | 'worker';
export type SurfacePublicationEvent = {
  readonly kind: SurfacePublicationKind;
  readonly scopeId: string;
  readonly sequence: number;
  readonly id: string;
  readonly text: string;
};
export type SurfaceAccessDenied = {
  readonly access: 'denied';
  readonly scopeId: string;
  readonly kinds: readonly SurfacePublicationKind[];
  readonly stopped: boolean;
};
export type SurfaceFollowEvent = SurfacePublicationEvent | SurfaceAccessDenied;
