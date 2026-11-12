# Product reset

Capability: product-reset

## Purpose
Start a product's filled knowledge over locally without losing the product's
identity or requiring a running server.

## Requirement: reset — Start a product's filled knowledge over through its store owner
`madarch reset sample` shall preview the local reset and apply it only after
confirmation, or with `--yes`. When the product has a running owning server, the
command shall request the preview and reset through that server. Without a
running server, the command shall prepare and own the product's store directly
for both preview and application, await completion, and close its store when
done. It shall report what was removed and shall not report success before the
reset has completed.

A completed reset shall remove filled knowledge and the agent-produced files
selected by the reset plan, while keeping the person's pages, answers,
questions and corrections under the reset's existing preservation rules. It
shall leave the product idle and `not-filled`, without starting a fill. The
manifest catalogue remains available from the graph: resetting knowledge does
not restore a working-tree catalogue reader or require Fill to see the
manifest's declared kinds. The next fill remains an explicit action.

### Scenario: reset-without-server
- Given: a filled product and no running server owning its store
- When: `madarch reset sample --yes` is run
- Then: the command opens the store as its owner, applies and awaits the reset, reports the removal, closes its store and succeeds; the product is idle and `not-filled`, and its catalogue still reads the manifest declarations from the graph

### Scenario: reset-through-running-server
- Given: a filled product served by its running owning server
- When: `madarch reset sample --yes` is run
- Then: the command previews and applies the reset through that server and reports the removal; the same server serves an idle, `not-filled` product whose catalogue reads the manifest declarations from the graph, without starting a fill
