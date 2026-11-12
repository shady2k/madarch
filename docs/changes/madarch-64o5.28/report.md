# Starter kind prerequisite draft

Task: madarch-64o5.28
Base: `origin/feature/madarch-kinds-as-files` at `3d2541bde70a5d42e0540b8329f2b65b026ea6e1`
Date: 2026-11-12

## Scope and meaning

All **519 kinds** have an explicit `depends-on` list. The two files under `catalog/templates/` are presets, not kinds. The branch field remains `depends-on`; the owner's rename to `derives-from` at merge is not included. Dependency values are manifest kind names (filenames), not the different canonical concept IDs.

`A ← B` means B supplies the graph context or evidence needed to fill A meaningfully. This is a draft of kind-level discovery inputs, not a claim that a standard mandates this exact graph or that every entity instance must link to every prerequisite. Containment, consumers, and convenient traceability alone do not establish prerequisites. Lists are conjunctions; alternatives are not silently encoded as mandatory AND. Direct redundant ancestors were removed; the closure is transitive.

Every kind definition, English description and cited source address was reviewed. Source retrieval and substantive reading depth are recorded in [sources.md](sources.md). Some citations resolve only to abstracts, sign-in pages, JavaScript shells, blocked pages or moved notices. These were not represented as full standards reads. This is a reasoned draft with those limits, not a normative standards certification.

## Section counts

| Section | Kinds | Roots |
| --- | ---: | ---: |
| architecture | 35 | 2 |
| automation | 2 | 0 |
| code | 27 | 2 |
| common | 22 | 11 |
| costs | 9 | 0 |
| data | 20 | 5 |
| decommissioning | 4 | 0 |
| delivery | 34 | 4 |
| design | 18 | 6 |
| discovery | 10 | 0 |
| documentation | 22 | 0 |
| history | 8 | 1 |
| information | 8 | 1 |
| infrastructure | 35 | 1 |
| messaging | 14 | 6 |
| ml | 10 | 0 |
| operations | 40 | 0 |
| organisation | 10 | 2 |
| privacy | 16 | 4 |
| rd | 11 | 0 |
| requirements | 17 | 1 |
| resilience | 17 | 0 |
| review | 3 | 0 |
| security | 47 | 13 |
| strategy | 27 | 1 |
| suppliers | 6 | 0 |
| testing | 34 | 0 |
| work | 13 | 0 |
| **Total** | **519** | **60** |

There are **548 direct prerequisite edges**.

## Roots for owner review

Every root explicitly declares `depends-on: []`. A root is independently fillable from external input, reference vocabulary, or a primitive record; it is not necessarily the first page a reader sees.

| Kind | Section | Reason for no kind prerequisite |
| --- | --- | --- |
| `resource` | architecture | A physical or virtual infrastructure resource can be identified independently from its consumers; requiring a component would make the consumer a prerequisite. Deployment and ownership links are later associations. |
| `technology` | architecture | A language, framework or runtime can be identified from its published name and lifecycle independently of any product implementation; product usage is a later association. |
| `code.graphql-schema-type` | code | The catalog has no GraphQL-schema kind; neither a consuming operation nor a generic contract restricted here to OpenAPI/gRPC/AsyncAPI is required. |
| `code.json-schema` | code | JSON Schema Core and Validation define independently addressable schemas; a consumer is not a prerequisite. |
| `comment` | common | A comment is a primitive authored remark attachable to any entity kind; its target and author are instance references, and no one catalog kind is a universal prerequisite. |
| `external-reference` | common | A remote system name, external key and URL can be recorded for any kind of thing; no particular local entity kind or configured integration is required. |
| `operation` | common | An operation is a primitive intended change, including creation of the first graph entity; requiring a preexisting entity or snapshot would prevent graph bootstrapping. |
| `request` | common | A verbatim human request is primary input, including a request to create a product; derived work, approvals and changed entities must not be prerequisites of that input. |
| `snapshot` | common | A restore point serializes the graph state even when empty; it need not have journal increments, a backup policy or any particular entity kind to be meaningful. |
| `time-entry` | common | Time may be spent on any entity by a person or agent; duration and actor identity can be recorded without requiring a particular task or workflow kind. |
| `accounting` | common | This is the reusable schema for per-step cost and outcome fields, not an execution record; actual steps, runs and their workflows consume the schema. |
| `event` | common | An event name is a primitive trigger vocabulary entry; a transition consumes it, and requiring the transition first would invert the definition order. |
| `field-set` | common | A reusable named field set is a schema building block; concrete kinds that compose it and instantiated entity values are consumers, not prerequisites. |
| `responsibility` | common | This is the reusable schema naming accountable and executing actors; actor instances can be people or agents, so no single actor kind is universally necessary to define the fields. |
| `workflow-status` | common | A named status is a primitive workflow vocabulary entry that can be declared before a transition or workflow uses it; this avoids a status/workflow containment cycle. |
| `data-facet` | data | The flat conjunctive prerequisite list cannot express dataset OR job OR run. Do not force all three populations or require runtime observations for static dataset facets; validate the actual attachment when filling each facet. |
| `data-catalog` | data | DCAT CatalogRecord is explicitly optional; requiring records would invert aggregation and create a catalog/record cycle. |
| `dataset` | data | OpenLineage explicitly supports Dataset metadata events; neither the producing job nor a physical relational table is intrinsic. |
| `provenance-agent` | data | PROV-O defines Agent as a starting-point class; responsibility relationships do not require activities to be filled first. |
| `provenance-entity` | data | PROV-O Entity is a starting-point class; requiring generating activities would prevent recording data with unknown origins and cause inverse provenance cycles. |
| `build-platform` | delivery | The platform is independently identifiable infrastructure; requiring a build or provenance would reverse the producer relationship. |
| `code.image` | delivery | An externally supplied image is independently identifiable by its registry coordinate; its producers and consumers need not be catalogued. |
| `flag-provider` | delivery | The adapter/source can be named and described without its served flags or callers; requiring those consumers would reverse the dependency. |
| `runner` | delivery | The runner machine or agent has independent identity; no pipeline or job execution is needed to describe an idle runner. |
| `accessibility-success-criterion` | design | The numbered WCAG success criterion is imported normative vocabulary, with its A/AA/AAA level; product screens and evaluations apply it later. |
| `locale` | design | A language/region and formatting convention can be imported directly from CLDR; translated product text is a consumer, not a prerequisite of identifying a locale. |
| `message` | design | A source message and its placeholders can be authored before choosing any target language or screen; locale translations and UI usage are later associations. |
| `asset` | design | An image, icon or font resource can be identified and supplied before any screen uses it; requiring a screen would make the consumer a prerequisite. |
| `ui-component` | design | A reusable UI unit can have its own API and rendering behavior before a design system, screen or story adopts it; requiring those consumers would reverse composition. |
| `design-token` | design | An atomic named design value is a design vocabulary primitive; groups, sets, styles and components collect or consume it later. |
| `code.repository` | history | The repository is directly declared source identity; requiring its children would invert repository aggregation. |
| `information-classification` | information | A classification level and its disclosure meaning can be declared as policy vocabulary before any information is assigned to it; classified items consume the level. |
| `protocol` | infrastructure | Protocol identity and communication rules can be filled from the protocol specification alone; product uses are consumers. |
| `cache` | messaging | The cache is an independently identifiable store; consuming services and separately documented policies do not establish its identity. |
| `code.broker` | messaging | The broker is a directly declared messaging endpoint; consumers and channels are optional further inventory, not prerequisites. |
| `notification-template` | messaging | A template is reusable content, not an email instance or a child requiring the sending service to exist. |
| `file-share` | messaging | NFS defines a server export as an accessible resource; the mounting service is a consumer, and a managed file share need not have a catalogued host server. |
| `object-store` | messaging | The store is the parent namespace for buckets; requiring buckets would invert aggregation, while consumers do not establish the store. |
| `sftp-endpoint` | messaging | The consuming service is not a prerequisite, and SSH transport does not require a separately catalogued host-server or protocol object. |
| `user` | organisation | A person identity is an independently identifiable principal; memberOf and ownedBy links are subsequent assignments, not identity inputs. |
| `organization` | organisation | W3C ORG defines Organization as a collective body; its constituent records are not prerequisites for identifying that body. |
| `control-catalog` | privacy | OSCAL identifies the catalog model as the basis for every higher model; requiring child controls first would invert the catalog/control context. |
| `data-subject-category` | privacy | This is a reusable classification of persons, not a processing record or an individual subject; Article 30 consumes these categories. |
| `personal-data-category` | privacy | Article 30 consumes the classification; DPV treats PersonalData as an independent core concept, so processing activities are not its prerequisites. |
| `purpose` | privacy | Purpose limitation requires explicit purposes in advance; DPV describes Purpose as conceptually independent of PersonalData and LegalBasis. |
| `quality-characteristic` | requirements | The reference taxonomy defines characteristics independently; requirements that use them are consumers, not prerequisites. Only the ISO public abstract was accessible. |
| `iam-account` | security | Accounts include machine identities as well as humans; neither a human user page nor an access grant is a universal prerequisite. |
| `iam-role` | security | The role is an authorization definition, not an assignment; requiring account grants would reverse its use. |
| `protection-profile` | security | A protection profile is a source for product-specific security targets, not derived from one; no equivalent reusable product-category prerequisite exists in the catalog. |
| `secure-development-practice` | security | NIST publishes reusable outcome-based practices; requiring the implementing process would reverse the standard-to-implementation direction. |
| `security-control` | security | This kind represents the authoritative ASVS requirement itself, not a product-specific requirement derived from a threat assessment. |
| `crypto-algorithm` | security | The algorithm is reusable cryptographic vocabulary; key material and cryptographic inventories consume it. |
| `indicator` | security | STIX requires the detection pattern, not prior attack attribution or a local threat-model object; associated campaigns and actors are optional relationships. |
| `threat-intelligence` | security | This broad intelligence record is not restricted to a particular indicator or actor kind; requiring contained objects would turn aggregation into a prerequisite. |
| `secret` | security | Kubernetes explicitly permits secrets to be created independently of consuming pods; general passwords and tokens likewise need no existing code reference. |
| `license` | security | A reusable license definition does not depend on its licensed artifacts; those artifacts consume the terms. |
| `threat-actor` | security | Threat actor identity and characteristics are independent intelligence; requiring the consuming model would reverse their use. The cited RFC 9121 is unrelated, so STIX 2.1 section 4.17 is used as supplementary evidence. |
| `vulnerability` | security | An OSV advisory is independently identifiable by affected upstream package coordinates and version ranges. The catalogue code.package is a local service-manifest folder, not an upstream advisory package; no local checkout is required. |
| `weakness` | security | CWE is a reusable weakness taxonomy; requiring an observed vulnerability would invert the type/instance direction. |
| `product` | strategy | The product home identity is the starting statement, not a summary requiring its later parts to exist. |

## Fifteen examples and reasons

1. **`product` ← root (`[]`).** Product identity establishes the subject and audience before its goals, architecture or parts are described.
2. **`driver` ← `stakeholder`, `domain`.** A motivating condition is interpreted within a business domain and the concerns of affected stakeholders, before assessment or goal formation.
3. **`assessment` ← `driver`.** The assessment judges the motivating condition and its grounds; taking goals as mandatory inputs would create feedback into goal formation.
4. **`goal` ← `assessment`.** A desired state follows the assessed motivating condition; product, domain and driver are already reachable through the assessment, so no broad ancestor edges are added.
5. **`doc.requirement` ← `doc.use-case`.** A requirement states the provision needed in a concrete usage scenario. The use case already supplies the actor and intended goal, so no duplicate goal edge is added. Specification documents collect provisions later rather than preceding them as aggregates.
6. **`code.commit` ← `code.file`.** The repository change is filled against the files whose history it changes; the file already implies repository. This follows the owner-required file-before-commit order.
7. **`code.file` ← `code.repository`.** The repository supplies the identity of the versioned file; directory is not mandatory because a file may live at the repository root.
8. **`feature` ← `goal`.** A feature makes a stakeholder need concrete as a product service, so its goal is the input. An epic is an optional grouping, not a prerequisite for a standalone feature.
9. **`transition` ← `state`.** A transition needs its source and target states to say what change takes place; their machine is already implied by the states.
10. **`aggregate` ← `domain-entity`.** The aggregate consistency boundary requires at least its root entity and the identities it protects; repositories and factories are later mechanisms.
11. **`profile` ← `control`.** Tailoring selects identifiable controls from originating catalogs; the selected control already carries its catalog context.
12. **`processing-activity` ← `purpose`, `data-subject-category`, `personal-data-category`.** An Article 30 processing record must identify why processing occurs and whose categories of data it handles. Recipients and international transfers are not universal prerequisites because processing may involve neither.
13. **`training-run` ← `training-dataset`, `code.file`.** A training execution needs its input training data and the code file that runs training. Parameters and output are execution records; the output model is generated afterwards and must not be a prerequisite.
14. **`ml-model` ← `training-run`.** The local definition includes the data and code that produced the trained model. Its generating training execution is the nearest provenance input and already leads to those data and code. The model is the output, so the execution must not depend back on the output model.
15. **`evaluation-run` ← `ml-model`.** An evaluation judges an existing model against identified evaluation data. The metric is part of the run; training-dataset would wrongly require evaluation data to have trained the model. The dataset kind is already available transitively through ml-model, so it is not repeated as a direct kind prerequisite.

