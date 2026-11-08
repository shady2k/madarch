# The tracker: the owner's decisions on PR 218, point by point, 2026-11-08 (source record)

The owner went through Andrey's tracker proposal (PR 218: concept, design, model contract, development plan) one point at a time on 2026-11-08. Each point keeps what was put to him, his words verbatim in Russian (in «»), and what was agreed. It continues docs/vision/tracker-and-graph-discussion-2026-11-07.md and is the agreement checkpoint M0 of that plan; decision records follow from it. The same text was posted to PR 218 for its author.

## Q1.1 Identity of a work item

Context: Andrey's model-contract.md §2 proposes a stable key plus a human number plus machine-local SQL ids.

Owner's words, in order:
- «Ты думаешь человек оперирует номером? Ну иногда бывает конечно, но в основном нет»
- «Ну нет, номер конечно нужен, но его недостаточно»
- «Зачем нам в БД еще один суррогат?»
- «Ну вообще да, может создаваться и оффлайн»
- «А если нет общего сервера? К примеру разработчик работает один?»
- «Можно конечно просто генерить уникальный номера всегда. beads так и делает»
- «Да, нужен уникальный хэш. Но мы же не можем гарантировать уникальность?»
- On the proposal "a full random 128-bit id, shown as its shortest unambiguous prefix as git does; a short prefix
  that becomes ambiguous after a sync is lengthened, and a mention of an ambiguous prefix asks to be resolved": «Да»

Agreed:
- One identity, no second surrogate: a random 128-bit id made on any machine, offline or alone, with no number
  authority. People see its shortest unambiguous prefix with the product's prefix (git-style abbreviation).
- A number is needed but is not how people mostly find work: they find it by title and meaning (search, agent).
- The parent is a relation, not part of the id (proposed with the beads `8bdc.2.5` caveat; the owner's «Да» covered
  the id scheme — confirm when hierarchy is discussed).
- Machine-local SQL ids never leave the database.

## Q1.2 Where work data lives

Context: model-contract.md §2. Owner: «br здесь не при чем. Мы же делаем свой трекер».

Proposal put: every value of a work item (title, original request, fields, priority, assignee, comments, time,
reservation, results and review decisions) lives in PostgreSQL; the repository's manifest holds only the kinds'
declarations (fields, statuses and transitions, rules). Changing a title, priority or status changes a database row
only; changing a kind is a manifest edit through a commit and review.

Owner: «Да»

## Q1.3 Statuses per kind, one engine

Context: model-contract.md §3. Proposal put: each kind declares its own statuses and transitions in the manifest
(no status list in code); one engine runs every kind; a transition's guards and effects are named from one shared
set, and naming a missing one is a manifest error; the mandatory checks (rights, ownership, revision) cannot be
removed by a manifest; an invalid manifest is refused whole, naming file, kind, transition and reason.

Owner: «Да»

## Q1.4 A manifest change and the existing items

Context: model-contract.md §3 last paragraph. Proposal put: a manifest change that renames or removes a status or
field names explicitly what existing items become ("checking → review"); a preview shows how many and which items it
touches; an item no mapping covers refuses the change, never a guessed status; after installation, stale transition
proposals are refused and readiness is recomputed.

Owner: «Согласен»

## Q1.5 The original request is kept verbatim

Context: model-contract.md §4 "Request capture and interpretation". Proposal put: a person's request is stored byte for
byte with author, time and its conversation, and never changed; the interpretation (title, kind, fields, criteria) is a
separate record with its rationale and who decided it, editable while the original stays; clarifications append, each
with who and when; a request is created with no criteria or fields — completeness is needed to start work, not to file.

Owner: «Да»

## Q1.6 Hierarchy and links

Context: model-contract.md §4 "Hierarchy and work links". Proposal put: the parent is a relation, at most one parent;
typed links (parent, blocks, duplicate, related) are not interchangeable; no hierarchy or dependency cycles; structure
is not execution order (blocks and priority are); every structure change advances its revision.

Owner: «Да, и связи должны настраиваться в манифесте, нужны будут дополнительные связи»
Follow-up proposal put: a link type is declared in the manifest (name, direction, which kinds it joins, how many per
item, labels in each interface language); its behaviour is named from one shared set ("forbids cycles", "inherits the
urgency of what it blocks", "closes with its main item"), so a new link such as "implements a requirement" or "is
checked by a test" needs no code; parent and blocks are declared there too, and their invariants (one parent, no
cycles) are enforced by the engine and cannot be removed by a manifest.

