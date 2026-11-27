/** Observable producer results, published as ordinary system.unit assertions. */

export type ProducerOutcome = 'completed' | 'unchanged' | 'empty' | 'inapplicable' | 'abstained' | 'failed';
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
  // An inapplicable answer is a search that found no applicable place, so the producer did its work: the kind's absence
  // is its result, not a silence of the producer.
  return outcome === 'completed' || outcome === 'unchanged' || outcome === 'empty' || outcome === 'inapplicable';
}

