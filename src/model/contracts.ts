/**
 * The topic or queue a contract names, or `undefined` for any other kind
 * (intended-model/messaging). Reads a contract as written or normalized: the
 * kind and what follows its `kind::` are the same either way. Shared by the
 * loader, which checks relations against it, and the views, which label them.
 */
export function messagingOf(contract: string): { kind: 'topic' | 'queue'; name: string } | undefined {
  const at = contract.indexOf('::');
  if (at < 0) return undefined;
  const kind = contract.slice(0, at);
  const name = contract.slice(at + 2);
  if ((kind !== 'topic' && kind !== 'queue') || name === '') return undefined;
  return { kind, name };
}
