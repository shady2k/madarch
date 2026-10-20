# self-filling — the wiki fills itself (local mode)

Adopted 2026-10-16 ~23:45 MSK (the owner's "Да" in conversation with the
assistant, to the slice due on Monday morning with the training repository as
its first task). Follows standalone, which closes when 0.1.2 (madarch-74k4.2.6)
and the PostgreSQL move (madarch-24sy) land.

A person runs `madarch init` in their code checkout and, within about an hour,
has a product wiki filled by their own agent: they can read it, edit it, accept
or reject what the agent proposed, and it always says what to do next. The
design was agreed in conversation on 2026-10-16; the owner's words are quoted
where they decided something.

## Outcomes and acceptance

1. **A background server.** `madarch start`, `stop` and `status`: one server
for every product in the products home on a fixed port, its home page listing
the products; `new` and `init` return at once and print where the wiki is,
including over SSH; `madarch service install` (systemd user unit, launchd, a
Windows scheduled task); `serve` stays as it is. Owner: «Да, так будет гораздо
лучше».
   *Check:* on a clean machine over SSH, `madarch init` returns within seconds
and prints the wiki address and the tunnel command; the wiki still answers
after the terminal closes, and after a reboot with the service installed.

2. **Editing in the wiki, the way Zettlr does it** (owner: «Я хотел бы как в
zettlr»). A hybrid Markdown editor on CodeMirror 6: the source stays Markdown
and decorations render it; Mermaid shows as a picture outside the cursor;
front matter as form fields; comment markers are protected and atomic; a write
is refused when the file changed since it was opened; the form check runs
before the commit; one write path into the product's git. Replies, resolution
and lost anchors of comments (madarch-y781.3) join this outcome. Zettlr is
GPL-3.0: its approach is followed, its code is not taken. Adopts madarch-j0a.
   *Check:* the owner edits a page in the browser and the product's git holds
exactly that change; a concurrent edit is refused with the difference shown;
comment markers survive the edit; form errors show before the commit.

3. **The agent fills the wiki by itself.** madarch is the orchestrator, not
one agent session (owner: «не нужно делать все в одной агентской сессии»).
- A first-fill wizard runs once on first open, later the settings with a "run
the wizard" button (owner: «давай мастер, только если его еще не запускали,
потом просто настройки»): what will happen, the installed agents found and
tested, an inventory without an agent, an estimate per stage, limits, Start.
- The pipeline: inventory → structural index (tree-sitter: symbols, imports,
entry points, call graph; code comments; task keys) → claims from documents,
comments, commits and pull requests → a bottom-up code map → reconciliation of
claims against the code → top-down synthesis (overview, high level, details;
several passes per stage with a critic: «Даже на один этап одного прохода
будет недостаточно») → review of open questions.
- Small units of work with input hashes; interrupted at any point, it resumes
without losing work («Нужно уметь продолжать процесс при прерывании на любом
этапе и не терять ту работу»); an entity appears as soon as it is found
(«Зачем нам ждать полного прогона агента?»), live in the wiki; the agent works
on its own branch of the product repository, one commit per stage, merged
after each («Давай коммитить каждый этап. А изменения человек должен видеть
онлайн»); progress, pause and stop in the right-hand panel («Ход работы не
сверху, а в правой панели. Там же стоп и пауза»).
- Work runs on a pinned snapshot of its sources; changes are looked for at
stage boundaries and only affected units recompute; a person's edit wins over
the agent's; a vanished source closes its claims.
- After the first fill, an update runs by itself after commits to the default
branch, debounced, within the wizard's limit.
Adopts madarch-hkhl (a wiki from code at once) and madarch-mv2 (the code
index).
   *Check:* on the training repository and on a madarch checkout: wizard →
Start → the process is killed in mid-stage → a second run finishes without
redoing finished units (the unit counts are in its report); a commit to the
default branch recomputes only the affected units.

4. **Extraction by the contract, with sources.** Every kind in the product's
`kinds.yaml` and its links (owner: «Извлекать мы должны все сущности, которые
нам известны по контракту, верно?»); how to find each kind is data in the
registry, not engine code; business rules, state and interaction diagrams from
the code (adopts madarch-850). Three levels: fact (code and its git history),
evidence of intent (documents, code comments, commits, pull requests, linked
pages), meaning (only assumed: «не сможем выделить смысл, только предположить
или догадаться»). Assumptions show on the page with an "unverified" badge
(«Да, показывать предположения, показывать плашку, что это непроверено»).
Every claim keeps its source: address, version, anchor, time read and hash
(«Обязательно нужно хранить ссылку на источник»). Links are read when they
open without signing in («ссылки читаем, если открываются»).
   *Check:* against the training repository's answer key, the report counts
what was found, missed and invented; on every page of the madarch fill each
claim's source opens; every kind of the registry has entities or an open
question saying why it has none.

