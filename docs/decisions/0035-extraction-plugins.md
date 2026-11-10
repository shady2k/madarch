# 0035. Extraction plugins: every field has producers, plugins live in the product, the host keeps them in bounds

Status: accepted
Date: 2026-11-09

Builds on 0034 (one graph schema; item 7 authoritative and claimed fields; item 14 a table per
kind from its contract), 0033 (one workflow; capability boundaries of a stage), 0027 (registry,
orchestrator, exactly-once publication) and 0024 (madarch installs its own pinned PostgreSQL).
Agreed with the owner on 2026-11-09 in the talk that amended 0034; reviewed by Codex read-only the
same day.

## Context and problem

0034 as first landed fixed the code kinds (repository, directory, file, commit, signature) and
the edge `touched` in the engine's DDL, and the extractor that fills them in the engine's code. A
product that is only a tracker would still carry them, a product that needs one more field of a
file could not have it, and every new kind waits for a madarch release. The owner: «Ну подожди.
Контракт должен быть на нашей стороне. Или ты предлагаешь сделать это все расширяемым? Типа если
на стороне нашего кода не статического извелкателя, то тогда сам манифест с сущностью несет
объяснения для агента что это и как извлечь? И тогда наш продукт станет еще универсальнее, просто
больше токенов сожжется.»

## Decision

1. **A product starts with the plugins for the kinds it chose; a fill takes each kind in turn, its
   plugins first and then the agent.** At initialisation madarch puts its own plugins for the chosen
   kinds into the product's repository, and their kinds into the manifest. The choice is offered as
   templates (everything, only the tracker, others) with fine-grained inclusion and exclusion
   (everything but Kubernetes); the first version offers no choice and takes everything. A fill
   takes the kinds one after another in the order of item 11, and a kind's turn has the same three
   parts whatever the kind: every plugin and script the product holds for it runs, each writing its
   own proposal (vertices, attributes and claims with their sources); then the agent works the kind
   from the manifest's description of it and its fields, checking the proposals, adding what no
   producer found and settling where producers disagree; then the next kind. The agent may also take
   a plugin from madarch's upstream or write a script; what it adds is kept in the product, so the
   next fill runs it and leaves the agent less. When every kind has had its turn, the agent checks
   the whole result again, section by section of the catalogue, as 0033's top-down walk (items 16
   and 17). A product that chose none, or declares kinds madarch has no plugin for, starts with only
   its manifest for them. (Owner: «Ну не совсем, все наши плагины мы положим в репозиторий продукта
   при его инцииализации. Можно будет предлагать пользователю выбрать сущности, которые ему нужны.
   Например только трекер. Или исключить кубер, потому что его нет.» «Ну да. Можно дать несколько
   шаблонов: все, трекер, еще чего-нибудь. Ну и дать возможность тонкой настройки что-то включить
   или исключить. Сейчас в MVP это не нужно, берем по умолчанию все.» «Там где он умеет мы
   заполняем, там где не умеем - оставляем агенту. Агент ведь можешь написать скрипт и извлечь?»
   «Вот представь, у нас 4 позитории, мы начинаем работать над продуктом, ничего нет, никаких
   плагинов, только описание в манифесте продукта. Пользователь тыкает заполнить, он идет смотрит
   плагины, плагина нет. Значит, он все сущности обработал, где есть плагины, потом передает
   управление агенту.» «Может быть, мы тогда должны делить не по статическому прогону и агентскому,
   а обрабатывать по сущности, по порядку сущностей. Например, идем по каталогу сущностей. Первая
   сущность– файл. Наверное, нам нужно еще в зависимости где-то прописать в каталоге сущности. Это
   же каталог где будет лежать получается он в продукте должен лежать и сначала делать статические
   прогоны один скриптом статический или несколько может быть несколько скриптов для одной сущности
   они все записывают как свое предложение а потом по ней запускается агентская часть агентская
   часть отработала переходим к следующей сущности и так вот можно по разделам ну то есть а потом в
   конце агент еще раз все перепроверяет по разделам так наверное»)
2. **Authoritative fields have one producer; claimed fields may have many, measured.** A field's
   contract says which it is (0034 item 7). An authoritative field has exactly one producer,
   named in the manifest; its value is written as a column with one evidence row, and a second
   plugin declaring it is refused when the manifest is read. A claimed field may have several
   producers at once; each writes a claim with its source, and the accepted value is computed on
   read by the field's rule (the most accurate producer measured, a person's confirmation, or
   agreement), never copied into a column. Until stage (c) the rule is the one producer the
   manifest names first. Accuracy is measured against an independent reference graph, precision
   and recall per kind and field, with a held-out repository against fitting; a producer is
   improved by those numbers. (Owner: «при создании вершины или атрибута у нас могут быть
   несколько источников извлечения. Может быть даже несколько скриптов для извлечения и тогда
   можно будет оценить какой из них точнее и позволить улучшать скрипты извлечения.»)
