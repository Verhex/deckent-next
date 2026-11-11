export interface IntegrationCommitMetadata { readonly title: string; readonly acceptance: Readonly<{ phase: string; criteria: number; runRevision: number; modelUnverified: boolean }>; readonly deliveredAtMs: number;
  /** Replay only: a durable candidate's exact commit, never permission to publish it. */
  readonly expectedCommit?: string }
