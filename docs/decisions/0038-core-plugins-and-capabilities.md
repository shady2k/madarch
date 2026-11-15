# Decision 0038: core plugins, capabilities, and one gate per outside source

Status: accepted
Date: 2026-11-15
Deciders: the owner (2026-11-15, madarch-64o5.110)
Extends: 0035 (extraction plugins), 0037 (a file's text from git by blob id)

## Context
A plugin runs as a process the host starts, and today the host grants it what its `contract.json` asks for: a repository
bound read-only, executable tools, the graph. Nothing says which outside source a plugin is *for*, and a graph-only
plugin — a plugin that reads the graph and asks the host for the rest — was given the same environment as the producer
that reads the source tree. The owner's rule of madarch-64o5.109 (the agent reads only the graph) and his decision here
(«в атрибуты плагинов можно писать, нужна ли ему вообще песочница или нет … тогда ему вообще никакого доступа, никакой
среды вообще быть не должно») name the shape: two tiers, and an environment granted from a declaration.

## Decision

1. **Two tiers.** A plugin's `plugin.json` declares `tier: core | ordinary` and the `capabilities` it holds. A manifest
   naming no tier is ordinary and is granted nothing.
2. **A core plugin is the one gate to one outside source**, shipped with madarch and trusted, and it names that source:
   - `repository` — git's object store at the pinned revision (history, commits, a file's text by blob id, decision
     0037);
   - `filesystem` — the working tree git does not hold (untracked files), where the product allows it;
   - `network` — an address on the product's allow-list;
   - `agents` — an LLM agent run over ACP.
   A core plugin names exactly one of them. It sees its source bound and nothing else of the host: the repository at
   `/repo`, read-only, and the tools its manifest declares.
3. **An ordinary plugin holds no environment at all**: no file system (its sandbox root is an empty file system, with only
   the runtime, its closure and its work folder bound), no network, no process of its own. Its `capabilities` are the
   outside data it *asks the host for*; the host routes each request to the core plugin that owns the source. Today that
   is `repository`: a plugin asks `file.read` by (repository, blob id) and the host answers it through the git plugin —
   the same read a page and an agent make (0037), not a second one.
4. **The host grants exactly what is declared and refuses the rest**, with a sentence naming the plugin and the access:
   a tool in a plugin with no source, an agent part in a plugin without the `agents` capability, a `file.read` from a
   plugin that names no `repository`, a contract right that contradicts the tier. A refusal names the file, the line and
   the full path.
5. **The sandbox applies where an environment is granted.** A core plugin runs with the host's root read-only, its one
   source bound into it, and its tools; an ordinary plugin's root is a fresh empty file system, so the file system is
   absent for it rather than merely unused. (Both are confined by the same mechanism; what differs is what it grants.)
   Where `MADARCH_PLUGIN_SANDBOX=off` runs a plugin unconfined, the warning says so, and the protocol refusals above
   still hold.
6. **An agent session holds no environment of its own.** The host runs the agent for a plugin that declares `agents`; the
   session gets no workspace (an empty folder), no write tool and no terminal, and its one file read is a blob the graph
   names, answered through the gate. The agent fills the graph through madarch's MCP server (madarch-64o5.109).

## Consequences
- One gate per source: auditable (one plugin may read the disk), cacheable (a blob read is content-addressed) and bounded
  (the gate's own limits).
- The rule «the agent reads only the graph» holds by construction: an ordinary plugin cannot reach the disk, so neither can
  its agent, except by asking the host for a blob the graph already names.
- A third-party plugin cannot reach the disk, the network or a process by declaring an ordinary tier; declaring `core`
  means declaring the one source it is, and the host still binds only that.
- A fill of the product's own repository is read through the same gate: its root is the product's folder, a connected
  repository's root is under the product's `repos/`.
- The starter plugins carry their declarations: `git` (core, `repository`), `disk` (core, `filesystem`), `agent-fill`
  (ordinary, `agents`), and `imports`, `glossary`, `db-schema`, `test-quarantine` (ordinary, `repository`: they ask for
  file text and the host routes it to git).

## Not done here
- The `network` gate has no plugin yet; the capability and its refusal exist, and an address allow-list is the product's
  to declare when one is written.
- State machines, translation and consistency plugins named in the decision of madarch-64o5.108/.110 are not bundled
  yet; each declares its tier when it is.