3. **Plugins live in the product.** An extractor is a plugin kept in the product's repository:
   its contract (what it produces), its code and dependencies, its description for the agent and
   its version. madarch is the upstream of its own plugins; a product takes upstream updates by
   merge, and its own changes are commits. A script the agent writes is kept the same way, as a
   skill for extracting a kind or a field. (Owner: «Можно даже скрипты сохранять, которые агент
   напишет. Типа скилл для извлечения сущности, поля.» «все эти статические извлекатели должны
   быть плагинами, которые лежат в репозитории продукта. Агент их сможет обновлять и дорабаывать.
   Ну или получать обновления из апстрима»)
4. **A version is its closure, pinned by one hash; only an approved closure runs.** A plugin's
   closure is every file it may load (its code, its locked dependencies, its contract, its
   interpreter's pin) and its hash is one digest over them in path order. A run copies the closure
   into a private snapshot, checks its hash and executes only that snapshot, so a change in the
   product's working tree never reaches a running plugin. A closure a madarch release carries is
   trusted by the person's choice at initialisation (item 1) and needs no further approval; any
   other closure (changed in the product, written by the agent, an upstream update not yet taken)
   runs only after a person approves its hash, recorded as a journal operation (0034 item 10).
   Before approval a closure may run only as validation: the conformance kit and the accuracy
   measurement, in the sandbox, on fixture or reference repositories, publishing nothing.
5. **The host keeps a plugin in bounds.** A plugin is a separate process the host drives; it
   never runs inside the server. The host enforces, each with a default the manifest may lower:
   a handshake deadline (no introduction in time is a failure); a deadline per iteration (one
   unit: a file, a batch of commits) and one per run; a heartbeat deadline while a unit runs,
   suspended while the host holds the plugin paused, so a pause is never a timeout; a bound on one
   message's size and on a unit's total output, past which the unit fails, and on what the plugin
   writes to stderr, kept as its log. Pause and resume freeze and thaw the plugin's whole process
   tree; stop asks it to finish the unit and exit, and after a grace period becomes cancel;
   cancel kills the whole tree at once. A unit that fails or times out is recorded as not
   extracted with its cause, never dropped silently. Every iteration leaves a span and its log.
   (Owner: «Все плагины асинхронные обязательно, таймаут на каждую итерацию и общий таймаут, чтобы
   это все не зависало. Функция паузы, стопа и чего там еще.»)
6. **An iteration is a unit of the orchestrator.** Each iteration is bound to 0027's unit, its
   generation and its fence. A plugin's results are private to the host until the unit's
   publication: the orchestrator publishes them, writes the receipt and settles the queue's job in
   one transaction (0034 item 12), so a crash before that commit reruns the unit and one after it
   finds the receipt and publishes nothing twice. A stopped or crashed run resumes at its first
   unit without a receipt.
7. **One protocol, any language.** Host and plugin speak a published, versioned protocol
   (JSON-RPC over stdin and stdout). The plugin introduces itself with its contract, its version,
   the rights it needs (network profile, item 9) and its limits. The host hands it units; for a
   unit the plugin answers with any of: vertices (kind and key values), edges (kind, ends by kind
   and key, discriminator), attributes of authoritative fields, claims of claimed fields, evidence
   for each (repository, commit or content digest, path, lines), removals (an entity, edge or
   claim it produced before that the unit's input no longer holds), and the unit's end marked
   complete or partial with the cause. References inside keys are kind and key values, never node
   ids; the host resolves them (0034 item 14). The host validates every result against the
   plugin's declared output: a kind, field or edge kind it does not produce is refused, and a
   partial unit publishes no removals, so an interrupted unit never deletes what it did not see.
   Progress and errors with their cause travel the same channel. madarch's own plugins are
   TypeScript and run on the Bun inside madarch's binary; Python plugins run on a pinned
   interpreter madarch downloads, with its version and hash, the first time a plugin needs it.
   (Owner: «Плагины на чем? python? ts?» — «Да» to a language-neutral protocol, ours in
   TypeScript, Python on demand.)
8. **An SDK and a conformance kit.** The SDK (TypeScript and Python) carries the protocol, the
   heartbeat, cancellation and batching, so a plugin's author writes one function: extract from
   a unit. A conformance kit checks a plugin against the protocol and its contract (validation,
   item 4), and a local runner runs it on a fixture repository. (Owner: «Значит нужен sdk плагина?
   Котракт?»)
9. **A sandbox.** A plugin sees a read-only snapshot of the repository, its closure read-only, a
   writable temporary folder, an empty environment, no home folder and no credentials. Its output
   leaves only through the protocol. The mechanism follows Codex CLI's (read at 27fcd7cb):
- On Linux, bubblewrap that madarch downloads pinned and checks by its hash before each use (as
     Codex checks its bundled bwrap, `codex-rs/linux-sandbox/src/bundled_bwrap.rs:151`), with the
     snapshot bound read-only, all namespaces unshared, the environment cleared, the process dying
     with its parent, and a seccomp filter refusing io_uring and ptrace and, by profile, sockets.
     Memory and CPU are limited by cgroup v2: the plugin's whole process tree runs in a cgroup of
     its own under one delegated to madarch with the `memory`, `cpu` and `pids` controllers enabled;
     the limits are set before the first instruction of the plugin runs, freezing is the cgroup's
     freezer, and cancel kills the cgroup, so no descendant escapes by changing its session or
     group. The host checks the delegation before a run; where it is missing, or unprivileged user
     namespaces are, no plugin runs and the host raises an operations problem naming what to enable.
     It never runs a plugin unconfined, in any stage and whatever its origin; the release trust of
     item 4 is about approval, not confinement.
   - On macOS, `/usr/bin/sandbox-exec` with a deny-by-default profile. There are no cgroups:
     rlimits bound each process (memory, CPU time, open files, processes), and the host tracks
     the tree by process group and kills it by group; a descendant that leaves the group, which
     the profile does not reliably prevent, is outside these bounds. This is a known limit on
     macOS, stated in the operations page, not hidden.
   - Two network profiles. *None*, the default: the network namespace is unshared on Linux and
     the profile denies network on macOS, and the seccomp filter refuses socket creation. *Proxy
     only*, when the plugin declares named domains and a person approves them with its closure:
     the plugin may open sockets only to a Unix socket bound into the sandbox, behind which
     Anthropic's sandbox-runtime proxy (Apache-2.0, pinned) allows those domains alone; no other
     address is reachable.
   Neither Codex nor Claude Code's sandbox-runtime limits memory or CPU; these limits are
   madarch's own. (Owner: «Вот посмотри Codex CLI и Claude Code. У них точно есть своя
   песочница.»)
10. **A failure is operations' problem; the agent proposes the fix.** A plugin's failure is a
    problem for madarch's operations role, not the product's readers: the plugin, its closure
    hash, the unit it failed on, the cause and a link to its trace, with equal failures folded
    into one problem with a count. A page shows the missing value as not extracted, with a link
    to the problem. The agent may take the problem, reproduce it on the same unit in the
    sandbox, write a new version on a branch of the product, validate it (item 4), and propose
    it with the diff and the numbers; a person approves the new closure's hash before it runs.
    (Owner: «И если в плагине произошел сбой, то это появляется в проблемах для роли
    администратора или эксплуатации madarch? И агент сможет сам предложить исправление.»)
11. **Order follows the catalogue's declared dependencies.** The catalogue of kinds is the product's
    own, kept in its repository as part of the manifest, and each kind in it declares which kinds
    its discovery depends on, apart from the relations a reader navigates (0033 item 15); a plugin
    declares the kinds it reads (its inputs) and writes (its outputs). A fill walks the catalogue
    section by section in the order those declarations give: a kind's turn (item 1) starts only when
    every kind it depends on has finished its turn, and kinds that do not depend on each other take
    their turns in parallel. Until agent runs exist (stage (d)), a kind's turn may end with its
    agent part recorded as pending: the turn then counts as finished for the kinds that depend on
    it, but its coverage is marked agent pending, on its pages and on the dependency-graph page
    (item 14), never as fully covered, and the final check by section stays pending as well. A
    plugin that writes several kinds runs once, in the turn of the earliest of its output kinds in
    the dependency order; what it writes of later kinds stays private in the host and is published
    at the start of each such kind's turn, before that kind's other producers and its agent part. A
    plugin's inputs must lie in the dependency closure of its earliest output kind, and the manifest
    check refuses a plugin whose inputs do not. A cycle among the kinds' declared dependencies is an
    error of the manifest that names the kinds, and no fill starts while it stands. At
    initialisation, and in the later choice by template or by inclusion and exclusion, a chosen kind
    brings in the kinds it depends on, and excluding a kind another chosen kind depends on is
    refused with the dependants named. (Owner: «Только тут важен порядок. Помнишь мы в каталоге
    сущностей прописывали зависимости?»)
12. **Orphans are found, never kept silently.** After each kind's turn and in the final check, the
    host looks, among the kinds whose turn has finished, for: a vertex missing a relation its
    contract requires (a symbol without its file, a file without its repository); an edge whose end
    is removed, or tombstoned in the context the edge is read in; a claim without evidence, and
    evidence that points at nothing. Each is a problem naming the kind, the entity and the cause,
    and the agent works it in that kind's turn; a fill never drops an orphan without saying so.
    (Owner: «И еще нужно проверять orphaned вершины и ребра»)
13. **Concurrency is a setting.** The product's settings say how many plugins run at once and, for a
    plugin that declares in its introduction that it takes several units at once and up to how many,
    how many units it is given at a time; the host hands out no more than the smaller of the two,
    and kinds' turns that may run in parallel (item 11) share the plugin count. A plugin that
    declares nothing gets one unit at a time. The memory and CPU limits of item 9 bound the plugin's
    whole process tree whatever its count of units. (Owner: «Да, плюс настройка количества
    одновременных плагинов и потоков в нем, если плагин поддерживает многопоточность»)
14. **The dependency graph is a page.** The wiki's catalogue of kinds shows the graph of declared
    discovery dependencies (item 11), and during a fill the kind whose turn it is, the kinds done
    and the kinds waiting, with each turn's plugins and its agent part. (Owner: «А еще нужен
    dependency graph для сущностей, чтобы мы знали в каком порядке запускать. Например извлекать
    кубер без обработки файлов нельзя. Может быть нужно прописывать для сущности зависимости?» —
    «Да» to showing it as a page.)
