# Standard contract dependency audit

Task: madarch-m38l.16

## Pinned adoption

- `redoc` 2.5.4, MIT, published 2026-09-10; React 19 peer range accepts the app.
- `@asyncapi/react-component` 3.2.1, Apache-2.0, published 2026-09-17; React >=18 peers accept the app.
- `protobufjs` 7.5.4, BSD-3-Clause, is the server-side protobuf grammar and type resolver. Its loader is not used: imports go through the pinned repository reader only.
- Redoc peers are explicit app dependencies: `mobx` 6.15.0, `core-js` 3.46.0 and `styled-components` 6.1.19. React and React DOM stay at the existing 19.3.0 pin.

The two Bun lockfiles were generated with `bun install --lockfile-only --ignore-scripts`. Root resolution exited 0; app resolution exited 0. No lifecycle scripts, local tests or local builds ran. Frozen install, type compatibility, renderers, binary embedding and offline browser behavior remain unverified until CI and the bounded pod acceptance run.

## Runtime boundaries

Definition is deferred. Renderer modules and AsyncAPI styles use local lazy imports. The app supplies schema objects rather than URLs. The server bundles repository-local JSON references, retains cycles, and refuses unsupported remote references, missing pointers, source images and external examples with source diagnostics. JSON/YAML and protobuf imports have a 64-file and 4 MiB budget; exceeding either is an explicit refusal, not partial documentation.

The existing binary builder recursively embeds the app dist, including lazy assets. A binary/offline browser walk is still required: the mechanism alone is not evidence that the new dependencies work.
