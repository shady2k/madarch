# wiki:demo builds the wiki app before it serves

Change: demo-build
Base: 58fc5c0a65ad66176173d8049da3d65198e62879
Tasks: madarch-iuc.12
Kind: no-behavior

## Intent
The owner runs `bun run wiki:demo` in the luna worktree and must always see the current code: the script builds the wiki app first (bun install --frozen-lockfile, bun run build in wiki/app) and then serves the wiki/demo product. The command's own requirements are untouched; the built app's staleness behaviour comes with the change record `stale-dist` (madarch-iuc.7.1.1) on its own branch.

Stories:
- As the owner running wiki:demo, the serve comes from the sources in the checkout, not from an older dist.

## Rationale
A developer-facing wrapper: the script runs the same build the wiki app has always needed, in the same place; nothing the served wiki does changes.

## Out of scope
- The wiki shots script, the app sources, and the serve command itself.

## Preserved contracts
- product-wiki/app: the built files and the serve decision are unchanged; the script is a wrapper around the same steps

## Coverage
- product-wiki/app: test
