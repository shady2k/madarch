# What the reference graph does not hold

Two kinds of omission: facts the repository plainly states that no kind of the
producer vocabulary (`src/knowledge/starter-mapping.ts`) holds, and readings
left out because a person cannot establish them from the file that states them.
Every item names the line it would rest on.

## Facts no kind holds

- **The requirements.** The use cases UC-1 to UC-4 (`docs/requirements.md`:5,
  8, 11, 13) and the business rules BR-1 to BR-5 (`docs/requirements.md`:18,
  24, 28, 32, 37). The producers emit no requirement kind (the mapping has no
  `doc.*` key), so these paragraphs are not nodes. Their section is a
  `code.document-section`, and the code each rule names is a judgement
  `code.mentions` edge from it.
- **The glossary terms** (`docs/glossary.md`:3 to 9). A term of the product's
  language has no kind; the terms are judgement mentions from the glossary
  section.
- **The OpenAPI schemas** `PlaceOrder`, `Item`, `Order`, `OrderPage` and
  `Error` (`contracts/openapi/orders.yaml`:159 to 227), the reusable
  `OrderId` parameter (:152), the request parameters of `createOrder`
  (:19 to 29) and `listOrders` (:53 to 62), and the `bearerAuth` security
  scheme (:147). No kind holds a schema, a parameter or a security scheme;
  the operations that use them are nodes.
- **The message payload fields** of `OrderChanged` and `PaymentEvent`
  (`contracts/asyncapi/order-events.yaml`:34 to 56, 61 to 73) and of the four
  proto messages (`contracts/proto/payments.proto`:18 to 23, 27 to 31, 35 to
  37, 41 to 42). `code.field` is a field of a declared type, and a message is
  not a type.
- **A timeout's number.** `PAYMENT_TIMEOUT_MS` defaults to 3000
  (`services/payments/src/config.ts`:16) and `PAYMENTS_DEADLINE_MS` to 8000
  (`services/checkout/src/config.ts`:18); no kind holds a duration. The
  `code.calls-remote` edges that carry a deadline quote the lines that apply
  it (`services/checkout/src/payments-client.ts`:39 and 41).
- **A compose volume** (`docker-compose.yml`:9 to 10) and the healthcheck's
  `test`, `interval`, `timeout` and `retries` (:12 to 15): the healthcheck is
  a node, its settings are not.
- **Kubernetes settings**: `replicas: 2` (`deploy/k8s/orders.yaml`:8), the
  selector labels (:10 to 11, 47 to 48), and `envFrom.secretRef` (:22 to 24) —
  a secret named `orders-env` that this repository does not define.
- **A Dockerfile's stages, `RUN` lines and `ENV`** (`services/payments/Dockerfile`:7,
  13, 15, 19): the build a Dockerfile describes beyond its base image, its port
  and the files it copies has no kind.
- **A CI job's commands** (`.github/workflows/ci.yml`:18, 19, 31, 43 to 46, 58
  to 60) and a Makefile target's recipe beyond the lines quoted in the
  target's evidence (`Makefile`:8, 11 to 14, 18 to 21, 24, 32 to 33). No
  relation states that a job or a target runs a command.
- **The container environment of the images** (`POSTGRES_USER`,
  `POSTGRES_PASSWORD`, `KAFKA_*` in `docker-compose.yml`:5 to 6, 23 to 31).
  `code.env-var` is a setting the repository's own code reads, and these are
  settings of the images.
- **The date anomaly of the history**: commit `dab635b` has the author date
  2026-09-16 and the committer date 2026-09-04, earlier than its parent's
  (`git log -1 --format=%aI%x09%cI dab635b`). A commit's dates have no kind;
  the commit node's evidence is its subject.
- **The second parent of the merge** `8f7f63c` (`git log -1 --format=%P`).
  `code.parent` records the first parent, the line the history walks; the
  merge's other parent is in the quote.
- **Imports of a language's standard library** (`net/http` in
  `services/orders/internal/api/router.go`:7, `node:crypto` in
  `services/payments/src/index.ts`:1). `code.dependency` is a library a
  manifest declares, and a manifest declares none of these.
- **The transitive rows of the lock files**: 414 packages with exact versions
  in `services/payments/package-lock.json`, 389 in
  `services/checkout/package-lock.json` (`packages` less the root record), and
  the modules of `services/orders/go.sum` and `services/promotions/go.sum`
  beyond the three and one direct dependencies. The lock file node names the
  count, and `code.resolves` covers the direct dependencies only.

## Left out on purpose

- **Expressions, literals and raw mentions.** The task leaves them out: they
  are extraction intermediates, not things a reader asks about. Local
  variables are not symbols either; only file-level declarations are.
- **Calls whose target a reader cannot name.** Of 642 call sites in the Go
  files and 821 in the TypeScript files, the reference states 296 callee
  links resting on 411 call sites. The rest are: calls into the standard
  library or a third-party module (`fmt.Errorf`, `jwt.Parse`, `kafka.Writer`,
  `prisma.$queryRawUnsafe`, `JSON.parse`); calls through a function value
  passed as an argument (`fn(order)` in `Service.ForEach`,
  `handler(req, res, body)` in the checkout test); and calls through a value
  whose type this repository does not declare (a `*sql.DB`, a `*slog.Logger`,
  an Express `Response`). Each would need a type from outside the repository,
  and guessing one would be a guess.
- **Which symbol a TypeScript test exercises.** The jest `it` names say it in
  words (`services/checkout/test/pricing.test.ts`:4, 11) and no syntax links
  the case to a symbol, so only the Go test cases carry `code.tests` edges.
  The Go edges are judgement: `TestDiscount` names `Discount` by convention,
  not by the compiler.
- **Directory nodes** (`code.directory`) and module facets. A directory that
  is a Go package is a `code.module`; the other directories hold files and
  nothing of their own. `code.facet`, `code.coverage`, `code.call`,
  `code.mention`, `code.binding`, `code.export`, `code.argument` and the other
  internal kinds are extraction intermediates and are not used.
- **The answer key's snapshots.** The generated repository carries no tags
  (`git tag` is empty), so a snapshot is a date in the key, not a fact of the
  repository.
