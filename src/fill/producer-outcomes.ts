/** Observable producer results, published as ordinary system.unit assertions. */

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

