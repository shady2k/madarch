/**
 * The kind counts one graph revision answered (madarch-64o5.68): a status poll reads them once, and a later poll of the
 * same revision reads the answer again. A failed read is never remembered, and a late answer for an older revision never
 * replaces a newer one.
 */
export interface KindCount {
  readonly kind: string;
  readonly count: number;
}

export class KindCountsCache {
  private held: { seq: number; counts: readonly KindCount[] } | undefined;

  /** The counts for a revision, read once; a read that throws leaves the cache as it stood. */
  async counts(seq: number, read: () => Promise<readonly KindCount[]>): Promise<readonly KindCount[]> {
    if (this.held?.seq === seq) return this.held.counts;
    const counts = await read();
    // A read for an older revision may land after a newer one answered: it is this caller's answer, never the cache's.
    if (this.held !== undefined && this.held.seq > seq) return counts;
    this.held = { seq, counts };
    return counts;
  }

  clear(): void { this.held = undefined; }
}
