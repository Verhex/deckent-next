/** Display strings only; approval identity/revision/capability and authority DTOs remain in their original closure. */
export type ApprovalRowPresentation = Readonly<{ kind: 'approval-row'; rowNumber: number; summary: string; displayId: string; displayRun: string; displayTask: string; itemTemplate: string; durationText: string;
  /** T-APPROVAL-WINDOW list row: what the call does, who asked, how long it has waited (empty: unknown). */
  what: string; requester: string; ageText: string }>;
