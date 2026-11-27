# Only the manifest publication states the manifest's kinds

Change: madarch-64o5.151
Base: b7c33e596501093a4c2e1f2a57f9fda28f5afd23
Tasks: madarch-64o5.151
Kind: no-behavior

## Intent

The fast start path skips publication when the catalogue's stored publication fingerprint matches, and that is safe
only while the manifest publication is the one source of the manifest's kinds. It was not enforced. A startup binding
gave every trusted host producer `'*'` permissions on every kind the contract holds, the manifest kinds among them, so
any host code that bound a source could state or retire the catalogue; a plugin binding's permissions were narrowed by
which kinds it was granted, but nothing refused one that was granted a manifest kind; and `capability: 'manifest'` on
those kinds was metadata the writer never read.

The one writer now reads it. A contract kind whose declared capability is reserved — today only `manifest` — is
written by the source serving that capability and by no other source, and the bound write capability carries the
source's own capability, its producer name. A source that states or retires such a kind without serving it is refused
with `CAPABILITY_MISMATCH`, naming the kind, the capability and the source. Producer bindings also stop taking a
reserved kind as a slot, whatever the grant asked for.

The architecture check gains a rule of its own, `one-manifest-binding`: `startupBinding` and `bindStartupWriter` are
called for the `manifest` producer in `src/graph/manifest-publication.ts` and nowhere else, read from the parsed call
and its literal arguments.

No requirement changes: the writer's authority and the one publication are the contracts the requirements already rest
on, and this change makes the code keep them.

## Out of scope

Who may settle a contested starter value (madarch-64o5.113, madarch-64o5.141), and the publication fingerprint itself
(madarch-64o5.74): the fast start path still trusts the stored fingerprint. The plugin host and the protocol
(madarch-64o5.152) take the narrowed grants up; a database schema change and a new entry in
`.architecture/violations.json` are not part of this change.

## Rationale

Two authorities had to agree and neither did. The writer accepted whatever permissions a binding held, so the only
thing keeping the catalogue single-sourced was that no host producer happened to write one; and a plugin granted a
manifest kind would have been published as a second source of the catalogue, which the fingerprint-skipping start path
would then never re-publish over.

Enforcing equality of every kind's declared capability would refuse the engine's own writes: a host source legitimately
states kinds of several capabilities in one transaction — the manifest publication states its own declarations beside
system snapshots and the product's page templates and starter sets — so the declared capability cannot narrow every
kind to one source. What it can say is which capabilities the engine reserves for one source, and the contract now
declares that beside the capability: `reservedCapability` on the manifest's kinds, and the source serving it is the
one writer. A product kind names a plugin, and its narrowing stays the permissions a binding was given.

The writer's check is a name the source carries, not a draft's label: a draft's `producer` field never carried
authority, and the refusal is decided before any permission lookup, so a binding never granted the kind is refused by
the capability check and names why.

## Preserved contracts

- fill-orchestrator/publish: a unit's assertions still enter through the one writer and commit atomically under the source's host-issued binding; only a source stating a kind of a capability it does not serve is refused, and no fill's manifest declares one.
- graph-queries/as-of: what a reader sees is unchanged — the manifest publication states and retires exactly the catalogue it stated before, and a source that never wrote a manifest kind still writes everything it wrote before.

## Coverage

- fill-orchestrator/publish: static, test, mutation, review
- graph-queries/as-of: static, test, mutation, review

## Where it is seen

Kind: internal
Place: `src/graph/write.ts`, `src/graph/manifest-publication.ts`, `src/graph/producer-binding.ts`, `scripts/check/architecture/manifest-binding.ts`
Reason: nothing a person reaches changes — the catalogue, the pages and the wiki's reads are what they were; the change refuses a write no product's declaration ever made and holds the manifest binding to one module.

1. Publish a product's catalogue, then bind a host source and a plugin binding and have each assert a `manifest.kind`
   and retire `manifest.catalogue`: both are refused with `CAPABILITY_MISMATCH` naming the kind, the capability and
   the source.
2. Republish the same product with a kind removed: the manifest publication retires the declaration it stated.
3. Write a module that binds `startupBinding` for `manifest` outside `src/graph/manifest-publication.ts` and run
   `bun run check`: the check names the module, the line and the rule.

## Blocking questions

None.
