# A running server follows a renamed product

Change: madarch-64o5.41
Base: a10383e6
Tasks: madarch-64o5.41
Kind: behavior

## Intent
A person can rename an initialized product while its server keeps running and immediately use its catalogue and templates at the new product address, without a restart. Publication completion must describe the live product, not the folder's former location.

## Out of scope
- Changing catalogue definitions, readers, plugin interpretation or fill semantics.
- Changing wiki UI components or the product's stable identity.
- Real model or agent runs; tests use a scripted agent fixture only.

## Preserved contracts
- product-repository/manifest: the product keeps its opaque identity when renamed.
- server/serves-wiki: the server still serves product working-tree pages through the ordinary wiki publication path.

## Coverage
- server/live-product-rename: test
- server/serves-wiki: test
- product-repository/manifest: test

## Where it is seen
Kind: command
Place: `madarch init`, `madarch rename madarch-product`, and the running server's product wiki
1. Initialize a checkout and keep the server running.
2. Rename the product with `madarch rename madarch-product`.
3. Open `/products/madarch-product/` on the same server.
4. Read its catalogue and every kind, including goal, without stopping or starting the server.

## Blocking questions
None.