15. **Plugins work from the graph.** A unit the host hands a plugin is a vertex of the graph (a file
    with its blob, a commit), never a path the plugin found by walking the repository itself, and
    its inputs (item 11) are vertices and fields the graph holds. Whatever the graph already holds
    the plugin asks the host for, through the protocol's read-only queries bounded in the size of
    their answer (by kind and key, by neighbourhood), and never derives again from the sources; it
    reads repository bytes only for what the graph does not hold, such as a file's content by its
    blob, through the host and inside the sandbox's snapshot. The first vertices come from the
    manifest: it names the product's repositories, and before the first turn the host makes a
    repository vertex for each. The git plugin's unit is such a repository vertex, and it reads
    git's objects through the host's repository access, so no plugin walks the sources on its own.
    (Owner: «И обрати внимание что все плагины работают по графу. Если информация есть в графе -
    берем оттуда.»)

16. **The engine fills nothing.** madarch's engine is the mechanism and the host: it holds no
    kind, no field and no extraction of its own, and has no right to write a fact. Every fact comes
    from a producer: a plugin, or the agent in one of its two modes, Jev or a large language model;
    later producers may join, such as one that reads an external system over the network. A kind
    with no plugin is not a gap: the agent writes its extractor as a plugin of the product (item 3)
    and that plugin fills it, so static extractors are never required. Several plugins, or several
    versions of one, may fill the same kind, each adding its claims to the vertex (item 2). A fill
    goes from the general to the particular: a later kind's turn may find a vertex or an edge an
    earlier turn made to be wrong, and corrects it by a new claim with its grounds over the old one,
    never by overwriting it in silence (0034). (Owner, 2026-11-10: «У нас в движке ничего нет. У
    нас все заполнения делают две вещи. Либо плагин, экстрактор, либо агент.» «если у нас нет
    плагина статического, вот как сейчас, его нет, у нас агент пишет этот экстрактор сам.» «Наш
    движок сам ничего не заполняет. Это ядро. Он заполнять ничего не умеет. У него нет таких прав.»
    «у нас идет от общего к частному [...] те вершины графа и ребра графа, которые мы уже создали,
    вполне возможно оказались неправильными, их нужно скорректировать.»)