Owner: «Да»

## Q1.7 Priority is set for a feature as a whole

Context: model-contract.md §5 "Priority and suitability", first paragraph. Proposal put: a feature and all its
descendants share one level; standalone debt can be a group of its own; only the product owner changes a feature's
level, moving the whole group in one action, and an agent may only propose; no hidden ranks inside a feature — order
inside comes from "blocks" links only; a new human request lands on the level the owner set for intake.

Owner: «Да»

## Q1.8 A blocker inherits the urgency of what it blocks

Context: model-contract.md §5, second paragraph. Proposal put: an item that blocks a more urgent one becomes as
urgent, transitively along the chain; the feature's own level is untouched and the item returns to it when the link
is removed or satisfied; an item can be taken only with a fitting effective level (the higher of its own and the
inherited), a fitting area, the rights, its prerequisites met, no other holder's reservation over it, and its feature
under its cap of people.

Owner: «Да»

## Q1.9 The cap: features per responsible person, not people per feature

Context: model-contract.md §5, third paragraph (a cap counting people per feature, agents mapped to persons).

Owner: «Ну, агент не привязывается к человеку. Человек отвечает за фичу.»
Then, on "a feature has one responsible person; agents are executors bound to nobody and not counted; if a cap is
needed it limits features in progress — per responsible person or per product?": «Да, количество у одного
ответственного»

Agreed: a feature has one responsible person; agents are executors, not tied to a person and not counted; the cap is
the number of features in progress held by one responsible person. Andrey's per-feature people cap and agent-to-person
mapping are replaced.

## Q1.10 Who holds the reservation

Context: model-contract.md §5 "Ownership and the two assignments" (responsible person, executor, and a separate
reservation holder). Proposal put: the responsible person of a feature holds its reservation over the whole subtree;
agents work under it and hold none of their own; replacing an agent leaves the reservation, and the replaced agent's
late results are kept in history and overwrite nothing; another responsible person takes part of the subtree only
after it is explicitly handed over; never two reservations over one subtree.

Owner: «Да, бронь держит ответственный»

## Q1.11 Comments

Context: model-contract.md §4 "Comment" row. Proposal put: each comment has its own hash id, author, time, text, what
it replies to and its source; comments survive state changes, import and moves; an edit keeps the earlier text and its
author in history.

Owner: «Да, по сути комментарий - это просто отдельный вид сущности, который может быть привязан к любой другой
(исходя из манифеста)»

Agreed: a comment is an entity kind of its own, declared in the manifest, attachable to any kind the manifest allows
through a declared link — not a tracker-specific table.

## Q1.12 Time, and the tracker as an area of entities

Context: model-contract.md §4 "Time entry and correction". Proposal put: time is recorded as entries (item, who,
attempt, interval, duration, source), corrections append, nothing counted twice; proposed: a time entry is an entity
kind of its own in the manifest, attachable to any kind allowed.

Owner: «Мне кажется, что мы очень много берем из anytype https://github.com/anyproto Можно посмотреть какие шишки они
набили и как лучше реализовать. Более того, трекер - это не отдельная часть, это просто область определенных
сущностей. Время по идее тоже отдельная сущности со своими типами»

Agreed: the tracker is not a separate part — it is an area of entity kinds in the one catalog; time is an entity kind
with its own types. Research Anytype's object model and its lessons before the remaining points.

## Q1.13 A link is an entity

After the Anytype research (Anytype stores links one way as id lists, with no typed or attributed edges and untyped
backlinks). Owner: «Кстати да, а связь - это же и правда отдельная сущность. Вот это хорошо, что ты посмотрел»

Agreed: a link is an entity of its own — its type is declared in the manifest, and each link instance has its own id
and can carry attributes and history.

## Q1.14 Composition, not inheritance

Owner: «А наследование делать будем? :) Как в ООП?» … «А потом видимо перейдем к функциональному? :)))»
Proposal put: no kind inheritance; a kind references shared named parts — a field set, a workflow with statuses, a link
behaviour — e.g. "bug" and "task" both use the "delivery" workflow and the "estimate" field set without inheriting
from each other; computed fields are pure functions over the graph (inherited urgency is one).