## Decisions and assumptions needing owner review

- `goal ← assessment ← driver ← stakeholder/domain ← product`: the nearest inputs retain the owner's motivation-chain example transitively, rather than repeat product/domain/driver on goal.
- There is no generic `scenario` kind. `doc.requirement ← doc.use-case` uses the catalogue's usage narrative; `doc.use-case` already derives from goal and actor. A pure quality requirement without a usage narrative is a known draft boundary. Requiring both use-case and quality-scenario would incorrectly encode alternatives as AND.
- `code.file ← code.repository` and `code.commit ← code.file` follow the owner's examples. This is semantic prerequisite drafting, not an assertion that Git extraction must scan commits after files.
- `feature ← goal`, not epic: standalone features do not need an artificial epic parent.
- The model definition explicitly includes the data and code that produced it, so `ml-model ← training-run` is retained. Imported provider provenance can supply that run; opaque pretrained models without provenance remain a limitation for owner review. Making model a root would also require restoring a direct evaluation dataset prerequisite.
- `evaluation-run` does not repeat dataset because its kind already exists through model/training-run/training-dataset. Training and evaluation datasets are distinct entity roles, even though the kind-level closure collapses them; fill logic still must choose the correct dataset.
- Polymorphic inputs such as a facet attached to dataset OR job OR run have no common catalogue superclass. They are explicit roots rather than false mandatory conjunctions; actual attachment remains instance-level validation.
- Generic roots (comment, request, snapshot, time-entry, schema vocabulary and reference taxonomies) are deliberate, not missing work. Every root is printed above so the owner can reject or refine it.
- Existing quarantine dependencies omit the redundant direct code.file prerequisite, already available through code.test-case and code.commit. Its fixture expectation is updated to the drafted nearest list, not weakened to a mere membership test.

## Validation

The final graph and quarantine contract tests pass: **4 passed, 0 failed, 11 assertions** (`sudo -u box env MADARCH_SKIP_PERF=1 bun test test/catalog-kind-dependencies.test.ts test/catalog-test-quarantine.test.ts`).

Before edits, the new test failed because **508 of 519** kinds lacked an explicit field (11 already declared it, including one root). The diff renderer's “Received +510” included array delimiters and was not the missing-kind count. A missing-field mutation and a repository/file dependency-cycle mutation both fail the intended checks, name full source paths, and were restored exactly.

Independent final semantic review checked all kinds, every root and the complete graph. No unknown references, cycles, self-edges or redundant direct ancestors remain. The final graph has **519 nodes, 548 edges and 60 roots**.

### Known integration blocker: this is a draft, not a merge-ready runtime change

`bun run check` passes TypeScript, architecture and UI checks, but fails `check:catalog`. The current parser at `src/product/manifest/kinds.ts:1512` deliberately leaves `template-policy: none` catalogue-only declarations out of its page/fill map. At `:2011–2016` it builds and validates dependencies against only that map. It therefore reports declared catalogue-only prerequisites such as `software-system`, `kind`, `protocol`, `goal` and `test-condition` as missing. The complete-catalogue test correctly sees them.

This is not a generator omission: the `everything` preset copies all 519 declarations. A parser-only acceptance change could hide a fill-scheduler incompatibility because `depends-on` currently also drives runtime discovery. This draft does not broaden parser, scheduler, page policies or starter selection; those decisions belong with the owner's field rename/integration. No dependencies were silently dropped to get green checks.

An intermediate six-file catalogue integration suite had **66 passed, 21 failed, 1,233 assertions** before the final semantic corrections. It exposed this policy-none mismatch plus two actual plugin-read constraints. The latter were fixed in the draft: `code.database` and `doc.term` retain `code.file` alongside their semantic context, because their bundled extractors read files. The latest full check retains the policy-none failures and is not represented as green. The earlier baseline native check passed before the draft data was applied.

Logs are scratch artifacts `/tmp/derives-last-check.log`, `/tmp/derives-final-graph.log`, and `/tmp/madarch-64o5.28-dependencies-{red,missing,cycle,green}.log`. Their retained outcome is recorded here rather than relying on scratch files at runtime.
## Complete per-kind rationale

The following table is the auditable draft, including each nearest list and its reason. Source evidence by section follows in sources.md.

