# Product guides

Capability: product-guides

## Purpose
A newcomer uses the product wiki to run the product and perform its supported tasks without rediscovering the repository. Administrator and user guides are grounded how-to documents, not invented operating promises. They serve O4 of wiki-for-people and decision 0032 section 7. Generated pages and durable acceptance evidence belong to the product repository; the engine contains no product data.

## Requirement: guide-outputs — Two grounded guide outputs join the shared writer
The writer shall support administrator-guide and user-guide as two declared output types through the shared unit registry and publication boundary of decision 0032, not an independent writer. Each consumes the full pinned temporal context {valid, known, state}, bounded and splittable prepared graph/document context, and tracked reads including empty results. Inputs shall name source repositories and revisions, relevant evidence spans, extraction/interpretation coverage, locale, supported procedures or scenarios, and known gaps. The administrator input concerns environment, build/deployment and operations. The user input concerns the vision's roles, scenarios, rules, APIs and authentication. These are required integration contracts with the writer-unit work, not claims that its module names or APIs already exist.

Each output shall be versioned and keyed by its input digest. Publication shall be fenced, atomic and idempotent, preserving unrelated authored content. Changed relevant input shall invalidate stale generated content and stale walked status. Deterministic facts shall remain distinct from interpretations or unresolved contradictions. Partial evidence or an unavailable prerequisite shall remain visible; the guide shall not silently shrink to supported fragments while claiming complete coverage. Guide outputs shall be Markdown files in the product repository, with stable guide/procedure/step identities and links to their pinned grounds. Source documents shall not be overwritten. Retries and rebuilds shall not duplicate pages or lose accepted receipts. Reader-facing labels, diagnostics and generated prose shall use English or Russian as selected; source quotations and identifiers remain unchanged.

### Scenario: two-outputs-through-shared-writer
- Given: a training product with grounded operations and scenario inputs at a pinned temporal context
- When: scripted writer units publish both guide types twice and the index is rebuilt
- Then: the same two guide identities and files remain, each with its version, digest, locale, sources and truthful coverage, without unrelated document changes

### Scenario: missing-and-changed-context
- Given: an incomplete operations graph, an unresolved source contradiction or changed command evidence
- When: guides are generated or refreshed
- Then: gaps and both grounded contradictory statements remain visible, changed steps lose any stale walked claim, and incomplete publication is not reported as complete

## Requirement: administrator-guide — The administrator can follow evidenced operating procedures
The administrator guide shall explain the environment, prerequisites, installation, configuration, starting and stopping, health, metrics, logs and known failures evidenced by the repository. It shall distinguish local Compose operation from Kubernetes deployment. Each procedure shall state its goal, applicable environment, working directory, prerequisites, configuration inputs, ordered steps, expected observable results, verification and safe stop or cleanup where evidenced. Each fact and executable instruction shall link to exact source grounds at the pinned context. A documented command is not a guarantee of success and shall show its walked or not-walked status separately.

Secrets shall be named as inputs with their source and scope, not exposed as real credentials. Development defaults shall be labelled development-only. Missing image publishing, cluster configuration, externally supplied secrets, databases or brokers shall be listed as prerequisites or gaps rather than silently invented. A partial deployment manifest shall not be described as a complete deployment recipe. Backups, restoration, production availability and security guarantees shall be absent as promises unless evidenced; missing procedures shall be stated plainly. Contradictory or unsafe guidance shall show the evidence and warning, not be silently repaired or presented as a recommended operational guarantee.

### Scenario: administrator-starts-training-product
- Given: a freshly generated held training repository and an isolated environment meeting its real prerequisites
- When: a newcomer follows the administrator guide alone through configuration, Compose startup, seeding and health verification
- Then: the actual services, Postgres and Kafka run and the expected health results are observed, with a receipt for every executed step and any failure reported honestly

### Scenario: partial-kubernetes-and-missing-backup
- Given: only an orders Deployment and Service with an external image and secret, and no backup procedure
- When: the administrator reads Kubernetes and recovery guidance
- Then: the existing resource and probe details are grounded, missing images/secrets/database/broker/cluster steps are explicit, backup is a stated gap, and no end-to-end deployment or recovery is claimed walked

## Requirement: user-guide — Roles reach supported tasks through the real API
The user guide shall organize how-to procedures by the roles and scenarios stated in the product's vision and documents, linked to the implementing API and business rules. While no frontend or design is connected, it shall say so and use source-grounded API requests, never fictitious screens. For each supported procedure it shall show the goal, role, actual authorization requirements, prerequisites, request sequence and inputs, success response and visible state, relevant failure responses, and repetition or idempotency behavior where evidenced. A role in prose shall not be invented as an enforced permission or a nonexistent endpoint. Desired experience without implementation evidence shall be a visible gap, not a working procedure.

The training product guide shall cover shopper order placement and payment, support lookup/cancellation/shipping/refund as supported, and finance export/report access where supported. It shall distinguish the order-placement use case from full paid checkout. It shall retain the actual authorization exception of the export route as a warning, not invent finance protection. A missing reconciliation workflow shall remain a gap even if the vision describes that goal. Requests shall use isolated test inputs or reader-supplied values, not real credentials. Decline, invalid input and authorization failures shall be shown with their evidenced results; operational claims such as exactly-once charging shall not exceed implementation evidence.

