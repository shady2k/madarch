# Plugin environment

Capability: plugin-environment

## Purpose

The environment a madarch plugin declares and the host grants: the tier a plugin is of, the one outside source a core
plugin owns, and the absence of any environment for an ordinary plugin, which reads the graph and asks the host for
outside data. This is decision 0038, beside the extraction plugins of decision 0035.

## Requirement: environment — A plugin declares its tier and capabilities, and the host grants exactly that

A plugin's own manifest shall declare its tier — `core`, the one gate to one outside source, or `ordinary`, which holds
no environment at all — and the capabilities it holds: for a core plugin exactly one of `repository` (git's object store
at the pinned revision, read-only), `filesystem` (the working tree git does not hold), `network` (an address on the
product's allow-list) and `agents` (an LLM agent over ACP); for an ordinary plugin, the outside data it asks the host
for. A manifest naming no tier shall be ordinary, granted nothing.

The host shall grant a core plugin its one source and nothing else, binding the repository read-only where the source is
`repository` or `filesystem` and its declared tools into the sandbox; an ordinary plugin's sandbox root shall be an empty
file system with no repository, no tool and no network. An access a plugin does not declare — a tool, a repository bind,
a network address, an agent, a blob read — shall be refused with a sentence naming the plugin and the access, and the
file, line and full path of the declaration.

An ordinary plugin's `file.read` shall be answered by the host through the core plugin that owns git, the same read a
page and an agent make (decision 0037), never a second path to the bytes.

### Scenario: core-source-bound

- Given: a plugin whose manifest declares `tier: core` and `capabilities: ["repository"]`
- When: the host opens it
- Then: the sandbox binds the repository at `/repo`, read-only, and the plugin answers the host's blob reads

### Scenario: ordinary-no-environment

- Given: a plugin whose manifest declares `tier: ordinary` and `capabilities: ["repository"]`
- When: the host opens it
- Then: its sandbox root is an empty file system, it is bound no repository and no tool, and a `file.read` it asks is
  answered through the git plugin

### Scenario: undeclared-access-refused

- Given: a plugin whose manifest declares `tier: ordinary` and no capabilities
- When: it names a tool, declares an agent part, or asks the host for a blob
- Then: the host refuses with a sentence naming the plugin and the access, the file, the line and the full path, and
  the plugin does not run

### Scenario: agent-no-environment

- Given: a plugin that declares `agents`, and an agent run for it
- When: the agent asks to read a path that is no graph file, to write, or for a terminal
- Then: the client refuses each request; the agent's one file read is a blob the graph names
