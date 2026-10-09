# idea-to-wiki — from an idea to a living wiki

Adopted 2026-10-09 (owner, after the conversation recorded as decisions 0017
and 0018).
Precedes: `knowledge-base`, ended early by decision 0017.

One person and their own agent, on their own machine, with no server, no
sign-in and no name yet, turn an idea into a product kept as a living wiki: a
draft product repository opens as a wiki, the agent (Claude Code or another,
run in the product's root with the shady2k skills) talks the idea through and
writes what comes out, each page checked and linked to what it grew from, and
the wiki shows every change as the file is saved. The wiki is madarch's own
thin app over its local server (0018); its diagram tabs (LikeC4, Mermaid,
archify) stay.

## Outcomes and acceptance

1. **Start a product from an idea.** `madarch new`, with no name, creates (through
the skill set's product-repository program it bundles, decision 0019) a
draft product repository under madarch's home folder
(`~/madarch/products/`): `AGENTS.md` (the constitution), `CLAUDE.md`
(`@AGENTS.md`), `workspace.yaml` (the manifest), `docs/`, `model/`,
`skills/`, `prototypes/` and an ignored `repos/`; a local madarch serves the
product's wiki and opens it.
   *Check:* after `madarch new` the draft's wiki opens in the browser; a file
the agent saves under `docs/` changes its page without a restart.
2. **Write the product's intent by the contract, checked and linked.**
Vision, hypotheses, sources (the record of a brainstorm), user stories, use
cases and functional requirements, each linked to what it grew from, with
backlinks. The forms, templates and the form check are the skill set's
(decision 0019): its check, installed in the product repository, refuses a
document out of form at commit naming the file, the line and what is wrong,
and madarch reads the documents, links them and shows that check's error on
the page.
   *Check:* in an example product, a requirement's page shows its use case,
user story, hypothesis and the quote it came from, and each of those pages
links back; a broken document is refused at commit with its file and line.
3. **See what is still missing.** The wiki lists the open questions of the
product; an answer closes one, "not applicable" is an answer, an empty one is
not.
   *Check:* a new draft shows the questions "name" and "audience"; answering
them closes both.
4. **Prototype a hypothesis.** A prototype's code lives in
a folder of its own under
`prototypes/`, linked to the hypothesis it tests and to its result.
   *Check:* a hypothesis's page shows its prototype and its result.
5. **Turn a draft into a product** (the skill set's program, decision 0019;
madarch keeps `madarch list` and serves the renamed product). The agent helps choose a name; the draft's
folder is renamed in place and its internal id is kept; the agent offers to
add a git remote and push; the prototype stays or becomes the first code
repository in `repos/`, entered in the manifest; `madarch list` shows every
product.
   *Check:* after the rename no link breaks, `madarch list` shows the product
under its new name, and a push to a remote succeeds.

**The milestone's walk:** the owner, with Claude Code and the shady2k skills,
goes from an empty folder to a named product holding a vision, a hypothesis
with its prototype and one chain from a user story through a use case to a
requirement, all of it seen in the wiki.

## Exclusions

- Agents through MCP or an API; editing by hand in the wiki; the chat beside a
page (decision 0017 keeps it for later).
- Code repositories beyond the first, and work launched from the wiki: tasks,
runs, feedback from the code index (madarch-mv2).
- The team: bootstrap of a cloned product, several people on one product.
- The central server, federation, sign-in, single sign-on and roles
(madarch-toc).
- Computed pages beyond backlinks and open questions: sequence diagrams,
scenario status, the data catalogue (madarch-1ui).
- Work in the shady2k-skills repository: the skills that write into this
structure, name a product and talk to a product owner in plain words are
tracked there (skills-k8c and its siblings); the walk reads their result once
at acceptance.

## Scope decisions

- knowledge-base ended 2026-10-09 with outcome 2 accepted (madarch-hnq).
Closed as moot by decision 0017: madarch-o3b (the per-repository contract
file). Deferred: madarch-1ui (computed wiki pages, to return on the new wiki)
and madarch-mv2 (the code index, for the milestone of work launched from the
wiki).
- Carried over: madarch-l2f (checks independent of the unrelated repository)
and madarch-1xq (temporary folders left by test suites): both still true.
- Finding budget 5, the config key `findingBudget`: knowledge-base took in no
new finding.
- Rough size, an estimate: six to nine feature runs, about one and a half to
two weeks of calendar, from the pace so far. The wiki app and the live
update are new kinds of work for madarch and carry the most uncertainty.

## Next horizon

The `agent-access` milestone, as feature titles:

- Serve the product to agents over MCP and an API, by the same checked write
path (madarch-yhy).
- Edit a page by hand in the wiki, by the same path.