17. **A manifest field names its producer explicitly.** A field of a kind in the manifest is bound
    as `<plugin>@<major>.<field>` (for example `git@1.path`) or as `agent` with a description of
    what it is and how to extract it; a table is built from these declarations alone (0034 item
    14), for any kind, with no code per kind. A name that equals a plugin's field is only a
    suggestion: the check proposes the binding and it is written into the manifest; a differing
    name goes to the agent, which compares meanings and proposes a rename, or writes or extends a
    plugin. (Owner: «А как нам соотнести поля в манифесте с полями в плагине? [...] Манифест правят
    же люди, они могут и ошибиться вполне себе.» — «Да, давай делать привязку полей явно. То есть
    мы указываем там плагин.такое-то поле, допустим, git.fileName.»)
18. **A plugin declares its required fields.** A plugin's contract states, for each field it
    produces, its type, its meaning, an example and whether it is required. Required are the
    kind's natural key (the unique index of its table: a file's repository and path) and every
    field the plugin cannot run without. A manifest that binds a kind to a plugin but leaves out a
    required field is the manifest's error. (Owner: «Наверное, какие-то вещи из плагина...
    Обязательно должны браться, иначе он не сможет запуститься. [...] Например, без имени файла
    пути, ничего не получится.» — «Это тогда ошибка в манифесте, да, получается?»)
