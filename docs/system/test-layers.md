# Test layers

The layer checks read the value import graph and static bindings, not source-text
patterns. They apply to `test/unit`, `test/integration`, `test/e2e` and
`test/measure`.

## Database ownership

The run database helper currently lives in `test/test-database.ts`. Unit cases
must not reach it. Integration cases use `createTestDatabaseOwner` without a
`store` option; a store folder belongs to an end-to-end case. Both reach rules
identify the defining module, following public re-exports and local aliases.
Moving the helper to `test/support/test-database.ts` does not change these rules.
Other test modules defining and exporting `createTestDatabaseOwner` are identified
by that public binding too, rather than by an import barrel's path.

## Static binding resolution

All rules share the same resolver for named imports, import aliases, namespace
members, local variable initializers, local named exports, named re-exports and
star re-exports. Local bindings distinguish aliases from call results. Only the
case API retains a stored call result's root when it resolves to `test` or `it`
from `bun:test`. This includes `const hostTest = test.skipIf(...)` and
`const t = test`. Process, Bun member, database and default-timeout checks follow
local aliases, not stored call results. Parentheses and transparent TypeScript expression wrappers
retain that root. Cycles stop the walk.

A case rooted in `test` or `it` from `bun:test` names its third argument with
`bound(ms, { measured, on, at })` from `test/support/deadline.ts`. A reachable
`test/support` helper cannot set `setDefaultTimeout`, including through an alias.
A type query such as `ReturnType<typeof execFileSync>` is not a value use.
Process bindings cannot escape `test/support/git.ts`; direct calls there must
name the literal command `git`.

The resolver is a static path resolver, not a TypeScript evaluator. It does not
resolve destructuring, computed properties (including string-index notation),
assignments after declaration, scope shadowing, conditional expressions, object
or array containers, parameter/return flow, CommonJS binding assignments, dynamic
import bindings, default export expressions, or export-namespace declarations.
The value import graph still checks module reach for require and dynamic imports.
The rules do not evaluate arbitrary helper functions. The case-chain policy
retains stored call roots only for `test` and `it` from `bun:test`; it does not
prove a returned value's runtime identity. Inline call/member paths are still
read syntactically, without evaluating their returned values. TypeScript type checking remains a separate check.
