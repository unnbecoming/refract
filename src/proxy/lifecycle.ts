import { performance } from 'node:perf_hooks';
import { ulid } from 'ulid';
import type { ApiSurface, Provider } from '../config.js';

export type LifecycleState =
  | 'accepted'
  | 'upstream_started'
  | 'response_started'
  | 'completed'
  | 'upstream_connect_error'
  | 'upstream_stream_error'
  | 'downstream_cancelled';

export interface LifecycleRecord {
  id: string;
  provider: Provider;
  surface: ApiSurface;
  state: LifecycleState;
  acceptedAtMs: number;
  acceptedAtMono: number;
  updatedAtMs: number;
  httpStatus?: number;
  ttfbMs?: number;
  totalMs?: number;
  errorCode?: string;
}

export type LifecyclePatch = Partial<Pick<LifecycleRecord, 'httpStatus' | 'ttfbMs' | 'totalMs' | 'errorCode'>>;

const FINAL_STATES = new Set<LifecycleState>([
  'completed',
  'upstream_connect_error',
  'upstream_stream_error',
  'downstream_cancelled',
]);

export class LifecycleTracker {
  readonly #onChange: ((record: Omit<LifecycleRecord, 'acceptedAtMono'>) => void) | null;
  readonly #active = new Map<string, LifecycleRecord>();
  readonly #recent: LifecycleRecord[] = [];

  constructor(onChange: ((record: Omit<LifecycleRecord, 'acceptedAtMono'>) => void) | null = null) { this.#onChange = onChange; }

  #emit(record: LifecycleRecord): void {
    const { acceptedAtMono, ...safe } = record;
    void acceptedAtMono;
    this.#onChange?.(safe);
  }

  accept(provider: Provider, surface: ApiSurface): LifecycleRecord {
    const record: LifecycleRecord = {
      id: ulid(),
      provider,
      surface,
      state: 'accepted',
      acceptedAtMs: Date.now(),
      acceptedAtMono: performance.now(),
      updatedAtMs: Date.now(),
    };
    this.#active.set(record.id, record);
    this.#emit(record);
    return { ...record };
  }

  transition(id: string, state: LifecycleState, patch: LifecyclePatch = {}): LifecycleRecord | null {
    const current = this.#active.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, state, updatedAtMs: Date.now() };
    if (FINAL_STATES.has(state)) {
      this.#active.delete(id);
      this.#recent.unshift(next);
      if (this.#recent.length > 200) this.#recent.length = 200;
    } else {
      this.#active.set(id, next);
    }
    this.#emit(next);
    return { ...next };
  }

  elapsed(id: string): number | null {
    const record = this.#active.get(id);
    return record ? performance.now() - record.acceptedAtMono : null;
  }

  has(id: string): boolean {
    return this.#active.has(id);
  }

  snapshot(): { active: LifecycleRecord[]; recent: LifecycleRecord[] } {
    return {
      active: [...this.#active.values()].map((record) => ({ ...record })),
      recent: this.#recent.map((record) => ({ ...record })),
    };
  }
}