19. **An invalid manifest is not loaded.** The manifest check runs at every load and names every
    error with its file, line and what to fix: a field with no producer, a binding to a field no
    plugin declares, a type mismatch, a missing required field, a cycle in the kinds' dependencies,
    an unknown kind in a relation. A manifest with an error is not loaded, and the product keeps
    working on its last valid manifest and its tables. (Owner: «Нам, кстати, нужен механизм...
    Проверки корректности манифестов. Который покажет ошибки, если они есть. И не загрузит
    некорректный манифест.»)
20. **A plugin has a version and the product locks it.** A plugin's version is semantic: a major
    version may change its required fields or their types or meanings, a minor one adds optional
    fields, a patch changes no field. The manifest binds a major version (item 17); the product's
    `madarch/plugins.lock` records each plugin's exact version and closure hash (item 4), and a
    fill runs exactly what the lock names, on any machine. A minor or patch update that passes the
    manifest check updates the lock, as a commit, once its closure is approved. A major update that
    requires what the manifest does not give is not a break: the product stays on the locked
    version, a problem names the new requirement, and the agent proposes the manifest change; the
    new version runs once the changed manifest passes the check. (Owner: «Можно, наверное, еще
    сделать нумерацию версий плагинов. Ну и типа указывать в манифесте, ты же там предлагал какой-то
    lock файл.» — «Да.»)
21. **A failing plugin is switched off.** A plugin has a state: enabled, or disabled with its
    reason and time, and its failure count. Past the failure policy's limit a fill switches it off
    and raises the problem of item 10; an administrator switches it on again once it is fixed, and
    the next fill uses it. (Owner: «Если плагин сбоит, его у него должно быть состояние, его
    необходимо отключать, да, потом через админку можно будет назад включить, если он исправлен
    уже»)

22. **Agent filling is a plugin too.** The engine runs plugins and nothing else; how a plugin finds
    its facts is its own. A plugin declares what it needs from the host: graph reads, file bytes by
    blob, a model (Jev or a large language model, with a token bound), the network to named
    addresses (an external system such as an inventory system); the host grants only what is
    declared and allowed by the manifest or an administrator. Model and external-system credentials
    stay with the host and never enter the sandbox: the plugin asks, the host calls. So there is one
    mechanism for a static plugin (a parser, git), an agent plugin (the statements of a page, where
    only a model can help), a mixed one (a parser finds candidates, a model decides the doubtful
    ones) and an external one. madarch ships a general agent plugin that fills any kind from its
    manifest description, so a kind with no plugin of its own is filled at once, at the cost of
    tokens; the agent writes a static plugin where one can do the work (item 23). Agent plugins
    carry everything other plugins do (versions and the lock, bounds, pause and cancellation, the
    failure state, accuracy and comparison between producers) and a token and cost bound per run.
    Every model call is metered: the model, the tokens in and out and the cost, per plugin run,
    kind and field, and the wiki shows them. (Owner, 2026-11-10: «Может быть агентское заполнение
    это тоже должен быть плагин? Как ты считаешь?» — «Да, очень хорошее предложение. Давай так и
    сделаем. Нам и правда нужно измерять количество токенов, которые мы потратили. Какая модель это
    заполняло. Все это нам необходимо знать и видеть.»)
23. **A kind a static plugin could fill raises a technical task.** When a kind or a field is filled
    by an agent plugin and a static plugin could do the same work, the fill raises a task in the
    product's own task kind: write a static plugin for it, with the tokens and cost the agent spends
    on it today. It is technical backlog: it does not change the product, it makes filling it
    cheaper, and it is what the agent takes up when it works autonomously from tasks. (Owner: «если
    для этого вида возможен статический плагин то должна появляться задача на создание плагина но у
    нас же есть уже в нашей вики такая сущность задача [...] Мы же хотим дальше делать именно
    автономную работу [...] эта задача будет техническая. Не связанная напрямую с продуктом, но
    улучшающая. Его делающего дешевле. [...] Поэтому это технический бэклог. Фактически.»)

