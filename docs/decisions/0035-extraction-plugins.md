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
   - On Linux, bubblewrap that madarch downloads pinned and checks by its hash before each use
     (as Codex checks its bundled bwrap, `codex-rs/linux-sandbox/src/bundled_bwrap.rs:151`), with
     the snapshot bound read-only, all namespaces unshared, the environment cleared, the process
     dying with its parent, and a seccomp filter refusing io_uring and ptrace and, by profile,
     sockets. Memory and CPU are limited by cgroup v2: the plugin's whole process tree runs in a
     cgroup of its own under one delegated to madarch with the `memory`, `cpu` and `pids`
     controllers enabled; the limits are set before the first instruction of the plugin runs,
     freezing is the cgroup's freezer, and cancel kills the cgroup, so no descendant escapes by
     changing its session or group. The host checks the delegation before a run; where it is
     missing, or unprivileged user namespaces are, no plugin runs and the host raises an
     operations problem naming what to enable. It never runs a plugin unconfined.
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
    their turns in parallel. A cycle among them is an error of the manifest that names the kinds,
    and no fill starts while it stands. At initialisation, and in the later choice by template or by
    inclusion and exclusion, a chosen kind brings in the kinds it depends on, and excluding a kind
    another chosen kind depends on is refused with the dependants named. (Owner: «Только тут важен
    порядок. Помнишь мы в каталоге сущностей прописывали зависимости?»)

12. **Orphans are found, never kept silently.** After each kind's turn and in the final check, the
    host looks for: a vertex missing a relation its contract requires (a symbol without its file, a
    file without its repository); an edge whose end is removed, or tombstoned in the context the
    edge is read in; a claim without evidence, and evidence that points at nothing; a vertex no root
    of its catalogue section reaches. Each is a problem naming the kind, the entity and the cause,
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
    blob, through the host and inside the sandbox's snapshot. (Owner: «И обрати внимание что все
    плагины работают по графу. Если информация есть в графе - берем оттуда.»)

## Consequences

- madarch's engine becomes the mechanism (graph, claims, layers, journal, queue) and the plugin
  host; today's git reader becomes the first plugin of madarch's upstream, put into every product
  at initialisation (until templates come, stage (e)), and keeps its contract.
- A product launches with the kinds it needs before madarch has a static extractor for them:
  the agent fills them from their description, at the cost of tokens and accuracy, and a static
  plugin later replaces the agent with the same contract and the same pages. (Owner: «Вообще да,
  такой подход мне нраавится. Мы сможем запустить продукт быстрее и он сможет дописывать сам себя
  в части работы над сущностями.»)
- Stages: (a) contracts and generated tables, the host with the protocol, its bounds, the binding to
  the orchestrator and each kind in turn in the order from declared dependencies (items 1 and 11)
  with the agent part of a turn recorded as waiting for the agent, the orphan check (item 12), the
  concurrency settings (item 13), the dependency graph page (item 14), closure hashes with the
  release-trusted rule, initialisation putting every madarch plugin and kind into the product, and
  the git reader as the first plugin (madarch-8bdc.2.11); (b) the sandbox, required before any
  closure not shipped by a madarch release may run; (c) several producers per claimed field, the
  accepted-value rule and accuracy measurement; (d) agent-written plugins and fixes and upstream
  updates, which run a real agent and start on the owner's yes; (e) templates and fine-grained
  inclusion and exclusion of kinds at initialisation.

## Review

Codex, 2026-11-09, read-only over the draft: asked that authoritative and claimed fields be
told apart now (item 2, with 0034 item 7), that iterations be bound to 0027's publication (item
6), that the protocol carry every result type and partial units (item 7), that handshake,
output and heartbeat bounds and stop escalation be stated (item 5), that approval pin the whole
executable closure and validation be told from production runs (item 4), that cgroup delegation
be required and fail closed (item 9), that descendants not escape limits or cancellation (item 9,
with the macOS limit stated), and that the proxy profile not contradict socket denial (item 9).
