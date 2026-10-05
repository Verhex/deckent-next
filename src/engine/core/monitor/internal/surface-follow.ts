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
/** Each newly opened producer starts at these cursors after capturing its baseline. */
export type SurfaceStreamStart = {
  readonly control: 'start'; readonly scopeId: string;
  readonly cursors: Readonly<Record<SurfacePublicationKind, number>>;
};
export type SurfaceFollowEvent = SurfacePublicationEvent | SurfaceAccessDenied | SurfaceStreamStart;

/** Opaque principal/company/ledger binding; fresh permission results never grant a different capture. */
export type SurfaceSnapshotAccess = { readonly binding: string; readonly kinds: readonly SurfacePublicationKind[] };