24. **The source filesystem is a capability granted on request.** A plugin declares the capabilities
    it needs (item 22); the filesystem of the sources (the product's repository folder, the code
    repositories' checkouts and git) is one of them, granted only to a plugin that requests it and
    is allowed it by the manifest or an administrator. The files plugin is the first such plugin: it
    stores each text file's content in the graph, keyed by its blob so an unchanged file is stored
    once, as a field of the file kind; a plugin without the capability reads files, their content
    included, from the graph through the protocol's queries, and the host refuses it any other
    access. This narrows item 15: reading a file's bytes is no longer open to every plugin. A
    watcher of the sources holds the same capability on the same terms: it sees a file change and
    queues the fill of that file alone, the increment. (Owner, 2026-11-10: «Все верно, с исходной
    файловой системой работает только плагин файлов у нас сейчас на данный момент, больше никто.»
    — «Да, и то не всем плагин доступна fs» — «Не только плагин файлов, а тот плагин, который
    запрашивает это разрешение.» — «И слой, который будет следить за fs, чтобы делать инкремент»)
25. **A kind may have any number of producers of different sorts.** The glossary's terms, for one,
    are found in code identifiers, in code comments, in the repository's documents through the graph,
    and in conversations with a person: a term that appears in a talk is written by the agent in the
    person's own words, with the conversation and its time as its evidence. Each is a producer of the
    same kind. (Owner: «Да, глоссарий берется из графа и обсуждений с пользовтелем. Вот мы с тобой
    разговариваем и появляется новый термин.» — «Ну все-таки у терминов не два источника. Мы можем
    найти термин из кода, из комментария в коде, из документов в репе.»)
26. **A file's text is in the graph, and the graph says how fresh it is.** The files plugin stores
    each text file's content in the graph once per blob, for the blobs a current layer refers to (the
    main line and the active branches); a blob no layer refers to is removed, history is not copied
    (the files plugin reads it from git when asked), and a binary file or one over the product's size
    bound keeps its metadata only, its page saying why. Content keyed by its blob never goes stale:
    the graph states what holds at a commit. Whether the disk still matches is a separate question,
    answered by one files plugin in three operations sharing its rules (ignores, text or binary,
    hash, lines) and its record of each file (size, modification time, inode): the snapshot of a
    repository; the reconciliation of a tree on a timer, which compares each file's recorded size,
    time and inode with the disk, rehashes those that differ and queues the changed ones (the
    safeguard against a lost event, and the main path where events are unreliable, as on a network
    disk, its interval a setting); and the check of one file, run when a person opens its page or an
    agent asks about it through MCP. Watching for change events is the host's: a long-lived part of
    it receives "this path changed" from the system and asks the files plugin to check that file; it
    reads nothing itself, and only the files plugin writes the facts. Every read from the graph (the
    wiki, MCP, a plugin) carries the graph's freshness: its commit, when the disk was last reconciled,
    and how many changed files are not in it yet; a page whose file differs on disk says so and that
    it is being refreshed. This follows git's index and Watchman's recrawl. (Owner: «Но у нас же в
    графе нет текста файла. Или должен быть?» — «Он может устареть, текст файла в графе. Давай
    представим себе, что на диске файл изменился, но почему-то наш слушатель не получил это событие.
    [...] Поэтому наверное нам с тобой все-таки нужен какой-то плагин, который будет читать
    непосредственно с диска.» — «Да, кажется, это хорошая идея. Только, может быть, нам нужно тогда
    три плагина? Или все-таки ты считаешь, что должен быть один с тремя режимами?» — «Да» to one
    plugin with three operations and the watcher in the host.)
27. **MCP reads the graph and says what the graph does not know yet.** MCP answers with facts from
    the graph only, and beside them the reconciliation of the agent's checkout: which files on disk
    are changed and not yet filled. (Owner: «Еще момент, у нас еще есть mcp, который тоже должен
    иметь доступ к fs.»)

28. **The agent writes a static plugin inside the kind's turn.** Where the agent finds no static
    plugin for a kind and judges that one would do the work cheaper (the facts follow from structure,
    and the tokens the agent would spend on every unit outweigh writing it), it writes the plugin in
    the same turn, with tools the host gives it: create a plugin from the SDK's template, change one,
    validate it (the conformance kit and the manifest check), run it in the sandbox on sample units
    publishing nothing, and compare its answers with the agent's own on that sample. The sample the
    agent fills by hand is small and becomes the plugin's tests and the reference its accuracy is
    measured against. A plugin that reaches the accuracy bound on the sample fills the kind's
    remaining units in the same turn, and the agent takes only what the plugin marks doubtful or
    cannot do; one that does not leaves the agent to fill the kind and raises the technical task of
    item 23 with what failed. Writing a plugin has its own bound (turns, tokens, time): past it the
    agent fills the kind itself and files the task with where it stuck. (Owner: «Если агент понимает,
    что статического экстрактора нет, а он здесь подошел бы больше и более того агент сам пишет
    плагин, сам пишет экстрактор в рамках этой же итерации, то, наверное, логично в этой же итерации
    его плагины и записывать. Соответственно, агенту нужно дать какой-то инструмент по созданию или
    обновлению плагина [...] То есть это не замена агентскому проходу» — «в любом случае, нашему
    агенту потребуется потом сравнить результаты [...] Разработка этого плагина, она же ими, она же
    не быстрая. Там несколько итераций, возможно, у агента что-то пойдет не так, он может вообще
    надолго застрять.»)