| Section / kind | Prerequisites | Reason |
| --- | --- | --- |
| architecture / `process-gateway` | `process-model` | A branch or join is meaningful only within the process whose flow it controls. |
| architecture / `process-model` | `business-process` | The business process supplies the outcome and ordered work that the BPMN model formalizes; gateways and events are elaborations, not prerequisites of their parent model. |
| architecture / `state-machine` | `doc.term` | The modeled domain thing and its meaning must be identified before specifying its lifecycle; individual states are filled within the machine, not prerequisites of the machine. |
| architecture / `state` | `state-machine` | A state describes a condition of the subject governed by its state machine. |
| architecture / `transition` | `state` | A transition needs its source and target states to say what change takes place; their machine is already implied by the states. |
| architecture / `deployment-environment` | `software-system` | Staging or production is an environment of an identified software system; actual deployments and nodes need not yet exist. |
| architecture / `deployment-node` | `deployment-environment` | A hosting node is identified in a particular deployment environment; requiring a deployed container would invert the deployment planning order. |
| architecture / `infrastructure-node` | `deployment-environment` | A supporting node is described in its deployment environment; it need not host any application container. |
| architecture / `resource` | `[]` | A physical or virtual infrastructure resource can be identified independently from its consumers; requiring a component would make the consumer a prerequisite. Deployment and ownership links are later associations. |
| architecture / `architecture-description` | `software-system`, `stakeholder` | An architecture description needs its subject system and the stakeholders whose concerns it addresses; it can then be elaborated into views rather than waiting for all its parts. |
| architecture / `architecture-view` | `architecture-description` | A view addresses selected concerns of an architecture description; the catalog has no separate viewpoint kind, so viewpoint and model are content of this view. |
| architecture / `building-block-view` | `software-system` | The static decomposition starts from the identified system and its boundary; child blocks are discovered while filling the view, not a mandatory inverse aggregation. |
| architecture / `crosscutting-concept` | `solution-strategy` | A crosscutting concept develops a solution-wide approach such as persistence or logging selected by the solution strategy; individual consuming blocks are not prerequisites. |
| architecture / `deployment-view` | `deployment-environment`, `code.service` | Mapping software onto infrastructure requires the deployment environment and the deployable containers being mapped; nodes can be specified as part of that view. |
| architecture / `runtime-scenario` | `doc.use-case`, `component` | A runtime scenario explains a concrete use-case situation through identified participants and their interactions; the system scope is implied by those participants. |
| architecture / `solution-strategy` | `architecturally-significant-requirement`, `constraint` | The strategy chooses an approach against architecturally significant requirements and external constraints; later detailed decisions and implementation blocks do not have to exist first. |
| architecture / `aggregate` | `domain-entity` | The aggregate consistency boundary requires at least its root entity and the identities it protects; repositories and factories are later mechanisms. |
| architecture / `bounded-context` | `subdomain`, `doc.term` | A bounded context scopes a coherent model and ubiquitous language for a business subdomain; glossary terms provide the language whose boundary is being set. |
| architecture / `context-map-relationship` | `bounded-context` | The relationship needs the two bounded contexts at its ends; an enclosing map is a presentation, not a prerequisite. |
| architecture / `context-map` | `bounded-context` | The map inventories bounded contexts and can then record their relationships; requiring every relationship before the map would confuse completion with prerequisite. |
| architecture / `domain-entity` | `bounded-context` | An entity identity and continuity must have meaning within a bounded domain model; an aggregate may later group entities but is not needed to identify one. |
| architecture / `domain-event` | `bounded-context` | A domain event names something significant in the model language of its context; no particular aggregate or subscriber is required for every event. |
| architecture / `domain-repository` | `aggregate` | A domain repository represents a collection of aggregates and therefore requires the aggregate it retrieves and stores. |
| architecture / `domain-service` | `bounded-context` | The operation is a domain concept scoped by its model; its defining distinction is that it need not belong to an entity or value object, so neither is universally required. |
| architecture / `factory` | `bounded-context` | A domain factory needs the model defining the complex objects it constructs. Aggregates are a common target, but the definition also allows other complex objects, so an aggregate is not universal. |
| architecture / `subdomain` | `domain` | Classifying a core, supporting or generic subdomain requires the business domain being partitioned, not already implemented bounded contexts. |
| architecture / `value-object` | `bounded-context` | Attribute-based equality is defined in the bounded model language; no entity or aggregate must exist first for a value object such as Money. |
| architecture / `component` | `software-system` | The implemented software component needs its containing system scope; APIs and resources are details exposed, consumed or used by the component, not all mandatory precursors. |
| architecture / `software-system` | `product` | A product identity supplies the purpose and scope for the C4 system described from outside; containers and components are a later decomposition. |
| architecture / `external-interface` | `external-system` | An external interface needs the outside system offering it; protocols and payloads elaborate that provider-facing boundary. |
| architecture / `external-system` | `software-system` | Outside is relative to the subject system boundary; identifying the subject establishes why this communicating system is external. |
| architecture / `integration` | `external-interface`, `protocol` | The configured system link needs an offered outside interface and the protocol spoken; supplier agreements and deployment instances are not inherent prerequisites. |
| architecture / `paas-service` | `supplier` | The supplier-operated platform must have an identified supplier; actual product deployments onto that platform can come later. |
| architecture / `saas-service` | `supplier` | The externally operated software service needs its provider identified, before its interface or product integration is configured. |
| architecture / `technology` | `[]` | A language, framework or runtime can be identified from its published name and lifecycle independently of any product implementation; product usage is a later association. |
| automation / `business-process` | `goal` | A business process organises work toward a stated goal; its steps and BPMN drawings are later decomposition, not prerequisites. |
| automation / `process-step` | `business-process` | A step needs the business process whose work it advances; the process does not depend back on its steps. |
| code / `code.cycle` | `code.file` | The static import ring is established from the participating source files; module-level grouping is optional presentation rather than a mandatory second prerequisite. |
| code / `code.debt` | `code.file` | The TODO or FIXME is a located comment in a source file; actual technical debt is an interpretation, not a prerequisite. |
| code / `code.facet` | `code.file` | The language, role and parsing facts qualify an already identified file. |
| code / `code.input` | `code.file` | An external input is located at its entry into source code; not every input belongs to an HTTP route or named function. |
| code / `code.sql-build` | `code.symbol` | The SQL-building function must first be identified as a code symbol; the SQL sink is a later consumer, not a prerequisite. |
| code / `code.sql-sink` | `code.file` | The SQL execution call needs its source location; a call can occur at top level and need not have a separately known SQL builder. |
| code / `code.channel` | `code.contract` | This extractor fills topics or queues from their AsyncAPI contract, which supplies their scoped addresses; a running broker is not required by a contract. |
| code / `code.contract` | `code.file` | The catalog defines the contract specifically as an OpenAPI, gRPC or AsyncAPI file; endpoints and operations are derived from that file. |
| code / `code.message` | `code.channel` | The catalog defines the event shape as a message sent over an identified channel; the channel already implies its contract. |
| code / `code.operation` | `code.contract` | The operation is declared by its interface contract; implementation routes need not yet exist. |
| code / `code.route` | `code.service`, `code.file` | The route needs the providing service and source file from which its method, path and handler are read; an OpenAPI contract is optional. |
| code / `code.graphql-operation` | `code.graphql-schema-type` | A meaningful query, mutation or subscription is typed against the schema types it reads and returns; no implementation service is required. |
| code / `code.graphql-schema-type` | `[]` | A GraphQL type can be specified directly with its name and fields before any operation uses it. |
| code / `code.grpc-method` | `code.grpc-service` | An RPC is a named method of its protobuf service; the service definition supplies its scope, request and response message references. |
| code / `code.grpc-service` | `code.contract` | A protobuf service is declared in the gRPC contract file; its contained RPCs are filled afterward, avoiding inverse aggregation. |
| code / `code.json-schema` | `[]` | A JSON Schema can define and validate a standalone payload or configuration before any API, channel or dataset adopts it. |
| code / `code.sse-stream` | `code.service` | The stream needs the service that provides its EventSource resource; a separately catalogued HTTP route or message schema is not mandatory. |
| code / `code.webhook` | `code.contract` | The OpenAPI document declares callback/webhook request shapes; another operation is not mandatory because top-level webhooks can stand independently. |
| code / `code.websocket-endpoint` | `code.service` | The endpoint belongs to its providing service; RFC6455 handshake and messages do not require a separate OpenAPI contract. |
| code / `code.directory` | `code.repository` | The repository supplies the namespace for a folder path; contained files and subfolders follow it. |
| code / `code.entry-point` | `code.file` | The source file identifies where execution starts, including top-level scripts with no separately declared symbol. |
| code / `code.field` | `code.symbol` | A field is scoped by the declaring class, struct or interface code symbol, as its member presentation also specifies. |
| code / `code.file` | `code.repository` | The repository supplies the identity of the versioned file; directory is not mandatory because a file may live at the repository root. |
| code / `code.module` | `code.directory` | The module specialises an identified repository folder with a purpose; dependent modules and contained files do not reverse this prerequisite. |
| code / `code.package` | `code.directory`, `code.file` | This catalog narrows SPDX package to a folder containing a service manifest; folder scope and the manifest file establish it before its tests or service consumers. |
| code / `code.service` | `software-system` | A container is a deployable application or data-store boundary of an identified software system; contained packages and interfaces are later decomposition. |
| code / `code.symbol` | `code.file` | A function, class or constant needs the file that declares it; callers, callees and containing services are not mandatory. |
| common / `approval-package` | `kind` | A package must name the kind and intended content of what it creates or changes. No single concrete target kind is universal, and requiring an existing target entity would exclude creation packages. |
| common / `approval` | `approval-package` | Approval is a verdict on a specific pending package, not a status that can be filled before the proposed changes exist. |
| common / `comment` | `[]` | A comment is a primitive authored remark attachable to any entity kind; its target and author are instance references, and no one catalog kind is a universal prerequisite. |
| common / `external-reference` | `[]` | A remote system name, external key and URL can be recorded for any kind of thing; no particular local entity kind or configured integration is required. |
| common / `link` | `link-type` | The type declaration establishes allowed ends and labels for the connection; endpoint instances may have any of those declared kinds. |
| common / `operation` | `[]` | An operation is a primitive intended change, including creation of the first graph entity; requiring a preexisting entity or snapshot would prevent graph bootstrapping. |
| common / `request` | `[]` | A verbatim human request is primary input, including a request to create a product; derived work, approvals and changed entities must not be prerequisites of that input. |
| common / `snapshot` | `[]` | A restore point serializes the graph state even when empty; it need not have journal increments, a backup policy or any particular entity kind to be meaningful. |
| common / `source` | `code.commit` | The source text is a particular repository file at a recorded commit, not an unversioned attachment; both file identity and revision must be known. The code.file kind is already available transitively through code.commit, so it is not repeated as a direct kind prerequisite. |
| common / `time-entry` | `[]` | Time may be spent on any entity by a person or agent; duration and actor identity can be recorded without requiring a particular task or workflow kind. |
| common / `accounting` | `[]` | This is the reusable schema for per-step cost and outcome fields, not an execution record; actual steps, runs and their workflows consume the schema. |
| common / `event` | `[]` | An event name is a primitive trigger vocabulary entry; a transition consumes it, and requiring the transition first would invert the definition order. |
| common / `field-set` | `[]` | A reusable named field set is a schema building block; concrete kinds that compose it and instantiated entity values are consumers, not prerequisites. |
| common / `kind` | `product` | Kind declarations belong to the identified product manifest and give the concept meaning within it; reusable fields and optional workflows need not all exist first. |
| common / `lifecycle` | `kind`, `workflow` | Lifecycle attachment binds a declared authored kind to its workflow; statuses and transitions are already prerequisites of that workflow. |
| common / `link-behaviour` | `link-type` | Cardinality, backlink and copy/delete rules describe an existing link type rather than an untyped relation. |
| common / `link-type` | `kind` | Allowed endpoint kinds must be declared before a typed link schema can constrain which kinds it joins. |
| common / `responsibility` | `[]` | This is the reusable schema naming accountable and executing actors; actor instances can be people or agents, so no single actor kind is universally necessary to define the fields. |
| common / `template` | `kind` | The template describes a kind page, so the target kind and its page meaning must be known; page instances need not be generated yet. |
| common / `workflow-status` | `[]` | A named status is a primitive workflow vocabulary entry that can be declared before a transition or workflow uses it; this avoids a status/workflow containment cycle. |
| common / `workflow-transition` | `workflow-status`, `event` | An allowed move needs the source/target status names and the triggering event before its guard and move can be stated. |
| common / `workflow` | `workflow-transition` | A runnable named sequence needs defined transitions to express how its stages advance; transition prerequisites already supply statuses and events. |
| costs / `cloud-cost` | `cost-record`, `cloud-resource` | A cloud charge needs measured spend and the identified cloud resource charged. The general record supplies period and currency; no separate product edge repeats its context. |
| costs / `cost-allocation` | `cost-record` | Allocation splits an existing measured charge. Product, team and service destinations are alternatives, not three mandatory kinds; the cost record already supplies the product context. |
| costs / `cost-anomaly` | `cost-record` | A departure in spend must identify the measured charge being judged. Expected spend and the triggering resource can be recorded with the finding; a separately published forecast is not mandatory. |
| costs / `cost-record` | `product` | A measured resource charge needs the product whose spend is being recorded. Resources can be cloud, software or services, so requiring the cloud-resource kind would wrongly exclude other FOCUS records; resource identifier, period and currency remain record data. |
| costs / `license-cost` | `cost-record`, `license-agreement` | A licence charge needs a measured cost and the licensing agreement that makes the component charge meaningful. This is about payment terms, not merely an SPDX licence identifier. |
| costs / `llm-usage` | `ml-model` | A token-and-money use record needs the model used. Model and operation identity plus token counts are the telemetry basis; a separate aggregate cost record is a consumer of this measurement, not a prerequisite. |
| costs / `budget` | `product` | A spending limit needs the product scope to which it applies. A team can be an alternative scope and warning recipients are attributes or links; actual cost records and forecasts are not necessary to set a limit. |
| costs / `forecast` | `cost-record` | This definition explicitly computes expected costs from spend so far, so measured historical cost records are the nearest input. A budget is a target, not a prerequisite for prediction. |
| costs / `savings-plan` | `cost-record` | An expected saving needs the existing cost baseline that the proposed change reduces. A forecast, anomaly or budget can motivate it but none is necessary to describe the reduction. |
| data / `data-check` | `dataset` | A data check defines a rule against an identified dataset; execution and measured results follow the rule. |
| data / `data-facet` | `[]` | A facet requires an attachment, but that attachment may be a dataset, a job or a run. No single one of those kinds is mandatory for all facets. |
| data / `data-job-run` | `data-job` | A run is an occurrence of an identified job; the job already provides the dataset context, so no duplicate dataset edge is added. |
| data / `data-job` | `dataset` | For the catalog meaning of work consuming or producing data, the input/output dataset identity gives the job its data-processing subject; observed runs come later. |
| data / `data-quality-measurement` | `dataset` | A measured quality value needs the dataset it was computed on; its metric can be stated as a value because the catalog has no DQV metric kind, and a pass/fail data-check is not always a metric. |
| data / `data-catalog-entry` | `data-catalog`, `dataset` | The record registers one identified dataset in an identified catalog; it is metadata about the registration, not a duplicate dataset. |
| data / `data-catalog` | `[]` | The catalog can first be named with its publisher and scope before its optional catalog records are populated. |
| data / `data-contract` | `dataset` | The agreement fixes the shape, meaning and quality of an identified dataset; producer and consumer job inventories are not needed first. |
| data / `data-distribution` | `dataset` | A distribution is an accessible representation of an identified dataset; an API data service is only one possible access mechanism. |
| data / `data-entity` | `domain-entity` | The stored identity and attributes refine the domain entity being represented; relational tables are one implementation, not a required storage form. |
| data / `data-service` | `dataset` | The data-access interface needs the datasets it serves; it need not have a separately described distribution or application container. |
| data / `dataset` | `[]` | A namespace and name identify a discrete data collection before jobs, runs or catalog descriptions are observed. |
| data / `provenance-activity` | `provenance-entity` | For this catalog definition, the activity produces or changes an identified piece of data; agent attribution is optional and does not block recording the activity. |
| data / `provenance-agent` | `[]` | A provenance agent can be identified as a person, organisation or software agent independently of an activity attribution. |
| data / `provenance-entity` | `[]` | The data item whose origin is to be recorded can first be identified independently of knowing its producer. |
| data / `code.column` | `code.table` | The table supplies the namespace and schema context for a named column and its type. |
| data / `code.database` | `code.service`, `code.file` | The catalog defines this database as owned by a service; tables and migrations are later contents or changes, not prerequisites. Its bundled extractor reads code.file as an actual discovery input, so the file kind is also required, independently of the semantic subject context. |
| data / `code.index` | `code.table` | The index belongs to an identified table; covered columns or expressions are index detail, and PostgreSQL supports expression indexes without a standalone covered-column prerequisite. |
| data / `code.migration` | `code.database` | The schema-changing step needs its target database and the source migration file establishing its order and content; tables may be created by the migration. The file kind is available through database and is not repeated directly. |
| data / `code.table` | `code.database` | The database scopes the table; columns, indexes and reading code follow rather than creating a database/table/column cycle. |
| decommissioning / `data-destruction` | `decommission-plan`, `information-classification` | Select sanitization for the retiring system and its media using the confidentiality classification of the data; the plan establishes retirement scope, not the later retirement record. |
| decommissioning / `decommission-plan` | `software-system` | A retirement plan needs an identified system and its boundaries before preservation, migration and shutdown steps can be stated. |
| decommissioning / `deprecation` | `component` | A withdrawal announcement needs an identified product component whose removal and replacement can be communicated; it does not require retirement to have happened. |
| decommissioning / `retirement-record` | `decommission-plan` | The completion record is evidence against the retirement scope and disposition steps of the decommission plan, rather than an input to that plan. |
| delivery / `build-artifact` | `build` | The catalog defines this specifically as a build output; the producing build identifies what the digest describes, rather than requiring its later release or deployment. |
| delivery / `build-platform` | `[]` | A build service can be identified by its platform URI and trust boundary before any invocation is recorded. Builds consume this platform identity, not the reverse. |
| delivery / `build` | `code.commit`, `build-platform` | One invocation needs the source revision and the platform that executed it. Artifacts and byproducts are its outputs; requiring them would invert production. |
| delivery / `builder` | `build-platform` | The catalog means the identity used by a particular build platform; that platform scopes the identity. SLSA v1 treats builder.id as the platform trust base, not necessarily a workload account; no mandatory IAM account is assumed. |
| delivery / `byproduct` | `build` | A log or diagnostic artifact is a byproduct only relative to the invocation that emitted it. It is not a prerequisite of that invocation. |
| delivery / `code.compose-service` | `code.file` | The service name, ports and dependency declarations come from a Compose file. It need not have a locally built image, Dockerfile or an existing deployment. |
| delivery / `code.dockerfile` | `code.file` | The recipe is a particular repository file. The image it can produce is downstream and is not needed to describe the recipe. |
| delivery / `code.image` | `[]` | Registry repository plus tag or digest identifies an image, including a third-party image whose source and build are unknown. No local Dockerfile, build or running deployment is required. |
| delivery / `feature-flag` | `product` | The switch needs the product whose behavior it changes. Providers serve flags but do not define their business identity; variants and targeting rules refine the switch later. |
| delivery / `flag-evaluation-context` | `product` | Runtime, caller and subject facts belong to the product using flag evaluation. OpenFeature permits shared/global context before a particular flag or targeting rule exists, so neither is required. |
| delivery / `flag-provider` | `[]` | A provider is independently identifiable as an SDK-compliant adapter to a flag management system. It can be configured before the catalog holds any flag definitions. |
| delivery / `flag-rule` | `flag-variant`, `flag-evaluation-context` | A rule chooses an identified flag variant by applying criteria to evaluation facts. The variant already brings the flag context, so a separate flag edge is redundant. |
| delivery / `flag-set` | `flag-provider`, `flag-evaluation-context` | The local definition scopes the collection to a provider and a context. Those define which collection it is; its individual flags are members, not fill prerequisites. |
| delivery / `flag-variant` | `feature-flag` | A value identifier and its type only have meaning for a particular flag. Rules consume variants and therefore must not be prerequisites here. |
| delivery / `gitops-application` | `gitops-source`, `desired-deployment` | The application ties a Git-held source to a desired deployed state. Reconciliation is subsequent activity; the source revision and desired state already provide repository and deployment context. |
| delivery / `gitops-reconciliation` | `gitops-application`, `observed-deployment` | Comparison and correction need the managed application with its source/desired state, and the actual state being compared. The desired state is already an application prerequisite. |
| delivery / `gitops-source` | `code.commit` | Repository/path/revision must identify a particular recorded revision. The commit supplies its repository context; an application that later reads the source is not required. |
| delivery / `code.ci-job` | `code.ci-workflow` | A job is named and interpreted within its workflow. Its run and worker are later execution facts, not prerequisites for declaring the job. |
| delivery / `code.ci-workflow` | `code.file` | This catalog kind is the workflow file and its triggers, so the repository file is the nearest source. Jobs are children described later, not prerequisites of the workflow. |
| delivery / `code.make-target` | `code.file` | A target and its recipe are read from a particular Makefile. A pipeline or a successful build need not exist to identify that target; the cited GNU manual could not be accessed (403). |
| delivery / `pipeline-run` | `code.ci-workflow`, `code.commit` | An execution needs the workflow it executes and the revision it runs against. Results, duration and jobs executed are filled as execution facts, not prior conditions. |
| delivery / `runner` | `[]` | OpenTelemetry gives a worker its own ID, name, URL and available/offline state. It can be registered before any pipeline task is assigned. |
| delivery / `change` | `code.commit` | The local definition starts at the first commit, so an underlying recorded change in repository history is needed. Production deployment is a downstream milestone, not a prerequisite. |
| delivery / `deployment` | `release`, `deployment-environment` | Putting a version into a location needs the released version and the target environment. Desired and observed state describe the action afterward and do not precede its identity. |
| delivery / `desired-deployment` | `deployment` | The requested state belongs to the deployment that asked for it, which already identifies version and target. GitOps source and observed state are possible evidence/comparands, not universal prerequisites. |
| delivery / `helm-release` | `code.file`, `k8s-namespace` | A named Helm installation needs its chart definition (represented by a repository file; no chart kind exists) and its namespace, which supplies cluster context. It is not synonymous with a product release. |
| delivery / `observed-deployment` | `deployment` | This is the platform-reported state for the deployment in its environment. The deployment supplies target/version context; it must not require a desired-state comparison to record actual state. |
| delivery / `release-gate` | `release`, `acceptance-criterion` | A gate applies an acceptance condition to a release before promotion. It can be defined before test runs or deployments and need not consume a particular test-report kind. |
| delivery / `release` | `change` | The released product version is described through the changes it carries. Those commits already lead to repository/product context; neither tags nor a particular artifact format is universally required. |
| delivery / `rollout` | `desired-deployment` | The staged replacement strategy refines the state requested for a deployment. Pauses and surge/unavailable limits govern reaching that state; the observed outcome comes later. |
| delivery / `tag` | `code.commit` | A tag fixes a name to an identified revision. It is not a release and does not require a build or release consumer. |
| delivery / `attestation` | `in-toto-statement` | The authenticated envelope wraps a statement. That statement already supplies the subject artifact, so repeating a subject edge is unnecessary; provenance is only one possible predicate. |
| delivery / `in-toto-statement` | `build-artifact` | A statement binds a typed predicate to an identified subject artifact. The attestation authenticates it later and is not a prerequisite of the enclosed claim. |
| delivery / `provenance` | `build-artifact` | The record explains the production of a digest-identified output artifact; that subject already leads to its producing build and platform. An envelope or attestation is a later authentication wrapper, not a prerequisite. |
| design / `accessibility-conformance-report` | `accessibility-evaluation` | A grounded product conformance report summarizes evaluated outcomes; criteria and evaluated resource scope are already carried by the evaluations. |
| design / `accessibility-evaluation` | `accessibility-success-criterion` | A recorded accessibility evaluation needs the test criterion. Its subject can be a screen, component or other resource; no single subject kind is mandatory across all evaluations, so a screen is not forced. |
| design / `accessibility-rule` | `accessibility-success-criterion` | This catalog narrows ACT rules to repeatable checks of a WCAG success criterion; the normative requirement must precede its test procedure. |
| design / `accessibility-success-criterion` | `[]` | The numbered WCAG success criterion is imported normative vocabulary, with its A/AA/AAA level; product screens and evaluations apply it later. |
| design / `locale` | `[]` | A language/region and formatting convention can be imported directly from CLDR; translated product text is a consumer, not a prerequisite of identifying a locale. |
| design / `message` | `[]` | A source message and its placeholders can be authored before choosing any target language or screen; locale translations and UI usage are later associations. |
| design / `translation-file` | `message`, `locale` | A translation interchange file needs the source message units and source/target language context; the file is an aggregate of translations rather than their source of meaning. |
| design / `asset` | `[]` | An image, icon or font resource can be identified and supplied before any screen uses it; requiring a screen would make the consumer a prerequisite. |
| design / `frontend-route` | `screen` | The client-side address must identify the screen it renders; individual operation calls are optional implementation details rather than universal prerequisites. |
| design / `screen` | `doc.use-case` | A reader-facing page/view must support an identified user task or interaction situation; routing, reusable component extraction and mockups are elaborations rather than required prior consumers. |
| design / `style` | `design-token` | This catalog explicitly defines styles as rules referring to tokens; the named values precede their rule-based application, while component consumers can be added later. |
| design / `design-frame` | `product` | A product design frame specifies a screen or reusable component; these are alternative subjects, so requiring either concrete kind would exclude the other. Product design scope is the common prerequisite, not prior implementation. |
| design / `design-system` | `design-token` | A product design system starts from its shared visual vocabulary and rules, then grows reusable components; components need not all exist before the system is defined. |
| design / `story` | `ui-component` | CSF stories are named rendered states of an identified component with supplied arguments; the component is their subject. |
| design / `ui-component` | `[]` | A reusable UI unit can have its own API and rendering behavior before a design system, screen or story adopts it; requiring those consumers would reverse composition. |
| design / `design-token` | `[]` | An atomic named design value is a design vocabulary primitive; groups, sets, styles and components collect or consume it later. |
| design / `token-group` | `design-token` | A token group organizes defined design values; nested groups are optional and must not introduce recursive kind prerequisites. |
| design / `token-set` | `design-token` | The resolver selects named collections of token values for contexts; explicit groups are optional, so tokens are the nearest universal input. |
| discovery / `usability-finding` | `usability-test` | A usability problem must be grounded in the observed session that demonstrated it; an already filed defect or fix is not a prerequisite. |
| discovery / `usability-test` | `research-question`, `user-flow` | A session needs a research purpose and user task flow to ask participants to perform; findings are recorded afterwards. The flow supplies actor and scenario context without redundant product edges. |
| discovery / `touchpoint` | `user-journey` | A touchpoint is located within an already framed journey; it does not require a screen because contact can occur outside the software. |
| discovery / `user-flow` | `doc.use-case` | The flow expands an actor’s product-use scenario into steps towards its outcome, before any concrete screen implementation is necessary. |
| discovery / `user-journey` | `job-to-be-done` | A journey frames the job/outcome being pursued and the actor viewpoint already supplied by that job. Touchpoints are derived detail, and a duplicate actor edge is omitted. |
| discovery / `interview` | `research-question`, `actor` | An interview records a participant’s answers to a research question; synthesized findings and personas are outputs and are not prerequisites. |
| discovery / `observation` | `research-question`, `actor` | Contextual observation needs the question and the actor whose real work is observed; the resulting interpretations come after the observation. |
| discovery / `research-finding` | `research-question` | A finding answers the study question with grounds. Interview, observation, survey and usability sessions are alternative evidence methods, so requiring all would wrongly block other research. |
| discovery / `research-question` | `product` | A research question identifies an uncertainty about the product or its audience before selecting a method or collecting findings; goals need not be established before discovery. |
| discovery / `survey` | `research-question` | The survey operationalizes a research question for many respondents; answers and findings are produced by it, not needed to define it. |
| documentation / `administrator-guide` | `deployment-environment` | Administrator instructions need the target operating environment whose setup and protection they explain; deployment executions and all possible incidents are not prerequisites. |
| documentation / `api-reference` | `code.contract` | The generated reference needs the authoritative interface contract declaring operations and payloads; consumers and running endpoints do not have to exist first. |
| documentation / `architecture-section` | `architecture-description` | A named arc42 section needs the architecture description it organizes; it does not require every eventual block or view before the section can be filled. |
| documentation / `changelog` | `release` | An ordered account of changes between releases needs identified release boundaries; a standalone unreleased heading can be empty but is not a filled release history. |
| documentation / `code.document-section` | `document` | A heading and its extent only have identity within their source document; requirements extracted from it are consumers, not prerequisites. |
| documentation / `document` | `code.file` | The YAML binds each page to a Markdown repository file at a pinned revision; the file supplies source identity, not a requirement inferred from the page. |
| documentation / `guide` | `doc.use-case` | An outcome-oriented walkthrough needs the task and actor/system interaction it guides, not an already published generic document of which it would merely be a subtype. |
| documentation / `how-to` | `doc.use-case` | Problem-solving instructions need the concrete task the person must accomplish; a tutorial is not a prerequisite because Diataxis separates learning from doing. |
| documentation / `release-notes` | `release` | Release notes explain the user-visible changes of one identified release; they need not wait for a cumulative changelog. |
| documentation / `tutorial` | `doc.use-case` | The lesson needs a concrete achievable piece of product work to teach; prior user guides or how-to documents are optional related documentation. |
| documentation / `user-guide` | `doc.use-case` | A grounded user guide needs the supported tasks and outcomes it explains; implementation routes can support its evidence without making every interface kind mandatory. |
| documentation / `correction` | `document` | A correction must target an existing written statement; source documents provide that statement, while its resolved revision comes later. |
| documentation / `enrichment` | `code.document-section`, `code.symbol` | The YAML describes code-grounded elaboration beside a person-authored use case, rule or decision: it needs the original document statement and the code behavior supporting the added explanation. |
| documentation / `problem-dismissal` | `document` | The implemented record names a rule, finding identity and place in documentation; a source document grounds that place. No one security/test finding kind covers the generic wiki findings, so none is forced. |
| documentation / `code.newcomer-command` | `document` | The extractor reads a newcomer command from the README; the source document must exist before that command can be stated as something the README prescribes. |
| documentation / `code.newcomer-failure` | `document` | This kind is explicitly a symptom and fix named by the README, not every runtime failure; its documentary source is the prerequisite. |
| documentation / `code.newcomer-prerequisites` | `document` | These are the required tools as declared by the README; published technology identities alone do not establish that the README requires them. |
| documentation / `faq` | `product` | A frequently asked question can be authored directly for the identified product; historical support requests are useful evidence but not mandatory before answering a common question. |
| documentation / `known-issue` | `product` | A communicated limitation may be an intentional product constraint rather than a test defect; product scope is needed, but forcing a defect report would narrow the definition. |
| documentation / `support-answer` | `support-request` | A support answer and its resolution outcome need the particular question or problem raised first. |
| documentation / `support-request` | `product` | A support question or problem needs the product it concerns; it need not already have a diagnosed defect, incident or known issue. |
| documentation / `troubleshooting-guide` | `code.newcomer-failure` | The guide organizes known symptoms and fixes; those failure descriptions supply its diagnostic content, rather than an undifferentiated generic document. |
| history / `code.repository` | `[]` | The VCS repository URL/name identifies a tree and history independently of any particular file, branch or commit. |
| history / `remote` | `code.repository` | A remote is the publication/fetch address configured for an identified repository. |
| history / `branch` | `code.commit` | A movable branch name identifies a line of commits; the named commit already provides its repository context. |
| history / `code.author` | `code.commit` | This catalog records authors discovered from commits, not a general personnel directory; those commits supply the name and email evidence. |
| history / `code.commit` | `code.file` | The repository change is filled against the files whose history it changes; the file already implies repository. This follows the owner-required file-before-commit order. |
| history / `code.snapshot` | `code.commit` | The landmark fixes a point in repository history by its commit; that commit already implies files and repository. |
| history / `code.task` | `code.commit` | This kind is specifically a task reference extracted from commit messages, not an independently planned work item; the commit supplies the reference evidence. |
| history / `pull-request` | `code.commit` | The proposed repository change is identified through its commit set; reviews are subsequent evidence, not prerequisite consumers. |
| information / `communications-secrecy` | `information-category` | Secrecy of communications is a protected class of information about communications, not necessarily personal data; the handled-information category supplies its product scope. |
| information / `information-category` | `product` | A product-specific handled-information category needs the product handling scope; individual stored fields and flows are later classified by it. |
| information / `information-classification` | `[]` | A classification level and its disclosure meaning can be declared as policy vocabulary before any information is assigned to it; classified items consume the level. |
| information / `personal-data` | `information-category` | In this product catalog personal data specializes a handled-information class using the Article 4 identifiability test; individual data subjects or processing activities are not required to define that class. |
| information / `special-category-data` | `personal-data` | Article 9 concerns the specially protected subset of personal data, so personal-data meaning precedes the more restrictive classification. |
| information / `trade-secret` | `information-category` | Trade secrecy applies to a handled-information class whose commercial value and secrecy measures justify protection; it is not necessarily personal data or a particular disclosure level. |
| information / `information-flow` | `doc.term` | A movement must identify what information moves using the product glossary; the flow can then be populated with item records without depending on its own children. |
| information / `information-item` | `information-flow` | An item is a particular member carried by a flow; that flow already requires the glossary vocabulary naming what is carried, so the glossary edge is not repeated. |
| infrastructure / `cloud-resource` | `deployment-environment`, `technology` | Describe the resource in its deployment environment and identify the provider platform whose resource type gives the object meaning; a Terraform implementation is not required. |
| infrastructure / `code.process` | `code.service` | A started program is an execution of an identified deployable unit; its command and listening ports describe that runtime, without requiring a separate port record first. |
| infrastructure / `kubernetes-cluster` | `deployment-environment` | A cluster must be situated in a deployment environment; its nodes are subsequent inventory, not prerequisites for describing the control-plane boundary. |
| infrastructure / `kubernetes-node` | `kubernetes-cluster` | A node record identifies a machine as a member of a particular Kubernetes control-plane domain; node pools are optional grouping, not mandatory prerequisites. |
| infrastructure / `node-pool` | `kubernetes-cluster` | A node pool is a scaling and machine-shape grouping within an identified cluster; individual node records need not exist to describe the pool. |
| infrastructure / `server` | `deployment-environment` | A machine inventory entry needs its deployment context to distinguish the host and its available resources; a cloud provider or Kubernetes cluster is not universally required. |
| infrastructure / `iac-variable` | `terraform-module` | An input variable is the input interface of an identified Terraform module, including a root module; no resource consumer is required first. |
| infrastructure / `terraform-module` | `code.repository` | A reusable Terraform configuration must be located in an identified source repository; resources and variables are its contents, not prerequisites to describing the module boundary. |
| infrastructure / `terraform-provider` | `terraform-module` | A provider requirement or configuration is declared in a Terraform configuration module; the resources it enables are downstream, avoiding a provider/resource cycle. |
| infrastructure / `terraform-resource` | `terraform-provider` | The provider defines the resource type and its argument semantics; a managed object cannot be described meaningfully without that type context. |
| infrastructure / `terraform-state` | `terraform-module` | State maps a configuration workspace to managed objects; identify its root configuration module first. Individual resource records are not required because an initialized state may be empty. |
| infrastructure / `certificate` | `key-material` | A certificate binds an identified public key to a subject identity; key material is essential, while a DNS-name record is not universal because X.509 subjects are not limited to DNS. |
| infrastructure / `code.port` | `code.service`, `protocol` | A listening or published port needs the service that owns it and its transport protocol; this avoids requiring a process record that itself describes its ports. |
| infrastructure / `dns-record` | `domain-name` | A DNS resource record has an owner name and type-specific data, so the named DNS identity comes first; address ranges and certificates are not universal inputs. |
| infrastructure / `domain-name` | `product` | The product-facing network name must identify the product it represents; DNS records implement the name and are not prerequisites to stating it. |
| infrastructure / `ip-range` | `deployment-environment` | A product address allocation needs the environment in which that range is used; a zone or a firewall is a possible consumer, not a prerequisite. |
| infrastructure / `protocol` | `[]` | A protocol is an independently defined agreement such as HTTP or SMTP; its rules can be described before any product endpoint, port or deployment exists. |
| infrastructure / `firewall-rule` | `network-zone`, `protocol` | An allow/deny rule needs its controlled network boundary and the protocol whose traffic it matches; individual security-group or IP-range entries are optional representations. |
| infrastructure / `load-balancer` | `code.service` | Traffic distribution must name the deployable service being exposed and balanced; its individual targets can be recorded later and need not all be inventoried first. |
| infrastructure / `network-zone` | `deployment-environment` | A trust-level network subdivision needs the environment whose traffic boundary it controls; firewall rules and attached resources are downstream descriptions. |
| infrastructure / `proxy` | `code.service`, `protocol` | A forwarding component needs the service context and protocol semantics under which it forwards or changes messages; a load balancer or WAF is not universally required. |
| infrastructure / `security-group` | `network-zone` | A named cloud-network policy attachment needs its network boundary first; constituent firewall-rule records are contents, not prerequisites for naming the policy set. |
| infrastructure / `waf` | `external-interface` | An attack-pattern filter needs the protected externally reachable service interface; neither a proxy implementation nor a full threat model is mandatory to identify that protection. |
| infrastructure / `code.k8s-deployment` | `k8s-namespace`, `code.image` | A Deployment describes a namespaced pod template and its images before actual pods exist; depending on generated pod records would reverse the controller relationship. |
| infrastructure / `code.k8s-service` | `k8s-namespace`, `code.service` | A Service needs its namespace and the application whose endpoint and selectors it defines; actual selected pods may not exist, and selectorless Services are valid. |
| infrastructure / `k8s-autoscaler` | `k8s-namespace`, `code.service` | An HPA needs its namespaced identity and identified application workload to define its scale target and limits; Deployment and StatefulSet are alternative realizations, so neither specific controller kind is universally required. |
| infrastructure / `k8s-configmap` | `k8s-namespace` | A ConfigMap has namespaced configuration identity independently of the pods that later consume it; requiring consumers would create a configuration/workload cycle. |
| infrastructure / `k8s-cronjob` | `k8s-namespace`, `code.image` | A CronJob needs its namespace and executable image template; its generated Jobs and their runs are later results, not prerequisite instances. |
| infrastructure / `k8s-daemonset` | `k8s-namespace`, `code.image` | A DaemonSet needs the namespaced container template it schedules; matching node instances are runtime placement results and need not be inventoried first. |
| infrastructure / `k8s-ingress` | `code.k8s-service` | An Ingress rule needs the backend Service whose external HTTP routing it defines; the Service already provides namespace and application context. |
| infrastructure / `k8s-job` | `k8s-namespace`, `code.image` | A run-to-completion workload requires its namespace and executable image template; neither a CronJob nor existing child Pods is mandatory for a one-off Job. |
| infrastructure / `k8s-namespace` | `kubernetes-cluster` | A namespace scopes names and quotas inside one cluster; its workloads and configuration objects are consumers, not prerequisites. |
| infrastructure / `k8s-pod` | `k8s-namespace`, `code.image` | A pod needs its namespaced identity and the container image definition it runs; workload controllers create pods but are not required for standalone pods. |
| infrastructure / `k8s-secret` | `k8s-namespace`, `secret` | A Kubernetes Secret needs its namespace and the sensitive value or secret identity being represented; pods are consumers and are not prerequisite inventory. |
| infrastructure / `k8s-statefulset` | `k8s-namespace`, `code.image` | A StatefulSet defines a namespaced container workload with stable identity and storage templates before instances exist; existing pods and volumes are not prerequisite records. |
| messaging / `cache-key` | `cache` | The cache supplies the namespace and storage context of a key; lifetime is an attribute, not a prerequisite policy object. |
| messaging / `cache-policy` | `cache` | The policy constrains the identified cache whose write, reuse and eviction behaviour it defines; cache does not depend back on its policy description. |
| messaging / `cache` | `[]` | A cache store can be identified by its address or configuration before keys, policies or consuming services are catalogued. |
| messaging / `code.broker` | `[]` | A broker can be identified from its connection settings or deployment declaration before topic or subscriber inventories exist. |
| messaging / `subscription` | `code.channel`, `code.service` | A subscription needs both the addressed topic/queue and the subscribing service; delivery rules refine that standing interest. |
| messaging / `email-message` | `code.service`, `notification-template` | The catalog specifies service-sent email with a template, so the sender service and notification text template precede filling the message; recipients remain message attributes. |
| messaging / `notification-template` | `[]` | Notification text and placeholders can be authored independently of any sending implementation or sent message. |
| messaging / `push-message` | `code.service` | The message is a notification sent by an identified service to a user agent; no mandatory notification-template or broker kind follows from RFC8030. |
| messaging / `sms-message` | `code.service` | The short message belongs to its sending service; SMPP sender addresses and concatenated parts are values, not separate catalog prerequisites. |
| messaging / `block-volume` | `server` | This catalog defines an attached block device, so the server supplies its attachment context; the filesystem built on it is downstream. |
| messaging / `bucket` | `object-store` | A named bucket is scoped by its object store; contained objects and consuming services are not prerequisites. |
| messaging / `file-share` | `[]` | A network filesystem export can be identified by its network address and exported path independently of clients. |
| messaging / `object-store` | `[]` | An object storage service can be identified by its endpoint before buckets or clients are populated. |
| messaging / `sftp-endpoint` | `[]` | The file-transfer endpoint can be identified by host, port and path before services use it. |
| ml / `evaluation-result` | `evaluation-run` | Measured evaluation values and comparison thresholds belong to a particular evaluation execution. That execution already identifies model and dataset, so repeating those edges would be transitive. |
| ml / `evaluation-run` | `ml-model` | An evaluation judges an existing model against identified evaluation data. The metric is part of the run; training-dataset would wrongly require evaluation data to have trained the model. The dataset kind is already available transitively through ml-model, so it is not repeated as a direct kind prerequisite. |
| ml / `ml-model` | `training-run` | The local definition includes the data and code that produced the trained model. Its generating training execution is the nearest provenance input and already leads to those data and code. The model is the output, so the execution must not depend back on the output model. |
| ml / `model-card` | `evaluation-result` | The card documents a model and its evaluation, not only a model name. Evaluation results supply the evidence and transitively identify the evaluated model; purpose and limitations are authored card content. |
| ml / `training-dataset` | `dataset`, `license` | Training data need an identified collection and the licence governing its use, as the local definition and SPDX dataset profile require. A model is a later consumer of the training data, not their prerequisite. |
| ml / `training-run` | `training-dataset`, `code.file` | A training execution needs its input training data and the code file that runs training. Parameters and output are execution records; the output model is generated afterwards and must not be a prerequisite. |
| ml / `ai-impact-assessment` | `stakeholder`, `ai-system` | An impact study needs the AI system being studied and the people or groups whose interests and welfare it affects. It can discover risks and propose measures, so neither completed risk records nor incidents are prerequisites. |
| ml / `ai-incident` | `ai-system` | A harm or near miss must identify the AI system that caused it. An incident can reveal a previously unknown risk, so a pre-existing risk assessment is not mandatory. |
| ml / `ai-risk` | `ai-system` | Likelihood and consequences need the AI system whose use can cause harm. A completed impact assessment is evidence that may later refine the risk, not a mandatory earlier record. |
| ml / `ai-system` | `ml-model` | The local definition specifically identifies a system by its use of a model to make or support decisions. Its model is the nearest prerequisite; an impact assessment is a later analysis of this system. |
| operations / `alert-group` | `alert-route` | A notification batch is defined by the route grouping labels and timing; receivers and individual fired-alert instances are not additional prerequisites. |
| operations / `alert-notification-target` | `product` | A notification destination needs the product operational context that owns the channel or paging integration; routes and alert rules are consumers and need not exist yet. |
| operations / `alert-route` | `alert-notification-target` | A label-routing rule must have an identified notification receiver; matching rules can be stated before any particular alert fires. |
| operations / `alert-rule` | `code.metric` | A metric-based alert condition must refer to an identified metric and its semantics before a meaningful threshold and duration can be written; notification routing is downstream. |
| operations / `escalation-policy` | `on-call-schedule` | The escalation order and waiting times need the responding people or rotations and contact coverage defined by the on-call schedule; no incident must have happened first. |
| operations / `on-call-schedule` | `team` | A time-based response rota requires the responsible team and its members; escalation policy consumes that rota and must not be its prerequisite. |
| operations / `change-record` | `deployment-environment` | A record of an applied change requires the environment in which it happened; a release or upgrade is one possible change source, not a universal prerequisite. |
| operations / `database-change` | `code.database` | Schema or data change and rollback must identify the affected database first; a migration implementation or Kubernetes Job is optional. |
| operations / `maintenance-window` | `code.service` | A planned unavailability period must name the affected service; a deprecation, incident or completed change is not required to schedule maintenance. |
| operations / `upgrade` | `technology` | An upgrade needs the technology or platform identity and version lifecycle being advanced; its required prior versions are attributes rather than separate kinds. |
| operations / `code.env-definition` | `code.env-var` | An assignment needs the named environment setting it gives a value to; depending the read-side setting on its assignment as well would create a cycle. |
| operations / `code.env-var` | `code.file` | An environment setting read by code needs the file that reads it and gives the setting purpose; definitions supply its values later and are not prerequisites for identifying the variable. |
| operations / `code.dependency` | `code.manifest` | A declared library dependency gets its package context and requested version from the manifest; a resolved lockfile is optional and downstream. |
| operations / `code.lockfile` | `code.manifest` | A lockfile resolves the declarations of a package manifest into exact versions; requiring all individual dependency records would unnecessarily invert aggregate filling. |
| operations / `code.manifest` | `code.package` | A dependency manifest declares an identified package; its dependency entries are contents and need not already have separate records. |
| operations / `action-item` | `postmortem` | The corrective work must trace to the postmortem conclusion that calls for it; its tracked implementation is a consumer of that finding. |
| operations / `incident-timeline` | `incident` | Detection, acknowledgement, mitigation and resolution times are facts about an identified incident; a completed postmortem is not required. |
| operations / `incident` | `code.service` | An incident needs the service whose users or operation are harmed; timeline and postmortem are later descriptions, not prerequisites for reporting the event. |
| operations / `postmortem` | `incident` | An account of impact, causes and follow-up needs the incident it analyses; timeline and action items may be included without requiring separate child records beforehand. |
| operations / `response-record` | `incident` | Actions and responders are recorded against an identified active incident, before the retrospective postmortem exists. |
| operations / `job-result` | `job-run` | Output or completion status must be attached to the particular execution that produced it; making the run require this result would create a feedback cycle. |
| operations / `job-run` | `scheduled-job` | A run is one execution of an identified scheduled job; a separate schedule record is not required because manual executions of scheduled work are possible. |
| operations / `job-schedule` | `scheduled-job` | Timing, frequency and execution limits belong to an identified unit of scheduled work; job runs consume the schedule, not the reverse. |
| operations / `scheduled-job` | `code.service` | Scheduled work must identify the application that executes it; its timetable and execution history are details that can be filled afterward. |
| operations / `code.logger` | `code.file` | The logging setup is a location in service code, so identify the source file before documenting its initialization and configuration. |
| operations / `code.metric` | `code.file` | A declared instrument and its updating code need their source-file context; dashboards, alerts and exporters consume the measurements rather than defining the instrument. |
| operations / `dashboard-panel` | `dashboard` | A query visualization is one panel in an identified dashboard; the parent provides observed subject context and does not depend on its child panels. |
| operations / `dashboard` | `telemetry-resource` | A dashboard requires an identified observed subject; its panels and queries are its contents and not prerequisite records. A resource identifies the telemetry subject without requiring particular signal types. |
| operations / `log-record` | `telemetry-resource` | A timestamped service event must identify its emitting resource; a particular logger setup record is not required because existing or bridged logs are valid. |
| operations / `span` | `telemetry-resource` | A timed operation needs its emitting service resource; no parent-span kind edge is added because root spans have no parent and self-dependency would be invalid. |
| operations / `telemetry-pipeline` | `telemetry-resource` | The collection, processing and export path needs identified emitting resources; separate log, span and metric records are optional signals, not jointly mandatory inputs. |
| operations / `telemetry-resource` | `code.service` | Service-name and runtime attributes identify the deployable service emitting telemetry; individual host, process or signal records are optional refinements. |
| operations / `code.health-endpoint` | `code.route` | A health endpoint is a particular HTTP route with liveness semantics; probes are consumers and cannot be prerequisites to the route they call. |
| operations / `code.healthcheck` | `code.compose-service` | The configured health command and timing belong to a Compose service; a network health endpoint is optional because commands may inspect the container locally. |
| operations / `code.metrics-endpoint` | `code.route` | A metrics endpoint is an HTTP route that exposes measurements; exporter-generated metrics do not require individual instrument records to be filled first. |
| operations / `code.probe` | `k8s-pod` | Readiness, liveness or startup checks are container settings within an identified pod specification; an HTTP endpoint is not mandatory because exec and TCP probes are valid. |
| operations / `error-budget-policy` | `slo` | The error allowance and response policy derive from the service target and its time window; budget consumption is not defined without the SLO. |
| operations / `sla` | `slo` | An agreement promises service-level objectives and consequences for missing them; the targets must be identified before the promise can be meaningful. |
| operations / `sli` | `code.service` | A user-perceived quantitative indicator needs the service being measured; neither an SLO threshold nor a particular instrumentation implementation is required to define it. |
| operations / `slo` | `sli` | A reliability target is a value or range and time window over an identified SLI; reversing this direction would confuse the measure with its target. |
| organisation / `accountability` | `business-role` | An accountability describes what a role answers for; actual assignments and performed work are evidence of fulfillment later, not prerequisites to the responsibility statement. |
| organisation / `business-role` | `organization` | A business role specifies a function in an identified organisation; individual people filling the role are subsequent memberships. |
| organisation / `membership` | `user`, `business-role`, `team` | A membership binds an identified person to a group and role for a period; it must not be used as an input to create that person, role or group. |
| organisation / `user` | `[]` | A user identity can be recorded independently of group membership or ownership of a product element. |
| organisation / `assignment` | `task`, `user` | Giving work to a person requires the scoped work and assignee identity; the resulting execution record does not precede assignment. Group assignment is an alternative target, not a reason to require every team. |
| organisation / `owner` | `product` | An owner is described by accountability for the identified product scope; the person or group may be named in this record without requiring both user and team kinds as mandatory inputs. |
| organisation / `ownership-assignment` | `owner` | The ownership assignment adds the target and effective time to a known accountable owner; treating assignments as inputs to owner identity would create a cycle. |
| organisation / `department` | `organization` | A unit is a subdivision of an identified organisation; teams and member records do not need to exist before the unit is described. |
| organisation / `organization` | `[]` | An organisation can be named and its collective purpose stated before units, roles or memberships are enumerated. |
| organisation / `team` | `organization`, `product` | The team is identified within an organisational setting and by the product responsibility it shares; membership is filled afterwards, not a prerequisite aggregate. |
| privacy / `assessment-plan` | `system-security-plan` | An OSCAL assessment is scoped to a system implementation and its controls; the SSP supplies both before assessment methods and responsibilities are planned. |
| privacy / `assessment-result` | `assessment-plan` | The results record performance, scope, evidence and findings for the assessment activities specified by a plan, rather than requiring the later remediation plan. |
| privacy / `component-definition` | `profile`, `component` | Describing how a component satisfies a selected baseline requires that component and the tailored profile; the consuming system-security plan is not a prerequisite. |
| privacy / `control-catalog` | `[]` | A control catalog is the authoritative control vocabulary from which profiles select; it does not require an implementation or a pre-existing collection of separate control pages. |
| privacy / `control` | `control-catalog` | A control needs its originating catalog to identify its statement, parameters and assessment methods; profiles consume it later. |
| privacy / `poam` | `assessment-result` | Remediation actions and milestones address weaknesses already found by assessment; the result is the nearest source of those weaknesses. |
| privacy / `policy` | `organization` | The organisational rule needs the organisation whose conduct and authority to allow deviations it governs, not the systems that may implement it. |
| privacy / `profile` | `control` | Tailoring selects identifiable controls from originating catalogs; the selected control already carries its catalog context. |
| privacy / `system-security-plan` | `software-system`, `profile` | The SSP states an identified system implementation against a selected control baseline. Component definitions can enrich it but are not required. |
| privacy / `consent` | `processing-activity` | Demonstrable and withdrawable consent must identify the processing being agreed to; its purpose and data categories are already supplied through that activity. |
| privacy / `data-subject-category` | `[]` | A category such as customer or employee can be defined before a particular processing activity or inventory of actual people exists. |
| privacy / `personal-data-category` | `[]` | The classification of personal data such as names or health records can be established before collecting individual data items or recording their processing. |
| privacy / `processing-activity` | `purpose`, `data-subject-category`, `personal-data-category` | An Article 30 processing record must identify why processing occurs and whose categories of data it handles. Recipients and international transfers are not universal prerequisites because processing may involve neither. |
| privacy / `purpose` | `[]` | A specified legitimate reason for processing can be declared before collecting data or designing the activity that fulfils it. |
| privacy / `recipient` | `personal-data-category` | A recipient record needs the personal-data category being disclosed to give the party and disclosure ground meaning. It can be established before a complete processing-activity record, avoiding an activity/recipient aggregation cycle. |
| privacy / `transfer` | `processing-activity`, `recipient` | An international transfer must identify the processing context and receiving party before its destination and safeguards can be described; data categories are already inherited. |
| rd / `considered-option` | `doc.decision` | This kind records an option weighed by a particular decision including why it was accepted or rejected. The decision supplies that question and outcome context; it does not require its child option records first. |
| rd / `decision-driver` | `product` | A decision force needs the product context whose design it constrains. MADR drivers can be concerns, not only formal requirements, so an ASR is optional evidence rather than a universal prerequisite. The later decision consumes this concern. |
| rd / `decision-log` | `doc.decision` | An ordered history is filled from decisions and their supersession information. A decision must not depend back on the log that aggregates it. |
| rd / `doc.decision` | `decision-driver` | A justified design choice needs the concern or force it resolves. MADR allows context and rationale before separately modelled option children; requiring the retrospective considered-option kind would create parent/child feedback. |
| rd / `a-b-test` | `experiment` | The A/B record refines an existing controlled trial with cohort assignment and competing variants. That trial supplies the hypothesis; feature-flag variants are one implementation, not required for all A/B tests. |
| rd / `experiment` | `hypothesis` | A controlled trial needs the expectation being tested before outcomes can confirm or refute it. Its finding is produced by the trial rather than required beforehand. |
| rd / `hypothesis` | `goal` | The stated expected benefit needs the desired state whose benefit is predicted. A hypothesis precedes its validating experiment and cannot require experimental findings first. |
| rd / `prototype` | `hypothesis` | A throwaway exploration needs the expectation about an option it is meant to test. It need not have a completed decision or its retrospectively recorded option, nor does a paper prototype require source code. |
| rd / `spike` | `decision-driver` | A time-boxed investigation needs the unresolved design concern it will clarify. The decision follows the answer; requiring a completed decision or ADR option first would invert this purpose. |
| rd / `risk` | `goal` | The local definition explicitly evaluates harm to a goal, so the desired state is the nearest necessary reference for likelihood and impact. Mitigations and decisions are responses, not prerequisites. |
| rd / `technical-debt` | `component` | A known implementation weakness needs the implemented component that carries it. Source TODO markers, cost estimates and risk documents can evidence or quantify the weakness but are not needed for every debt record. |
| requirements / `change-request` | `product` | A change request identifies a desired alteration of the product with a reason and scope; impact analysis and acceptance are subsequent evaluation, not prerequisites. |
| requirements / `impact-analysis` | `change-request` | Impact analysis evaluates an already proposed change; it cannot be an input required to first capture the request it evaluates. |
| requirements / `requirement-baseline` | `doc.requirement` | A baseline freezes an agreed set of stated requirements at a time; later changes are measured against it, not inputs needed to identify the baseline. |
| requirements / `requirement-change` | `doc.requirement`, `change-request` | A change record needs the old provision and the proposed reason/scope for alteration; a new baseline is produced after agreement, not a prerequisite. |
| requirements / `requirements-specification` | `doc.requirement` | The requirements information item organizes the already articulated provisions into a specification; requirements must not depend back on this aggregate document kind. |
| requirements / `architecturally-significant-requirement` | `doc.requirement` | An ASR identifies a stated requirement’s measurable architectural significance; the architecture decision that answers it comes later and is not a prerequisite. |
| requirements / `assurance-argument` | `assurance-claim`, `evidence` | The argument reasons from available evidence to a claim; the containing assurance case must not be required first because it aggregates this reasoning. |
| requirements / `assurance-case` | `assurance-argument` | The assurance case assembles the supported argument for the product claim; claim and evidence are already inputs through that argument, avoiding redundant ancestor edges and case/claim cycles. |
| requirements / `assurance-claim` | `doc.requirement` | A claim asserts that a stated product obligation holds; arguments and evidence support that proposition afterwards, and the assurance case contains it rather than creating its subject. |
| requirements / `quality-characteristic` | `[]` | A quality characteristic is vocabulary from the product quality model, available before product-specific quality requirements. |
| requirements / `quality-scenario` | `goal`, `quality-characteristic` | A measurable quality situation operationalizes an intended quality goal against a named quality characteristic. It is input to precise quality requirements, not dependent back on those requirements. |
| requirements / `acceptance-criterion` | `doc.requirement` | Acceptance conditions make a stated provision decidable for stakeholders before tests or acceptance evidence exist; this supplies the work-product expectation without requiring every possible work item kind. |
| requirements / `doc.requirement` | `doc.use-case` | A requirement states the provision needed in a concrete usage scenario. The use case already supplies the actor and intended goal, so no duplicate goal edge is added. Specification documents collect provisions later rather than preceding them as aggregates. |
| requirements / `doc.rule` | `domain` | A business rule expresses a constraint in the product’s business language and scope; code and scenarios demonstrate or enforce it later, rather than constituting the rule. |
| requirements / `doc.term` | `domain`, `code.file` | A product-language term needs the domain whose meaning it fixes; its consumers, document layout and code implementation do not define a semantic prerequisite. Its bundled extractor reads code.file as an actual discovery input, so the file kind is also required, independently of the semantic subject context. |
| requirements / `doc.use-case` | `actor`, `goal` | A use case describes how a known actor reaches an intended goal with the system; detailed requirements are derived from that scenario rather than fed back into its framing. |
| requirements / `user-story` | `actor`, `goal` | A story needs the person’s perspective and intended benefit/goal; a requirement or implemented feature may elaborate the need but is not necessary to first express it. |
| resilience / `drill-result` | `drill` | Reached objectives, elapsed time and discovered gaps are evidence from an identified exercise, not inputs needed to describe that exercise. |
| resilience / `drill` | `exercise-scenario` | A planned drill needs the disruption scenario whose extent and duration define what participants practice; the scenario already anchors the plan to be followed. |
| resilience / `exercise-scenario` | `contingency-plan` | A simulated disruption needs the plan and system scope it is meant to challenge; define that scenario before scheduling the exercise that uses it. |
| resilience / `business-impact-analysis` | `business-process`, `software-system` | Assessing disruption cost and recovery urgency needs the supported business process and the system whose loss affects it; scenarios and recovery targets can be findings, not mandatory child records beforehand. |
| resilience / `impact-scenario` | `business-impact-analysis` | A time-dependent outage consequence and unacceptable-loss threshold need the impact analysis context that establishes affected functions and tolerances; the analysis does not require separate scenario records. |
| resilience / `recovery-objective` | `business-impact-analysis` | RTO and RPO express acceptable downtime and data loss derived from business impacts and recovery priorities, before selecting recovery strategies. |
| resilience / `business-continuity-plan` | `business-impact-analysis` | Maintaining business operation during system recovery needs identified critical processes and their interruption impacts; the parallel system contingency plan need not already be documented. |
| resilience / `contingency-plan` | `recovery-objective` | A system return-to-service plan needs recovery time and data-loss targets to select feasible recovery strategies; detailed recovery procedures and exercises follow it. |
| resilience / `disaster-recovery-plan` | `contingency-plan` | The catalog defines this as the site/region-loss part of the system contingency plan, so its recovery scope is specialized from that plan; the parent must not require the child first. |
| resilience / `recovery-plan` | `contingency-plan` | Ordered restoration steps operationalize the system contingency plan and its recovery targets; trial evidence checks these steps afterward and is not prerequisite. |
| resilience / `backup-policy` | `recovery-objective` | Backup frequency, retention and storage location must support the recovery-point and recovery-time targets; actual backup copies are later products of the policy. |
| resilience / `backup` | `software-system` | A recoverable data or configuration copy needs the system whose state is preserved; neither a domain-data model nor formal policy is mandatory for an existing configuration-only or ad hoc backup. |
| resilience / `failover` | `contingency-plan` | Failover identifies the plan-defined service, activation decision and standby restoration strategy; geographic redundancy or replication is optional rather than universally required. |
| resilience / `geo-redundancy` | `deployment-environment` | Regional survivability needs the system being duplicated and the deployment context identifying distinct locations; continuous replication is one implementation, not a prerequisite to all redundant copies. The software-system kind is already available transitively through deployment-environment, so it is not repeated as a direct kind prerequisite. |
| resilience / `recovery-point` | `software-system` | An achieved recoverable timestamp and resulting data loss need the system whose state can be restored; backup and replication are alternative recovery mechanisms, so neither is a universal prerequisite kind. |
| resilience / `replication` | `data-entity`, `deployment-environment` | Continuous copying and lag require identified source content and source/target deployment context; backup and geo-redundancy are possible related strategies, not mandatory prerequisites. |
| resilience / `restore-test` | `backup` | A trial restore must identify the backup it attempts to recover; a full drill or formal recovery-plan record is optional and would overconstrain the empirical check. |
| review / `code-owner` | `code.repository` | CODEOWNERS review ownership is repository-scoped path-pattern responsibility; matching concrete source files is not required because a pattern may cover future paths. |
| review / `pull-request-review` | `pull-request` | A review evaluates an existing proposed repository change; its findings and merge outcome are later records, not prerequisites. |
| review / `review-checklist` | `definition-of-done` | The checklist operationalizes the quality standard reviewers must check before approval; no particular review or pull request needs to exist before the reusable list. |
| security / `access-review` | `iam-grant` | Reviewing whether access is still needed requires the existing permission grants; the grants already identify accounts and the authorization policy. |
| security / `iam-account` | `[]` | An authenticatable subject identity can be registered before it has any permissions, role assignments or product consumers. |
| security / `iam-grant` | `iam-account`, `iam-policy` | A concrete permission needs an authenticated subject and the authorization rule defining allowed actions and resource scope. A role is not mandatory because a grant can be direct. |
| security / `iam-policy` | `software-system` | A policy needs the protected system scope so its subjects, actions and resources can be interpreted; actual accounts and grants may be created later. |
| security / `iam-role` | `[]` | A named reusable permission set can be specified before accounts receive it or a particular grant instantiates it. |
| security / `scim-directory` | `software-system` | The directory needs the service whose SCIM provisioning interface synchronizes identity resources; individual account pages can be created from that directory later, not required as aggregation input. |
| security / `service-account` | `k8s-namespace` | Kubernetes binds a ServiceAccount identity to a namespace, which supplies its cluster context; pods and role bindings consume that identity later. |
| security / `sso-configuration` | `software-system` | SSO configuration needs the relying service scope to state how it trusts an identity provider. Provisioned accounts are consumers, not a prerequisite for declaring federation trust. |
| security / `assessment-finding` | `product` | A security conclusion needs the product scope it assesses. No single scan kind is mandatory: findings can arise from manual assessment, penetration testing or multiple tools; evidence is recorded within the conclusion. |
| security / `bug-bounty-program` | `disclosure-policy` | Paid external research needs published reporting and authorized-scope rules; vulnerability reports and findings are outcomes rather than prerequisites. |
| security / `dast-scan` | `deployment` | Attacking a running service needs an actual deployed target, rather than only source code or an intended deployment; findings need not already exist. |
| security / `penetration-test` | `product` | An authorized attempt needs the product scope against which permission and tested attack surface are stated. A running deployment is not universally necessary for code-assisted or design-inclusive engagements. |
| security / `sast-scan` | `code.file` | Reading source for exploitable patterns needs source files, which already provide repository context; vulnerabilities and scan results are outputs. |
| security / `secret-scan` | `code.repository` | Searching credentials left in a repository needs its tree and potentially history; a known secret is not necessary to run a scan that returns no findings. |
| security / `vulnerability-scan` | `product` | A known-weakness scan requires an identified target product scope. It may inspect packages, images, hosts or services, so no one narrower target kind or existing vulnerability is universal. |
| security / `audit-finding` | `audit` | A conclusion must be grounded in the examination that produced it; the audit already carries product scope and control criteria, so they are not repeated. |
| security / `audit` | `product`, `control` | Examining a product or its process against a standard requires the product scope and explicit control statements to serve as examination criteria; findings are produced later. |
| security / `exception` | `policy` | Accepting a deviation with an expiry and justification requires the governing rule and its authority to allow deviations; an audit finding is not universally needed. |
| security / `protection-profile` | `[]` | A protection profile defines a reusable implementation-independent security problem and requirements for a category of products, before any concrete target is selected. |
| security / `secure-development-practice` | `[]` | An SSDF practice can be recorded by its authoritative identifier, outcome and tasks before any product process implements it. |
| security / `security-control` | `[]` | A numbered ASVS verification requirement and level can be stated from the standard before applying it to any product or discovered threat. |
| security / `security-target` | `product` | A security target identifies its concrete target product and states its security problem and answering measures. Protection-profile conformance is optional, so a protection profile is not an unconditional prerequisite. |
| security / `crypto-algorithm` | `[]` | An algorithm name, parameters, strength and status can be described independently of keys or products that select it. |
| security / `cryptographic-asset` | `product` | A cryptographic inventory entry needs the product whose reliance it documents. It can describe an algorithm, certificate, key material or protocol, so no one such subtype is a mandatory prerequisite. |
| security / `key-material` | `crypto-algorithm` | A key must identify the cryptographic algorithm that determines its structure and use before its storage and expiry can be interpreted; a certificate is optional and may be issued later. |
| security / `disclosure-policy` | `product` | Published reporting rules require the product scope and responsible team/contact to which researchers can disclose vulnerabilities; existing reports are not required. |
| security / `disclosure-report` | `product` | An outside report must identify the product it concerns before handling and resolution have meaning. Reports may arrive without any pre-existing published disclosure policy or confirmed vulnerability. |
| security / `security-advisory` | `vulnerability`, `release` | A notice needs the identified vulnerability and the product versions to which its affected/fixed statements apply; an outside disclosure report is optional. |
| security / `indicator` | `[]` | A structured suspicious pattern and validity interval can be supplied as intelligence before any local sighting, model or named attacker exists. |
| security / `threat-intelligence` | `[]` | Intelligence about campaigns, tools and targets can be imported as an external body of knowledge before any local system is modeled. |
| security / `secret-reference` | `code.file`, `secret` | The reference needs the code location that names the secret and the secret identity it resolves to; storing or exposing the secret value in code is not required. |
| security / `secret` | `[]` | A confidential credential value and its identity can be registered before services or code references consume it. |
| security / `license` | `[]` | SPDX-identified license terms can be recorded before a component declares or concludes that license. |
| security / `sbom-component` | `sbom` | An SBOM component entry needs its containing inventory context for its identity and relationships. Licenses and vulnerabilities are optional enrichments rather than prerequisites. |
| security / `sbom` | `product` | An inventory needs the product whose composition and dependency graph it represents; a release is optional because development and design BOMs are also meaningful. Component entries belong to the inventory afterward. |
| security / `scorecard-check` | `code.repository` | A scored repository security check needs the repository and evidence it examines, not a vulnerability or a completed SBOM. |
| security / `mitigation` | `threat` | The countermeasure needs the threat whose likelihood or effect it reduces, rather than requiring an implementation or verification result first. |
| security / `threat-actor` | `[]` | An attacker capability and intent profile can be recorded before a particular system, attack or threat model uses it. |
| security / `threat-model` | `software-system` | The model first needs the subject system scope and description; threats and countermeasures are subsequently developed inside it, not mandatory pre-existing child pages. |
| security / `threat` | `threat-model` | A STRIDE-classified way to harm the product needs the modeled subject and assumptions; mitigations are answers developed after the threat. |
| security / `trust-boundary` | `trust-zone`, `information-flow` | A change in trust needs the trust regions being separated and the information movement crossing between them; the system is inherited through its zones. |
| security / `trust-zone` | `software-system` | An area with a uniform trust level needs the system in which that area and its membership are defined; the boundaries separating zones can then be identified. |
| security / `finding` | `product` | A scanner result needs the target scope in which its rule and location are meaningful. SARIF handles many analysis tools, so forcing every result to depend on one particular scan subtype would exclude valid results. |
| security / `suppression` | `finding` | The explicit decision not to act needs the result being suppressed; the result already supplies rule, target and location context. |
| security / `vex-statement` | `vulnerability`, `product` | An impact assertion intersects an identified product with an identified vulnerability and status; affected release ranges or components can be named within that assertion without requiring a complete SBOM. |
| security / `vulnerability` | `[]` | An OSV advisory is independently identifiable by affected upstream package coordinates and version ranges. The catalogue code.package is a local service-manifest folder, not an upstream advisory package; no local checkout is required. |
| security / `weakness` | `[]` | A CWE identifier names a general software or hardware flaw class before a particular vulnerability, affected product or scan demonstrates an instance. |
| strategy / `business-capability` | `organization` | A capability says what an identified organisation can do; the processes, applications and resources that realize it need not yet be catalogued. |
| strategy / `course-of-action` | `goal` | A chosen approach requires a target goal; implemented capabilities and project tasks are later realizations of that approach. |
| strategy / `value-stream-stage` | `value-stream`, `business-capability` | A stage needs its containing value stream for placement and capabilities for the ability enabling that step; the stream does not depend back on its stages. |
| strategy / `value-stream` | `outcome`, `actor` | The stream is bounded by value delivered to an actor and an intended outcome; individual stages are subsequent decomposition, not prerequisites. |
| strategy / `assessment` | `driver` | The assessment judges the motivating condition and its grounds; taking goals as mandatory inputs would create feedback into goal formation. |
| strategy / `constraint` | `product` | A constraint bounds the product solution space; it can be stated before particular requirements, decisions or architecture elements exist. |
| strategy / `driver` | `stakeholder`, `domain` | A motivating condition is interpreted within a business domain and the concerns of affected stakeholders, before assessment or goal formation. |
| strategy / `goal` | `assessment` | A desired state follows the assessed motivating condition; product, domain and driver are already reachable through the assessment, so no broad ancestor edges are added. |
| strategy / `key-result` | `objective` | A measurable key result needs the objective whose achievement it measures, not an already achieved outcome. |
| strategy / `objective` | `goal` | An OKR objective makes a goal concrete; key results measure the objective later and are not inputs to its identity. |
| strategy / `outcome` | `goal` | An outcome names the difference made when an identified goal is reached, not the downstream work that implements it. |
| strategy / `principle` | `goal` | A principle states a normative way to pursue the intended state, before decisions are evaluated against it; decisions are consumers, not inputs. |
| strategy / `product-goal` | `vision` | The current product commitment selects a concrete future state within the product vision; backlog items are work ordered towards it, not prerequisite contents. |
| strategy / `stakeholder` | `product` | An interest and concern are meaningful against an identified product; a concrete login account is not necessary for an external stakeholder. |
| strategy / `vision` | `stakeholder` | The vision states future direction for the product and people it serves. Stakeholder supplies the product context already, so a duplicate product edge is omitted; goals and plans elaborate the vision later. |
| strategy / `backlog-item` | `product-goal` | A backlog item is ordered work towards the product commitment; sprint, increment and implementation do not have to exist before the need is captured. |
| strategy / `definition-of-done` | `product` | The shared done standard states quality measures for this product before any increment can qualify as done; depending on increments would reverse that gate. |
| strategy / `increment` | `sprint`, `definition-of-done` | An increment records the usable result of sprint work that satisfies the shared done standard; the sprint supplies the work context. |
| strategy / `job-to-be-done` | `actor` | The job describes the actor’s intended progress independent of a feature or implementation. The cited Wikipedia URL was blocked; this edge follows the catalog definition, not a claimed source reading. |
| strategy / `release-plan` | `roadmap-item` | The release plan groups already identified planned scope into an expected delivery window; a released product version is its later result, not an input. |
| strategy / `roadmap-item` | `epic` | A roadmap item schedules a substantial planned need; requiring a completed release or its implemented features would invert planning into delivery. |
| strategy / `sprint` | `backlog-item`, `team` | A sprint bounds a team’s selected backlog work in time; resulting increments do not precede the timebox. |
| strategy / `actor` | `product` | The actor is identified by interaction with the product boundary; named login identities and implemented interfaces are not required. |
| strategy / `domain` | `product` | A business domain needs the product context whose business scope it names, but not the systems later grouped under it. |
| strategy / `persona` | `research-finding` | A persona synthesizes researched user goals and behaviour; requiring a pre-existing persona to perform the research would create a discovery cycle. |
| strategy / `product` | `[]` | Product identity establishes the subject and audience before its goals, architecture or parts are described. |
| strategy / `user-role` | `actor` | A product-use role refines the already identified actor into duties and permissions, without requiring concrete account membership. |
| suppliers / `license-agreement` | `supplier` | Permission to use a supplier component or service needs the supplier relationship and its product context. SPDX-listed terms are optional because proprietary agreements need not have an SPDX identifier. |
| suppliers / `supplier-agreement` | `supplier` | Agreed security, reporting and service terms need the supplier relationship and its product context; a prior completed assessment is not universal. |
| suppliers / `subcontractor` | `supplier` | The subcontractor role needs the direct supplier whose work is delegated, which already provides the downstream product context; the supplier does not depend on a populated subcontractor inventory. |
| suppliers / `supplier-assessment` | `supplier` | Checking security and dependability needs the supplier under assessment, including its product dependency context; the resulting risks are not prerequisites. |
| suppliers / `supplier` | `organization`, `product` | The supplier role needs the external organisation identity and the product that depends on its service, component or platform; an agreement or assessment can be recorded later. |
| suppliers / `supply-chain-risk` | `supplier` | The risk must identify the supplier relationship or upstream chain that introduces it. A formal supplier-assessment record is optional because risks can be identified directly. |
| testing / `code.test-case` | `test-condition`, `code.file` | ISTQB derives test inputs/actions/expected results from test conditions. This catalog narrows the case to an extracted test and exercised code, so its repository file is also needed; suite and run are consumers. |
| testing / `code.test-quarantine` | `code.test-case`, `task`, `code.commit` | Quarantine identifies an excluded test, its repair work item and the introducing revision. File context already follows from the test case; latest CI result is explicitly optional. The catalog product-task is used, not the obsolete unqualified task reference. |
| testing / `coverage-item` | `test-basis` | A coverage item selects a particular aspect of the test basis to measure. A suite or measured percentage is a consumer/result and is not required to identify the branch or requirement to cover. |
| testing / `test-basis` | `product` | The body of knowledge must have a product scope but can come from code, requirements, stories or expert knowledge. No one such alternative source kind is mandatory, and conditions/tests are derived downstream. |
| testing / `test-condition` | `test-basis` | A testable aspect is selected by analyzing the body of knowledge. Test cases elaborate the condition; requiring them would reverse the test-design flow. |
| testing / `test-data` | `test-condition` | Input data is selected for the aspect to exercise. It can be prepared before concrete cases or runs and remains separate from code; the condition provides the nearest test intent. |
| testing / `test-double` | `component` | A replacement must identify the component whose behavior or interface it stands in for. Cases consume the stand-in; requiring a case would make test construction unnecessarily circular. |
| testing / `test-oracle` | `test-basis` | An expected-result source is selected from the knowledge of intended behavior. A test case consumes the oracle; golden files and written specifications are alternatives, not simultaneous mandatory kinds. |
| testing / `test-procedure` | `code.test-case` | Ordering cases and defining setup/wrap-up needs identified cases. The procedure precedes execution and does not require a test run or log. |
| testing / `test-suite` | `code.test-case`, `test-environment` | The local definition groups cases for execution and names their required environment. Cases do not require the containing suite, so this aggregation direction is acyclic; runs consume the suite. |
| testing / `defect` | `product` | A deficiency needs the affected work-product context, but can occur in code, requirements, documentation or design. Product identity is the common available prerequisite; neither a failing test nor an observed failure is mandatory (static review can find defects). |
| testing / `failure` | `product` | A failure is an observed product event. Its expectation may be a formal requirement OR another expected result, so the product is the common input rather than a mandatory requirement. |
| testing / `test-charter` | `test-objective` | The exploratory mission turns a testing purpose into a bounded direction for exploration. A session executes that mission later and is not required to write it. |
| testing / `test-environment` | `technology` | The hardware/software/tool environment needs the technologies that specify its support elements. An actual test or suite is a consumer; requiring those would prevent preparing the environment first. |
| testing / `test-objective` | `test-basis` | A testing purpose must be grounded in knowledge of the product and what needs assurance. It need not wait for a plan, charter or a concrete test that will serve it. |
| testing / `test-plan` | `test-objective` | Objectives supply the purpose around which means and schedule are organized. Suites, execution logs and reports are planned or produced later, not inputs needed to identify the plan. |
| testing / `test-session` | `test-charter`, `test-environment` | A bounded exploratory period needs its guiding mission and a usable test environment. It can discover/design cases dynamically, so no prewritten suite or case list is forced. |
| testing / `flaky-test` | `test-result` | Different outcomes for the same code require recorded executions, not just a test declaration. A result already identifies its case/run/revision, so those edges need not be repeated; quarantine is only a possible response. |
| testing / `mutant` | `code.file` | A deliberately changed copy needs the original source file. Tests later try to kill it; neither an outcome nor a mutation report is needed to identify the mutation. |
| testing / `mutation-report` | `mutant`, `test-result` | A kill/survival report needs identified deliberate changes and test execution outcomes. The outcomes already supply case/suite/run context; mutants must not depend on this consuming report. |
| testing / `test-log` | `test-run` | A chronological execution record needs the run it records. Individual results can arrive during that run, but are not prerequisites to start recording the log. |
| testing / `test-report` | `test-result` | Summarizing passed, failed and blocked testing requires recorded outcomes. Each outcome already supplies its run and case; the report is not a prerequisite of execution. |
| testing / `test-result` | `test-run` | An outcome belongs to a run whose suite already identifies the cases. It records a particular case selection within that scope; failures are optional outcomes, not mandatory prerequisites. |
| testing / `test-run` | `test-suite`, `code.commit` | An execution needs the suite and the exact tested version. A commit represents that version without forcing a user release before tests can run. |
| testing / `benchmark` | `product`, `test-environment` | A repeatable speed/cost measurement needs its product target and controlled measurement environment. A budget is a possible comparator, not mandatory for establishing an initial baseline; Web Vitals only supports the web-performance subset. |
| testing / `capacity-test` | `performance-test` | Capacity testing specializes a performance test to finding the load limit. The underlying performance test already supplies test intent and environment; no separate load-test kind is required. |
| testing / `chaos-experiment` | `observed-deployment`, `sli` | A controlled fault needs an identified running target and measurable steady-state behavior. Actual deployment and an SLI supply these without requiring a result or an incident in advance. |
| testing / `chaos-result` | `chaos-experiment` | The findings need the controlled experiment, which already identifies target and steady-state measure. Its result must not be required by the experiment it evaluates. |
| testing / `consumer-contract` | `integration` | Consumer expectations concern a particular integration between consumer and provider. That integration supplies participants/protocol; a static interface specification is not required because Pact contracts can be generated from examples. |
| testing / `contract-test` | `consumer-contract` | A compatibility check needs the consumer expectations it checks. Provider verification is a run of that check and therefore downstream. |
| testing / `load-test` | `performance-test` | Expected/typical/peak load specializes the performance test. The general test already brings its cases and environment; a benchmark or production deployment is not universally required. |
| testing / `performance-budget` | `screen` | The local definition limits a screen or route, so the rendered screen is the scope for metric limits. Performance tests consume the budget later; an existing measurement is not needed to set a target. |
| testing / `performance-test` | `code.test-case`, `test-environment` | The performance test needs a defined exercise/expected behavior and a controlled environment to give response and capacity measurements meaning. A budget or baseline benchmark can be added but is not necessary for measurement. |
| testing / `provider-verification` | `contract-test`, `test-environment` | The recorded provider-check run needs the contract test to execute and the environment hosting the provider. The contract test already leads to published consumer expectations and the integration. |
| work / `handoff` | `branch`, `owner` | The handoff transfers a branch and its work to a known responsible owner; branch identity and recipient responsibility must be identified before transfer. The operation record is the transfer itself, not another required predecessor. |
| work / `question` | `product` | A clarification needs the product context of the unsettled entity and its responsible conversation; a particular task, feature or requirement is not mandatory because questions can concern any entity. |
| work / `reservation` | `task`, `owner` | A hold needs the scoped work subtree and the person responsible for it. The catalog hold semantics are used; the live cited decision now describes optimistic reservations instead, a reported source mismatch. |
| work / `bug` | `defect` | The bug is the actionable work item for a recorded work-product defect; a planned feature, fix commit or containing stage is not needed to first report it. |
| work / `lifecycle-step` | `task` | The lifecycle record accounts for one completed step of an agent task; its duration and usage are outputs of that execution, not prior inputs to define the task. |
| work / `task` | `product` | A standalone task needs product scope and the statements/pages it proposes to affect, but need not belong to an epic or feature: its definition explicitly covers work with no entity of its own. |
| work / `epic` | `goal` | An epic captures a large need aimed at an intended state. The goal already traces through assessment and driver to stakeholder concern, so no duplicate stakeholder edge is added; features, stories and schedules are later decomposition. |
| work / `feature` | `goal` | A feature makes a stakeholder need concrete as a product service, so its goal is the input. An epic is an optional grouping, not a prerequisite for a standalone feature. |
| work / `milestone` | `epic` | A dated milestone groups planned epic scope; individual epics do not depend back on their scheduling aggregate, avoiding the parent/child cycle. |
| work / `stage` | `feature` | A stage bounds one responsible unit of feature work; tasks and bugs are later contained work, so the stage does not require its children to already exist. |
| work / `evidence` | `product` | Acceptance evidence needs the product under acceptance. The producing check may be manual, a rendered view, a document review or an automated test; a test-result kind is not a universal input. |
| work / `merge` | `pull-request` | A merge integrates a proposed repository change after any lane authorization; review approval is not imposed as a mandatory kind because the definition permits multiple integration lanes. |
| work / `review-finding` | `pull-request-review` | A finding records an issue raised by an existing change review; severity and fixed/declined outcome enrich it, while the later corrective change is not a prerequisite. |