Owner: «Да, композиция - это отлично»

## Anytype lessons taken (research of 2026-11-08, sources in the coordinator's research report)

Copy: a derived id for schema entities (kind, link type, status value) from the manifest key, a random id for
instances; a revision on every declared kind; soft delete with tombstones for anything referenced or replied to.
Avoid: a copy of the vocabulary per space (one manifest, its version stored); free-floating relations on one object
(declared on the kind); names carrying identity; deleting a field without deciding its values; last-writer-wins as
the only conflict rule for status (transitions are validated at merge); maintenance passes linear in objects on start.

## Q1.15 Inactivity and Problems; one person on several machines

Context: model-contract.md §4 "Product work settings and Problems". Proposal put: product settings hold the cap of
features per responsible person, the priority method, roles and an inactivity period (24 h by default, changeable per
product or item); an item under reservation with no activity past it raises a "stalled" problem; this is not a
reservation timer — a reservation never expires by itself, a person decides.

Owner: «Да. Только как быть если человек один и тот же работает с нескольких машин?»
Proposal put: the reservation is the person's and holds on any of his machines; inactivity is counted per item, not
per machine; concurrent offline edits of one item from two machines merge like any concurrent changes (different
fields merge; one field changed two ways is a problem to choose; a combined invalid status transition is a problem,
never silently chosen).
Owner: «А зачем нам знать, что ноутбук не синхронизировался?»
Proposal put: drop the "machine not synced" problem; a machine shows its own count of unsent changes, sync runs by
itself when online, and "stalled" covers what others see.
Owner: «Да, пожалуй. Нам не важно с какого устройства работает ответственный. Может быть он просто скопировал с ноута
на рабочий комп.»

Agreed: the device does not matter; no per-machine sync problem; a machine shows its unsent changes locally; Andrey's
"last successful sync → Problem" is dropped.

## Q1.16 Sync exchanges operations