29. **Approval follows the effect outside the graph; the graph is guarded by construction.** A
    plugin never writes the graph: it returns claims, and the host writes them after holding them
    against the plugin's declared contract. A plugin retracts only its own earlier claims, and a
    vertex stands while any producer claims it, so a plugin cannot remove what git, another plugin
    or a person stated. A run that would retract an unusual share of its own claims (a bound in the
    settings) is not applied: it stops as suspicious and raises a problem. Every claim names its
    producer and version, so switching a plugin off removes its claims from the effective graph and
    restores what was there, and a claim of a plugin no person approved is marked as such and loses
    to an approved producer of the same field (stage (c)). So writing claims needs no approval, and
    this narrows item 4: approval of a closure's hash is required where a plugin can act outside the
    graph, that is for the network and for writing to the filesystem; reading the source filesystem
    is allowed by the manifest (item 24); a model call is a cost, bounded by the token and cost
    limits of item 22, not approved. A plugin the agent writes inside a turn (item 28) that asks for
    graph reads only, or file reads the manifest allows, runs at once with its claims marked
    unapproved; one that asks for the network or for writing waits for a person's approval. (Owner:
    «одобрение нужно там, где плагин каким-то образом может повлиять на внешний мир. [...] Хотя, у
    нас же любой плагин вызовет модификацию графа, да? [...] Возьмет какой-нибудь новый
    непроверенный плагин и удалит все узлы, да? Такое же тоже возможно. Подскажи, как лучше сделать.»
    — «Да» to this answer.)

30. **A plugin is the only unit of filling; it has parts, and there are no stages.** A plugin
    declares the parts it uses: a static part (parsing, git, formats), an agent part (model calls,
    Jev or a large language model) and a network part (requests to an external system), in any
    combination: static only (git), agent only (the statements of a page; the general agent plugin
    of item 22), static and agent (a parser finds candidates, a model decides the doubtful ones),
    static and network (an address from the configuration, then a query to an inventory system).
    The engine runs each kind's plugins in the catalogue's dependency order and nothing else; the
    order "plugins, then the agent" of item 1 is now each plugin's own order between its parts, and
    item 1's turn is "the kind's plugins". The agent writing a static plugin (item 28) adds a static
    part to a kind's plugin or writes a new one; the rights of item 29 are counted by the parts a
    plugin declares. (Owner: «Ну да, тогда получается агентский проход– это просто часть нашего
    плагина. Ну, как бы, получается, что у плагина будет несколько разделов. Статический проход плюс
    агентский или просто статический или просто агентский. Или еще вызов сети. То есть фактически
    нет никаких стадий. У нас все это является одним плагином.»)
31. **A fill may target part of the catalogue.** A person starts a fill of one kind, a section of
    the catalogue, one plugin, the static parts only, or one scope (a repository, a folder, a file),
    in one of three modes: with what it depends on (the default: stale dependencies first, fresh
    ones skipped), this only (dependencies untouched, a stale one named), or with its dependants
    (what depends on it recomputed after it). The dependency-graph page (item 14), the CLI and MCP
    start it with the same parameters. (Owner: «Когда мы нажимаем заполнить, нам не всегда нужно
    заполнять все и проходить по всему. Каталогу сущностей иногда хочется запустить какой-то
    конкретный шаг давай подумаем как это реализовать» — «Ну да» to targets and three modes.)
32. **Consistency is checked by a plugin.** The engine keeps only the integrity the database itself
    enforces (an edge cannot point at a vertex that does not exist). What makes a graph consistent is
    a plugin's work, run at the end of a fill and on its own: every vertex and edge has at least one
    claim with its evidence; a vertex without the relations its contract requires, or without any
    edge, is examined for what is wrong with it; the final recheck by section is the same plugin's
    agent part. It may later correct what it finds, as any producer does, by claims. This replaces
    the host's own orphan search of item 12 with a plugin over the same rules. (Owner: «по сути
    дела, поиск висящих вершин и ребер– это точно такой же плагин. [...] мы же в конце должны
    проверить, что все узлы и все ребра– хотя бы раз кем-то проверены, то есть у них есть источник у
    всех. Если у нас есть вершина без ребер, ну это странно. Если есть ребра без вершин, это еще
    хуже. [...] Который просто следит за консистентностью да он в конце должен быть может быть потом
    мы еще что-то добавим исправление какие-то»)

