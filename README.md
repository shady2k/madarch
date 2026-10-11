# madarch

Each product's knowledge — its documents, its intended model, its skills,
its prototypes, the wiki that serves them — is a git repository of its own,
apart from the product's code. The `madarch` command creates it, names it,
joins into it the code repositories it spans, and serves its wiki; the same
repository, cloned by a colleague, comes with its code checked out under
`repos/` already.

## Existing

- [Start a product from the repositories you already have](docs/guides/start-a-product.md):
  install madarch, create the product's repository, add your existing
  repositories, push, clone as a second engineer, open the wiki, start the
  work with your agent.
- `AGENTS.md`: the way this repository itself is worked — the skill set's
  tracker, gates and checks.
- `wiki/demo`: the committed demo product; `bun run wiki:demo` serves and
  opens its wiki.
- `docs/system/index.md`: the capability specifications, one file per
  capability. `docs/decisions/`: the decisions the system stands on.
