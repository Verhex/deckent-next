import type { InferenceRole } from '#domain/index.js';

export interface TokenReservationRequest {
  readonly id: string;
  readonly role: InferenceRole;
  readonly estimatedTokens: number;
}

export interface TokenBudgetState {
  readonly capacity: number;
  readonly reserved: number;
  readonly available: number;
  readonly reservations: readonly { readonly id: string; readonly role: InferenceRole; readonly tokens: number }[];
}

export class InferenceTokenBudget {
  private readonly capacity: number;
  private readonly roleCeiling: (role: InferenceRole) => number;
  private reserved = 0;
  private readonly holds = new Map<string, { role: InferenceRole; tokens: number }>();

  constructor(capacity: number, roleCeiling: (role: InferenceRole) => number) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('INFERENCE_TOKEN_BUDGET_INVALID');
    this.capacity = Math.floor(capacity);
    this.roleCeiling = roleCeiling;
  }

  snapshot(): TokenBudgetState {
    return {
      capacity: this.capacity,
      reserved: this.reserved,
      available: this.capacity - this.reserved,
      reservations: [...this.holds.entries()].map(([id, entry]) => ({ id, role: entry.role, tokens: entry.tokens })),
    };
  }

  tryReserve(request: TokenReservationRequest): 'admitted' | 'wait' | 'rejected' {
    const ceiling = this.roleCeiling(request.role);
    const tokens = Math.min(Math.max(1, Math.floor(request.estimatedTokens)), ceiling);
    if (tokens > ceiling) return 'rejected';
    if (this.holds.has(request.id)) return 'admitted';
    if (this.reserved + tokens > this.capacity) return 'wait';
    this.holds.set(request.id, { role: request.role, tokens });
    this.reserved += tokens;
    return 'admitted';
  }

  release(id: string): void {
    const hold = this.holds.get(id);
    if (!hold) return;
    this.holds.delete(id);
    this.reserved -= hold.tokens;
  }
}