33. **Reconciliations, from Codex's review of items 16-32.** The first vertices are the files
    plugin's: it reads the manifest's repositories and makes their repository vertices, so the host's
    bootstrap of item 15 becomes that plugin's first unit and the engine writes no fact (item 16). An
    authoritative field (item 2, 0034 item 7) is still its one producer's statement with evidence:
    "a claim" in items 16, 29 and 32 covers a vertex's existence, its authoritative fields and its
    claimed fields alike, and a correction of an authoritative field is a new statement of its
    producer or an overlay of 0034, never a second producer. A read of one file keeps 0034 item 9's
    guarantee: the check of one file (item 26) runs first and its answer reflects the disk; a read
    over many files answers from the graph with its freshness (items 26, 27). The sample an agent
    fills by hand while writing a plugin (item 28) is the plugin's development test; its accuracy is
    measured as item 2 says, against an independent reference and a held-out repository.

## Consequences

- madarch's engine becomes the mechanism (graph, claims, layers, journal, queue) and the plugin
  host; today's git reader becomes the first plugin of madarch's upstream, put into every product
  at initialisation (until templates come, stage (e)), and keeps its contract.
- A product launches with the kinds it needs before madarch has a static extractor for them:
  the agent fills them from their description, at the cost of tokens and accuracy, and a static
  plugin later replaces the agent with the same contract and the same pages. (Owner: «Вообще да,
  такой подход мне нраавится. Мы сможем запустить продукт быстрее и он сможет дописывать сам себя
  в части работы над сущностями.»)
- Stages. Stage (a) lands in four increments, each keeping main working and each observable on its
  own: (a1) product packaging and manifest preflight: initialisation copies madarch's plugins and
  contracts into the product, closures are hashed, and producers and dependencies are checked, so a
  product holds its plugins and an invalid manifest is refused before any work starts; (a2) confined
  plugin execution: the host with its protocol and bounds (items 5 to 7) and the sandbox (item 9),
  with the git reader moved into the first plugin through the existing publication boundary and its
  old execution path deleted, so extraction still works and a timeout, a cancellation or a crash is
  recorded with its cause; (a3) one atomic graph cutover: generated tables, identity resolution,
  claims and reads in the effective context, with every wiki and MCP consumer moved and the replaced
  stores deleted in the same landing, so catalogue counts, entity pages and MCP agree; (a4)
  catalogue turn orchestration: dependency barriers, agent-pending coverage, the orphan check, the
  concurrency settings and the dependency-graph page (items 11 to 14), so a reader sees which kinds
  are done, waiting or pending the agent. madarch-8bdc.2.11 carries them. Later: (c) several
  producers per claimed field, the accepted-value rule and accuracy measurement; (d) agent-written
  plugins and fixes and upstream updates, which run a real agent and start on the owner's yes; (e)
  templates and fine-grained inclusion and exclusion of kinds at initialisation. The sandbox is no
  separate stage: no plugin runs before (a2) gives it one.
- Left to the implementing changes, each stated there before code (Codex, 2026-11-10): the
  producer's identity the host authenticates and a claim's identity across versions, so "only its
  own" retraction and switching a producer off are exact; the retraction bound's denominator and
  scope; the consistency plugin's declaration of a whole-graph read and its place after every
  kind's turn, also in a partial fill; the representation of file content shared by blob and
  referenced from each context's file row, with worktrees, uncommitted content and pinned bases;
  the budget an in-turn authoring shares with its validation and trial runs, and how a new
  plugin's code, contract and lock entry become active at once; how the claims of separate plugins
  on one field are settled and what a correction or a switched-off producer invalidates
  downstream; and who judges that a static plugin is feasible and how its technical task is not
  raised twice.
- Invalidation through recorded graph queries is to follow Bazel's Skyframe
  (https://bazel.build/reference/skyframe): the queries a plugin makes are recorded as its
  dependencies, empty answers and query membership included, and a recomputed output that did not
  change stops invalidation downstream. It extends 0027's tracked reads; it is not a new scheduler.

## Review

Codex, 2026-11-09, read-only over the draft: asked that authoritative and claimed fields be
told apart now (item 2, with 0034 item 7), that iterations be bound to 0027's publication (item
6), that the protocol carry every result type and partial units (item 7), that handshake,
output and heartbeat bounds and stop escalation be stated (item 5), that approval pin the whole
executable closure and validation be told from production runs (item 4), that cgroup delegation
be required and fail closed (item 9), that descendants not escape limits or cancellation (item 9,
with the macOS limit stated), and that the proxy profile not contradict socket denial (item 9).

Codex, 2026-11-09, read-only over the whole plan (0034 and 0035 together): asked who makes the first
vertices (item 15: the manifest's repositories), that a turn not wait forever on an agent that does
not run yet and that plugins writing several kinds have a publication rule (item 11), that
confinement not come after plugins run (item 9 and the stages), that orphans be defined without an
unstated notion of roots (item 12), and that stage (a) be split into landable increments
(Consequences); proposed Skyframe-style invalidation (Consequences). Its points on branch layers,
mixed provenance and sync identity are answered in 0034 items 2, 8 and 10.
