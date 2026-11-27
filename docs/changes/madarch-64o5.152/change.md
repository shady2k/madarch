# A plugin's reconcile is decided from the sequences it read

Change: madarch-64o5.152
Base: aeacd745e
Tasks: madarch-64o5.152
Kind: no-behavior

## Intent

Decision 0039, item 24, and its clarification of 2026-11-18: a read used to decide a mutation supplies the graph
revision it read as a precondition, the writer refuses a stale one with `REVISION_CONFLICT`, and the producer rereads
and replans instead of replaying the changed decision. A plugin's reconcile did neither: it read `graph.ownFacts`,
computed the difference and sent `facts.apply` with no preconditions at all, and `OwnFacts` carried no recorded
sequence. Two failures followed.

A batch equal in content to an earlier batch of the same unit came back as that earlier batch's receipt and wrote
nothing: a unit that added a fact, withdrew it and added it again in one run left it withdrawn, because the second
addition was byte-identical to the first. And a statement of the same subjects between the read and the write was
never refused, so a batch planned from a graph that had already moved was published as if nothing had.

`graph.ownFacts` now answers, beside the facts it lists, the last recorded sequence of this source's stream for the
subjects its read covered — the unit's kind inside the read's keys, an own-kind support the read resolved, and the
edges of the kinds the unit writes, retracted subjects included, because a retraction is a statement of the stream too.
It also names what that coverage is, and coverage is the one rule both sides keep: a subject inside it that the answer
names no sequence for is one this source never asserted, and a batch that touches it states that absence; a subject
outside it — a support of the unit kind in a partition the read did not key, a support of another kind, an edge of a
kind the read does not own — is one the read said nothing about, so the batch carries no precondition for it. A
position the answer does name is always stated, wherever its subject stands: a resolved support of the unit kind
carries the sequence the stream holds, never a claim that it was never asserted.

A read bounded by paths cannot enumerate the keys it looked at, so it covers no key by default and vouches only for
the subjects it returns. Every subject the answer returns is covered, the path read from its evidence where the kind
keys by something else, so such a read plans from a position the stream holds rather than from an absence it never saw.

Each batch of a reconcile carries those preconditions, and the key of the operation is the digest of the operation
together with them. A second `add` after a `remove` therefore carries the retraction's sequence and is a different
operation than the first `add`, not a reply of its receipt.

The one writer checks a precondition named by identity inside the write transaction, under the graph's write lock:
it derives the subject's uid from its identity (the protocol addresses subjects by kind and key, never by uid), locks
the subjects the graph already holds in uid order, and compares the expected sequence with this source's current
stream position for each subject. Another source's statement on the same subject never makes a batch stale — the
batch was decided from this source's stream, and the plugin's own facts are what it reconciles. A spent precondition
is refused with `REVISION_CONFLICT`, and the plugin SDK reads `graph.ownFacts` again and replans what still differs,
three attempts at most: a writer that keeps contending ends the unit instead of looping.

No requirement changes: decision 0039, item 24 already states the protocol this code now keeps.

## Out of scope

A scope-wide revision as a precondition: batches of one read touch disjoint subjects, and a later batch of the same
read must not conflict with an earlier one. The door contract of the manual operations and MCP requests
(`preconditions` named by uid against the subject's whole graph revision) keeps its own meaning. The revision
sequence of the manifest publication (`madarch-64o5.74`), a database schema change and a new entry in
`.architecture/violations.json` are not part of this change.

## Rationale

The digest of a canonical request is only as good as what the request says. Keyed by the operation alone, the key
could not tell two decisions apart that differed only in what they had read: the withdrawal between them was
invisible to it. The preconditions are what makes the difference visible, so they belong in the canonical request and
in the digest derived from it — the clarification of item 24 says exactly that, and the SDK now does it.

The check has to be per subject and per source. A scope-wide revision would make every batch of one read conflict
with its neighbours, and a subject-wide revision across all sources would make a plugin stale whenever another
producer stated the same entity — neither is what the reconcile was decided from.

Coverage is what keeps a precondition honest. The SDK cannot tell a subject the read looked at and found absent from
one the read never looked at, so the read states the difference itself: it answers what it covered, and a batch claims
absence only inside that. A support of the unit kind in a neighbouring partition is the case that makes this visible.
A git fill split into partitions writes the parent commit as a support, while the partition that owns that commit
already asserted it; a claim of absence for the support made the first fill of any repository with more than one
partition fail after three conflicts, which is why no support outside the read's coverage claims anything.

Identity, not uid: the protocol's own rule (0035, item 3) is that a plugin names an entity by kind and key and never
by a node id the host hands out, so a precondition is named the same way. The graph derives a subject's uid from its
identity alone, so a subject the graph does not hold yet still has the identity a precondition names, and its
sequence is zero.

`PluginFactsApplyRequest` carries preconditions the manual door does not: the request shape and the writer's check
read the subject form, while the door's `{uid, recordedSequence}` form keeps the subject's whole graph revision that a
person's authored read stated. Both are enforced in the same place, in the same transaction.

## Preserved contracts

- fill-orchestrator/publish: a unit's facts still enter through the one writer under the host's binding, one atomic operation per batch, and the receipt still answers a replay of the same key with the same request. A plugin still writes only its own source's differences in the covered scope, removes facts after a complete, problem-free read, and writes support vertices of another kind without a precondition.
- graph-queries/as-of: what a reader sees is unchanged — reconcile writes the same statements it wrote before, and a fact that was current in an earlier read is still current in a later one.

## Coverage

- fill-orchestrator/publish: static, test, review
- graph-queries/as-of: static, test, review

## Where it is seen

Kind: internal
Place: `src/plugin-sdk.ts`, `src/plugin/protocol.ts`, `src/graph/producer-facts.ts`, `src/graph/operation-host.ts`
Reason: nothing a person reaches changes. A plugin author sees the added answer field and the preconditions a batch carries, both derived by the SDK; a wiki page, a fill and a reader see what they saw before.

1. Run a plugin unit that adds a fact, withdraws it and adds it again: the fact stands at the unit's end, where before it stayed withdrawn.
2. Have another batch of the same source state a touched subject between the read and the write: the writer refuses with `REVISION_CONFLICT`, the SDK reads the graph again and writes only what still differs, and a writer that keeps contending ends the unit after three attempts.
3. Read `graph.ownFacts` after withdrawing a fact: the answer names the withdrawn subject's sequence and its parent role, and names nothing for a subject this source never asserted.

## Blocking questions

None.
