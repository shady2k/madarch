/** Observable producer results, retained in the existing unit generation's draft header. */

export type ProducerOutcome = 'completed' | 'unchanged' | 'empty' | 'abstained' | 'failed';
export interface ProducerOutcomeDraft {
  readonly plugin: string;
  readonly kind: string;
  readonly outcome: ProducerOutcome;
  readonly produced: number;
  readonly reason?: string;
  readonly producerVersion?: string;
}
export interface ProducerRunOutcome extends ProducerOutcomeDraft {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
}

export function producerSucceeded(outcome: ProducerOutcome): boolean {
  return outcome === 'completed' || outcome === 'unchanged' || outcome === 'empty';
}

/** Retain plugin generation snapshots for explicit earlier-version reads, never static bulk drafts. */
export function retainedProducerOutcomes(writes: readonly { readonly kind: string; readonly value: unknown }[], facts: number): readonly { readonly kind: string; readonly value: unknown }[] {
  if (!writes.some((write) => ['producer-outcome', 'plugin-partition', 'plugin-aggregate'].includes(write.kind))) return [];
  return writes.filter((write) => ['producer-outcome', 'vertex', 'edge', 'plugin-partition', 'plugin-aggregate'].includes(write.kind)).map((write) => {
    if (write.kind !== 'producer-outcome') return write;
    const value = write.value as ProducerOutcomeDraft;
    return { kind: write.kind, value: { ...value, outcome: value.outcome === 'completed' && facts === 0 ? 'unchanged' : value.outcome } };
  });
}