5. **Open questions and the next step.** The run never asks the person; every
question becomes an open question by type («у нас неинтерактивная сессия, все
вопросы должны идти в открытые вопросы, разбитые по типам»): meaning,
contradiction, undocumented behaviour, assumption check, term, unverifiable,
decision rationale, access or document needed («агент в открытых вопросах
должен сказать, что ему нужен доступ или сам документ»). Each names what
depends on it, which ranks it; the agent closes it when it finds the answer
with evidence («Открытые вопросы должны закрываться, если агент в процессе
нашел ответ»). The person answers questions and accepts or rejects pages in
the wiki, as Markdown in the product's git. Every product page shows a
recommended next step («Всегда должна быть рекомендация что делать. Это
зачатки трекера»).
   *Check:* an answer given in the wiki recomputes the pages that depend on
it; the agent closes at least one question itself, with its evidence; every
product page shows a next step.

**Success signal:** the owner reads the wiki madarch made of madarch and learns
from it what madarch is, for whom and how it is built, and would put it behind
`madarch demo`.

## Exclusions

- The server and the team (owner: «А сервер вообще нужно обсуждать
отдельно»), connectors with tokens (Confluence, Jira), sign-in.
- Filling a new product that has no code: the wiki offers running an agent in
the product folder and the shady2k skill set («По новому продукту пока нужно
предлагать запустить агента и начать работать, предложить мои скиллы»).
- Editing tables in their cells; role start pages (madarch-uzfo), the semantic
check (madarch-p8es), maturity goals and gamification.
- Searching discussions through the graph (madarch-y781.4), deferred.
- madarch-wsce (madarch's own wiki written by hand) is closed as replaced by
running madarch on madarch (owner: «Я предлагаю не делать вики madarch, а
запустить madarch для madarch»); that run is this milestone's walk.

## Scope decisions

### Target date

**Tuesday 2026-10-20, morning MSK**, set by the owner on 2026-10-18 («По поводу даты я готов тебе
дать время до утра вторника. Ты и текущий объем переоценил.»). It replaces the first date, Monday
2026-10-19 morning («до утра 19 октября (понедельник)»), after the landed fill was judged wrong at the
root («То что работает нельзя показывать, это в корне неверно. Нужно сделать как положено.») and
rebuilt graph-first by decisions 0026 and 0027; the Monday slice below is history.

### The Monday slice

Due Monday morning, accepted by the owner's "Да" above:
- the training repository first (below), with the background server beside it;
- the pipeline: inventory, index, code map, claims from the repository's own
documents, synthesis of the overview and the main kinds; resume after an
interruption; the agent's branch; the right-hand panel with pause and stop;
- assumptions with the badge and a source on every claim;
- open questions by type with their rank, and answering one in the wiki;
- the wizard in a simple form: choose and test the agent, inventory, estimate,
Start;
- the next-step recommendation by simple rules.
Until the PostgreSQL move lands, the pipeline keeps its state in files under
`.madarch/`. After Monday: the editor and comment replies, accept and reject,
the update after commits, `service install`, reading outside links, the
agent closing questions itself.

### The training repository

No separate spike (owner: «Спайк ты будешь всю ночь делать и жечь токены?
Нет, мы так не договаривались»). Instead, the owner's proposal: «Можешь создать
маленький тестовый репозиторий. Мы же генерили диаграммы со всеми элементами,
ну вот можно на этом же и тренироваться, заодно это можно использовать для
тестов в будущем». A generator in this repository builds a small code
repository for the ordering and payments slice of
`examples/reference-system` (four or five services, a broker), with planted
business rules, an order state machine, an HTTP call and an event, a stale
README claim, undocumented behaviour, a "why" comment, a term mismatch, one
link that opens and one that needs sign-in, and a scripted git history with
fixed dates and task keys. Its answer key sits beside the generator, never in
the generated repository. The first pipeline task ends with a checkpoint for
the owner: found, missed and invented against the key, and time and tokens
per unit. Later it is the quality regression run, on demand and not in CI.

### Carried over

standalone's work in flight carries over until it lands: 0.1.2 (madarch-74k4),
the PostgreSQL move (madarch-24sy), comments (madarch-y781, its stage 3 into
outcome 2), the registry (madarch-d7v3, madarch-d3yt), the binary
(madarch-lfhu) and the open tooling and findings under them. What has landed
and waits only for its tracker close-out is closed there, not redone.

### Finding budget

**8** (`findingBudget` in `.shady2k/config.json`), the same as standalone,
which used it in full; the scope here is not smaller. Findings carried over
count against it.

Raised to **10** on 2026-10-20 by the owner («Бери», answering whether to take
madarch-tzte.38 — a prompt turn that never streams is bounded by no clock — and
madarch-cznn — the slow tests that still time out on their own 5 s bounds —
into this milestone). Nothing planned is displaced; the mutation survivors of
stages 19–22 were moved to the next milestone on 2026-10-19 («Мутантов перенеси
в новую веху»).

### Open alongside, not in scope

- The starter kinds registry for a product made by `new` or `init` without
the skill set comes as data, not engine code (decision 0021).
- madarch has no licence file; it is settled before third-party editor
components are added.
- After the milestone, `madarch demo`'s product repository takes the fill
result the owner accepts (the assistant's proposal, not yet decided).

### The walk

`madarch init` in a madarch checkout → the wizard → the fill → the owner reads
the wiki and works its open questions; the training repository's report beside
it.

## Next horizon

The server for a team on PostgreSQL; connectors with tokens; sign-in and
single sign-on (madarch-toc); the Docker image and Helm chart (madarch-uaq8);
open questions assigned to people.