Context: model-contract.md §4 "Operation journal and local outbox". From the owner's «Может быть он просто скопировал
с ноута на рабочий комп»: nothing may rely on a machine's identity.
Proposal put: every change of data (create an entity, set a field, move a status, add or remove a link, take or hand
over a reservation, soft delete) is an operation with its own random id, author, time and expectation ("status was
X"); unsent operations wait in a local queue; sync exchanges operations, not state; an operation received twice
applies once (so a copied database duplicates nothing); a failed expectation is a conflict raised as a problem with
choices, never a silent overwrite. Manifest changes stay commits, not operations.

Owner: «Какое изменение?» → «А, ты про аудит?» → (journal is what machines exchange, as git commits and Anytype change
trees; audit comes free) → «Ну, пожалуй да. То есть когда я синхронизируюсь с серваком я шлю все изменения, что я
делал. Верно?» → (only the unsent ones, resumable; both ways — you receive others' since your last sync; a conflict
comes to you as a problem with choices) → «Да»

## Q1.17 Import

Context: model-contract.md §4 "Import mapping and reconciliation". Proposal put: import keeps where each entity came
from (system, its id there, the source's checksum) as a mapping record; a repeat import of the same source makes no
duplicates and changes only what changed there; import invents nothing (a closed item arrives closed, marked as
imported, with no fabricated reservation, reviewer or check); each failure is reported item by item.

Owner: «Да, и сбой импорта одной сущности не приводит к отказу всей пачки. Еще нужно поле внешний трекер с номером,
если например кроме madarch используется еще и jira»

Agreed in addition: one entity failing does not refuse the batch; an entity carries an external tracker reference
(system and its number) for trackers used alongside madarch, e.g. Jira.
Follow-up proposal put: the external reference is a shared part (system, number there, link) any kind can take through
the manifest; several per entity; import and manual linking write the same record, so a repeat import recognises the
item by it; a link only — no two-way sync with the outside tracker for now.
Owner: «Lf» (typed «Да» in the Latin layout)

## Q1.18 Snapshots are restore points, as in backups

Context: model-contract.md §4 "Snapshot/checkpoint references" and §5 "snapshot retention" (pinning snapshots that
evidence or paid results need; an explicit "evidence unavailable" record when one is released).

Owner: «Но такого не может быть. Сущности у нас никуда не исчезают. Снимок нужен как и для бэкапов напрмер, мы
записываем инкремент, но периодически там полный снэпшот. Посмотри на модель бэкапов»
Proposal put: increments are the journal's operations, kept forever (a delete is a tombstone operation); a full
snapshot is a restore point; any moment = the nearest full snapshot before it + the increments after; snapshots are
taken periodically (every N operations or per period); only full snapshots may be thinned (e.g. one a month for old
history), which loses no data, so "evidence unavailable" cannot arise; a snapshot with the journal serves as a backup.
Owner: «Да»

Agreed: Andrey's retention pinning and "unavailable evidence" records are dropped.

## Q3.1 A change touching places of different lanes

Context: concept.md "Acceptance by product policy" (the owner's lanes C, B, A from his review). Proposal put: the
strictest lane among the touched places applies to the whole change; A includes C's technical checks (green build,
agent review) and adds the people; lowering below an inherited lane only by a person holding that exception right,
with the reason recorded, never by a client flag.

Owner: «Да»

## Q3.2 Who is a sole developer

Context: concept.md Q3 "sole-developer qualification". Proposal put: being sole is a property of the product, not of a
person — a product with exactly one member holding the responsible role, read from its roles; when a second
responsible person joins, the sole rule stops by itself and A again needs a second person; nobody can declare himself
sole — it is not a flag.

Owner: «Да, свойство продукта»

## Q3.3 Independent review is proven by who launched it

Context: concept.md "Acceptance by product policy" ("a worker's self-declared model string is not verified
independence"). Proposal put: a review counts only when its evidence names the real reviewer and model, written by
what launched the agent (the coordinator or the model gateway), never by the agent about itself; merge rights are
checked apart from the responsible-person field.

Owner: «Да, причем мы агенту не даем возможности прочитать какая модель писала код»

Agreed in addition: the review is blind — a reviewing agent cannot read which model wrote the code.

## Q2.1 Handing part of a feature to another responsible person

Context: concept.md Q2 (baseline: explicit release of the enclosing scope before another holder takes a child; an
atomic handoff would need its own contract). Proposal put: a handoff is one action — "give branch X to Andrey" — one
journal operation with no window where the branch is nobody's; the giver keeps the feature's reservation with branch X
cut out, returned only by a reverse handoff; the receiver gets it only with the responsible right and within his cap
of features.

Owner: «Передача - это одна операция, да.»

## Q2.2 Taking a reservation needs the central server's permission

Context: concept.md "Subtree ownership, executors and disconnects" (taking shared work requires a remote connection;
confirmed holders continue offline; local pending commands are not grants). Proposal put: a take is decided by the
server only; under a confirmed reservation one works offline freely (children, comments, time, results); an offline
take is a request, not a reservation, refused as a problem if the server gave it to someone else meanwhile; with no
server (one developer) his own database decides at once.

Owner: «Да, если есть центральный сервер, то только с его разрешения»

## Q2.3 Releasing a stalled reservation, and the work of the one it was taken from

Context: concept.md "Subtree ownership…" (an authorized human investigates and unlocks manually, with a reason and a
new fence against the old holder; settings cover leave). Proposal put: only a person with that right releases it,
explicitly, with the reason recorded; the old holder is fenced — his later operations under that reservation never
overwrite the current state, they are kept and come to him as a problem; leave is set ahead as a longer inactivity
period for the item or product.

Owner: «В целом да. А что потом разработчику делать с несохраненной работой? Если у него забрали фичу?»
Proposal put: nothing is lost — his late operations arrive in the item as "changes from the former responsible
person", which the current responsible person accepts or declines one by one (comments and time entries can be taken
at once, they overwrite nothing); his code stays in his git branch, linked to the item, to continue from or merge as a
PR; he gets a problem "feature X was taken from you (reason), your changes were passed to the new responsible person".
Owner: «Да»

## Q-intake.1 Every human change is a request the agent processes; the responsible person approves

Context: concept.md "Intake, planning and workflow" ("People can structure work themselves … An agent is optional
assistance, not the only editor") against decision 0033 (people change things only through the agent, words kept).
Discussion: direct edits have mechanical consequences the engine computes and semantic ones it cannot.

Owner: «Ну не знаю. А дальше по цепочке точно ничего не нужно будет передавать?»
Owner: «Ну а если поменял приоритет, то это может привести к тому, что задачу нужно будет декомпозировать, чтобы
сделать блокирующую часть»
Owner: «Я предлагаю так. Все, что человек меняет сам - это заявка. То же самое, что он пишет агенту, это тоже заявка. А
заявку обрабатыват агент.»
Proposal put back: every human action (a form edit, a drag, a priority change, text to the agent) is a request, kept
verbatim (a form edit is a request whose wanted change is exact); the agent applies it with its consequences, or
declines with a reason, or asks; until processed the entity shows it as pending and its state is unchanged; rights are
checked against the requester.
Owner: «Да. И значит нужно добавлять согласование ответственным, какой-то отдельный раздел у вас на согласовании.»

Agreed: Andrey's "people edit directly, the agent is optional" is replaced. The agent's processed result (the change
and its consequences) goes to the responsible person for approval before it applies, in a section of its own «На
согласовании».
Follow-up proposal put: (1) a person files a request; (2) the agent prepares a package — the change and its
consequences — and applies nothing; (3) the package goes for approval to the responsible person of each feature it
touches, shown under «Ждёт вас» as «На согласовании» with a count; (4) approve whole, decline with a reason, or return to
the agent with a remark — it applies only when approved, as one operation; (5) a requester who is himself responsible
still approves, since he sees the consequences for the first time.
Owner: «Да. Это, конечно, бюрократия, но агент покажет связи и риски.»

## Q-queue.1 No taking out of order; the server rechecks at the take

Context: concept.md "Queue ordering and taking work". Proposal put: the "can take" list is a hint, not a grant; at the
take the server rechecks priority, blockers, reservations and the cap, and refuses if anything changed; one cannot
take less urgent work while fitting, more urgent free work exists — the refusal names it, or says so without details
when rights hide it; only the product owner grants an exception to the order, recorded with who, on what and why;
ordinary in-order work needs no permission.

Owner: «Ну да, сервер должен проверять перед взятием.»

## Q-queue.2 Equal levels run in parallel

Context: concept.md vocabulary "Priority level … Equal levels permit parallel work". Proposal put: features on one
level may be taken at once in any order; strict order holds only between levels; "earlier" is said by a higher level
or a "blocks" link.

Owner: «Да»

## Q4.1 Transport without a server: one shared ref, an operation per file; madarch shows contradictions

Context: design.md / ADR 0035 proposal — operations on a dedicated Git ref, with Git's atomic ref update (CAS) as the
arbiter of takes. Proposal put first: start with a madarch server as transport, defer Git transport.
Owner: «Нет. Каждый человек отправляет свой набор изменений. git сам ничего не решает. Если есть противоречие, то нужно
показывать его в madarch»
Proposal put: a ref per person, append-only; every madarch reads all and folds them by one rule; contradictions are
problems decided by a person with the right; with a central server it still grants reservations; operations signed by
the person's key, not trusted by commit author.
Owner: «А ты уверен, что каждому члену команды нужна своя ссылка?»
Proposal put: no — one shared ref, each operation a file named by its random id: no two people ever edit one file, so
Git merges concurrent pushes with no conflict; a rejected push is fetch, merge, push again — Git decides no meaning;
a copied database adds nothing (same operations, same files); contradictions in meaning are shown by madarch as
problems; every operation signed by its author.
Owner: «Да»

Agreed: Git is delivery only, never an arbiter; Andrey's CAS-on-ref arbitration is dropped.

## Q0033.29 — what replaces "a person says yes to every task; only a person merges"

Proposal put: the queue order (owner priority, blockers, reservations, per-responsible cap) is the permission to start; merge follows the lanes of Q3.1 (C: an agent merges, B: a person approves, A: a person and a second responsible person); an agent budget in the product settings, past which the next task waits for a person's yes.

Owner (2026-11-08): «Ну да, ок. Только тут нужно понимать какая задача разрешена агенту а какая нет. Как сделать разделить?»

Open: how a task is marked as allowed to an agent or not.

Answer put: every task carries an "executor" property (agent or person); the manifest gives the default per kind; the agent sets it while processing the request and splits a task whose part belongs to a person; the responsible person sees it in «На согласовании» and may change it; an agent takes from the queue only tasks whose executor is an agent (checked like priority and blockers, on the server when there is one). Lanes stay separate: they decide who merges, the executor decides who does the task.
Owner (2026-11-08): «Да, хорошее предложение. И здесь тоже нужно продумать жизненный цикл задачи для агента. Сначала он должен разобраться что делать и все ли ему понятно и если непонятно, то придти за уточнениями. Разработка, ревью, тесты. Что еще?»

Open: the agent's task lifecycle.

Answer put: the agent's task lifecycle — take (server checks the reservation) → read (task, linked entities, decisions, the request's words) → clarify (question to the responsible person, status "awaiting clarification", reservation released, next task taken) → plan with a checkable done criterion (split if large or partly a person's; on lane A the plan is approved first) → development in its own branch → tests and checks → review by another model that does not know which model wrote the code → acceptance against the criterion where a user sees it, with evidence → merge by lane → after merge: main CI, wiki refreshes, task closed with evidence → accounting (time and cost; findings become new requests). Pauses: blocked, out of budget. Default lifecycle of the agent task kind in the starter manifest.
Owner (2026-11-08): «Учет должен проходить по каждому шагу, а не в конце»

Agreed with the change: time, cost and tokens are recorded on every step as it ends (each step is a span on the task), not once at the end.
Put: no final accounting step; each step writes duration, tokens, cost, model and outcome as it ends; the budget is checked before every step (out of budget mid-task pauses on the current step, nothing lost); findings become requests when found. Rest of the lifecycle unchanged?
Owner (2026-11-08): «Да»

Agreed: the agent task lifecycle above, with per-step accounting.

## Plan — order of Andrey's checkpoints

Put: M0 (these decisions) → L1 local tracker → I1 agent lifecycle and lanes → G1 serverless sync → O1 load, snapshots, cutover; br import moved to O1.
Owner (2026-11-08): «Еще нужна задача по созданию сущностей в каталоге»

Open: where the task that adds the tracker's kinds to the catalog goes.
Put: the catalog task (the tracker's kinds) as the first task of L1, before storage and screens.
Then put: an epic above the feature; many requests per piece of work (a request is one human utterance, the lifecycle belongs to the task); further kinds: milestone, stage, bug, question (agent's clarification, blocks the task), review finding, evidence, merge, lifecycle step (the per-step accounting record); plan and done criterion are parts of the task, not kinds. Hierarchy: milestone → epic → feature → stage → task/bug; the rest attach by links.
Owner (2026-11-08): «Давай пробовать»

Agreed: the order M0 → L1 (catalog first) → I1 → G1 → O1, the epic, many requests, and the kinds above.

## Arch.1 Processes become roles: api and fill (2026-11-08, after PR 222)

Owner: «А откуда у нас несколько процессов?» → (the fill and read worker processes exist because PGlite blocked its thread; with a real PostgreSQL server the read worker is no longer needed)
Owner: «Давай обсудим. Можем собирать назад в один процесс, в монолит. Взаимодействие с БД должно идти через единый модуль абстракции. С другой стороны веб-сервер и заполнение и правда стоит разделить. Причем это особенно важно, когда таких репозиториев и изменениев станет больше, тогда мы сможем горизонтально масштабироваться. В локальной работе это не важно, а вот в серверной очень важно, код же у нас будет единый.»
Owner: «Не знаю. А как лучше? Может быть веб тоже разделить? Само веб-приложение и отдельно api и mcp, а также отдельно заполнение?»
Put: one binary, a role per instance by flag: `api` (HTTP, MCP and the built web files; stateless, scaled behind a balancer) and `fill` (workers taking jobs from the PostgreSQL queue; scaled by count). Roles talk only through PostgreSQL; all SQL through the one storage module. The read worker goes. Web files are static assets, served by `api` locally and by a CDN or nginx on a server. A separate `mcp` role only if its load ever differs. Locally `madarch serve` runs `api` in its process and one `fill` as a separate process of the same binary, so local behaves as the server does.
Owner: «Звучит хорошо.»

## Arch.2 The public read-only wiki of madarch runs with a back end, not as static files (2026-11-08)

Owner: «А еще, я потом хочу опубликовать вики madarch, чтобы показать как это будет выглядеть. В режиме read-only. Как это реализовать? Генерить статику? Или с бэком, который следит за репозиторием?»
Put: the same two roles — `api --read-only` (pages, search and MCP; every write refused by the API) and `fill` following madarch's repository and filling each new commit on main — on one small server with PostgreSQL, only `api` exposed, with a request rate limit. Static export rejected: no search, graph queries or MCP, no live filling, and a second serving surface.
Owner: «Да»

## Ent.1 Work is done on entities of every kind; the task is one kind among them (2026-11-08)

Owner: «Почему мы не делаем сейчас каталог сущностей?» → (task madarch-lk4r.2 started) → «А как же те отдельные сущности, которые мы с тобой обуждали ранее?» → (comment, link, time moved to a common area) → «А еще? Поищи, мы там обсуждали дизайн, безопасносить, sre и прочие разделы.» → «Блин, ну какая работа? О чем ты? Я с тобой говорю о уникальных сущностях. Ты меня не понимаешь?» → «Так а почему это виды? Я тебя не очень понимаю. Вот давай представим. У меня возникла идея, регистрируем сущность. Затем мы расписали US, создали несколько со связью к идее. Потом мы сделали исследование, тоже сущность.»
Put: a kind is the type ("Idea"), an entity is one instance; the product's life is a chain of entities of many kinds linked to each other (idea → user stories → research → design → requirement → decision → task → code → test → release → incident → postmortem); lifecycle, responsible person, executor, priority and per-step accounting belong to an entity of any kind people or agents author, not only to a task; the agent works on them directly (writes the stories, runs the research).
Owner: «Ну кажется да. А ты что думаешь?»
Put: agreed, as ALM tools do (Polarion, codebeamer work items of any type with workflows); limits: kinds that come from code (function, file, endpoint) take no lifecycle or responsible person, only as-is and to-be; a task stays for work with no entity of its own (update a dependency, investigate) or spanning many; the queue is entities of any kind in a takable status, priority from the feature or epic they are linked to, the reservation on a subtree of the graph; the agent creates entities as drafts rather than tasks to write them. The catalog's Schema subgroup gains the shared parts lifecycle, responsibility (responsible and executor) and accounting; the manifest attaches them per kind.
Owner: «Ну кажется да. Только я тебя еще раз прошу показать мне на примере как это будет, чтобы оценить верно ли ты меня понял.»
Put: a worked example (an online shop: request R → idea I «Доставка в день заказа» approved → three user stories linked "refines", one declined with a comment → a question blocks a story → a research entity with its findings → design, requirement, architecture decision, code from the repository, a task for the code change through the agent's lifecycle, test, release, incident, postmortem; the idea's page shows the whole tree with statuses, responsible people and cost summed upward; the agent's queue mixes kinds).
Owner: «Ну да, похоже на то. Только вот этот ручной перевод заявок меня смущает. В диалоге с агентом это несложно. Но я же не будут постоянно статусы менять?»

## Ent.2 Statuses move by events declared in the manifest; a person only decides

Put: a transition names the event that moves it (a linked story created, a package approved, merged, its test passing), declared in the manifest beside the kind's statuses, run by the one engine; a person tells the agent what is needed, answers questions, approves or declines packages; approval may be given in the dialog with the agent (the same approval as in «На согласовании»; that section holds what did not come from one's own dialog); moving a status by hand stays possible and is a request like any change.
Owner: «Значит у каждого статуса должен быть подстатус? Типа ожидается согласование? Иначе мы потеряем текущий статус.»

## Ent.3 One status; approval, blocking and reservation are separate dimensions

Put: no sub-status; an entity has one current status; a pending approval is a package entity linked to it, shown as a mark beside the status, applied on approval, closed with its reason on decline, several at once allowed; "awaiting clarification" is not a status either but an open question linked to the entity which, with blocking links, makes it blocked; dimensions: status (one, by the kind's lifecycle), pending approval (open packages), blocked (open questions and blockers), reservation (who holds it) — each computed, as GitHub keeps review and conflicts beside a pull request's state and Jira Service Management keeps approvals apart from status.
Owner: «Да»