### Scenario: role-procedures-and-uc1
- Given: the running generated training product, isolated seed data and grounded API procedures
- When: a newcomer follows the user guide to perform the order-placement use case and the supported shopper, support and finance procedures
- Then: the real requests and state checks match their evidenced results and every executed step has a receipt; permissions reflect code rather than role names

### Scenario: absent-experience-and-unsupported-goal
- Given: no connected frontend/design and no implemented finance reconciliation API
- When: the user reads the guide
- Then: API requests remain usable for supported goals, no UI or reconciliation steps are invented, the export authorization exception is visible, and the missing experience and workflow are explicit

## Requirement: checked-procedures — Executable steps use a guide-only validated format
Only the two guide output types shall admit structured executable command or HTTP-request steps. Ordinary writer pages shall keep their existing fenced-code prohibition and statement-grounding checks. Each guide step shall declare a stable id, working directory, environment and required inputs, exact command or request content, expected exit/status and observable result, and pinned evidence supporting both instruction and expectation. The guide parser shall validate the complete structure and grounds before publication. An ungrounded command, invented expected response, malformed step, unsafe output path or unsupported block shall be refused without partially publishing a guide. Refusals shall name the file, line and full path or field path and preserve all diagnostics in code-point order.

The writer, its tools and page rendering shall never execute a generated command or request. There shall be no automatic execution button. Acceptance execution is a separate explicit, isolated operation under the test operator's control. Command blocks shall render as literal escaped text, preserve shell/request meaning, identify placeholders and secret inputs, and wrap or provide a labelled local code scroll without horizontal page overflow. Command interpolation shall not expose secret values in pages or receipts. Guide-specific parsing shall not turn arbitrary agent Markdown, HTML or script into executable behavior.

### Scenario: grounded-command-and-ordinary-page-controls
- Given: a guide step grounded in the training Makefile and a source-backed HTTP request with expected results
- When: the guide is validated and rendered, and the same executable block is submitted as an ordinary domain page
- Then: only the grounded guide format is accepted, the ordinary page is refused, the literal text is safe to read/copy, and nothing executes automatically

### Scenario: rejected-command-and-no-partial-save
- Given: an invented command or expected result, unresolved ground, unsafe output path, malformed step or secret-bearing receipt
- When: publication or receipt recording is requested
- Then: explicit file/line/full-path diagnostics are returned and no partial or falsely checked artifact is published

## Requirement: walk-receipts — Walked status comes only from actual isolated execution
A guide procedure shall be labelled walked only when every required step has a valid execution receipt from the separate acceptance harness or operator. The agent's text, graph evidence, a mocked response and a generated receipt are never proof that a command ran. Receipts shall identify guide/procedure/step, repository commit and temporal context, guide/unit version and relevant input digest, exact command/request digest, prerequisite and isolated environment identity, working directory, actual exit/status, expected and observed results, evidence location and execution time. Secrets and personal data shall be redacted without replacing actual status by success. Receipt states shall distinguish passed, failed and not walked, and a failed or missing step shall prevent a complete walked claim. Stale evidence, changed inputs or a changed step shall invalidate the affected claim. Receipts shall be retained in the product repository separately from source truth, survive rebuilds and never grant new execution capability.

The administrator and user guides shall be accepted together against one real generated training deployment, so user steps consume the actual administrator setup. A fake HTTP service or test double may test validation logic but shall never satisfy the live startup/request walkthrough. When an isolated pod lacks container or cluster capability, the report shall name the unavailable prerequisite and leave those steps not walked; acceptance needs an explicit infrastructure decision, not a simulated pass. Kubernetes steps shall be walked only with their actual prerequisites or remain explicitly unwalked.

### Scenario: real-shared-walk
- Given: a capable isolated environment, generated training deployment and both guides
- When: the acceptance harness executes the actual administrator steps followed by supported user requests and verifies their outcomes
- Then: receipts reflect real exits, responses and state, the shared environment is named, and only fully passed procedures show walked

### Scenario: forged-stale-and-unavailable-walk
- Given: an agent-authored success receipt, a changed step, a failed command, or a pod without container capability
- When: walked status is computed
- Then: no unsupported success is shown, the missing/failed/stale condition is visible, and no mocked startup substitutes for execution

## Requirement: guide-reading — Both guides are easy to reach and read
The wiki shall expose Administrator guide and User guide as two distinct labelled entries in the product navigation and document catalogue, in both English and Russian. They shall render from the same checked product artifacts through existing page, Markdown and JSON surfaces, with stable page identities and links to evidence, relevant entity pages and prerequisite procedures. A missing guide shall show an honest generation or evidence gap instead of a dead link or blank page. The guide page shall separate prerequisites, ordered procedures, expected results, walkthrough status and known gaps, using the shared reading tokens and selected theme. It shall not duplicate the complete reference catalogue or invent a second navigation hierarchy. On 1150 px and 390 px, English and Russian, light and dark, labels, actions and prose shall remain readable without page overflow, clipped controls or hidden warnings.

### Scenario: navigation-and-procedure-reading
- Given: both published guides and a procedure with source links, a passed step and a not-walked gap
- When: each guide is reached from navigation and read through the HTML, Markdown and JSON surfaces
- Then: the same procedure identities, grounds, statuses and gaps are available in the selected language, and links reach the intended pages

### Scenario: responsive-guide-reading
- Given: both guides with long command/request lines and visible gaps
- When: they are read in English and Russian, light and dark, at 1150 px and 390 px
- Then: numeric checks find zero horizontal page overflow and no clipped/overlapping controls or warnings, while code text remains available without silent truncation
