/**
 * The environment a plugin declares and the host grants (owner's decision, 2026-11-15; decision 0038): a plugin is of one
 * of two tiers, and its `plugin.json` names both the tier and the capabilities it holds.
 *
 * - A **core** plugin is the one gate to one outside source — git's object store, the file system, the network, an LLM
 *   agent over ACP. It is shipped with madarch and trusted, it declares the source it owns, and the host mounts exactly
 *   that source for it (a repository revision read-only, the working tree where the product allows it) and nothing else.
 * - An **ordinary** plugin has no environment at all: no file system, no network and no process of its own. It reads the
 *   graph over the protocol and asks the host for outside data, which the host routes to the core plugin that owns the
 *   source — «text of blob X» goes to git.
 *
 * A capability is the name of one outside source, never a detail of a protocol: `git` is git's object store read
 * at the pinned revision, `filesystem` is the working tree git does not hold (untracked files), `network` is an address
 * on the product's allow-list, and `agents` is an LLM agent run over ACP. The host grants what is declared and refuses
 * the rest with a sentence naming the plugin and the access.
 */

/** The outside sources a plugin may name: one gate per source (decision 0038). */
export const CAPABILITY_NAMES = ['git', 'filesystem', 'network', 'agents'] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** A plugin's tier: the gate to one source, or one that holds no environment at all. */
export const PLUGIN_TIERS = ['core', 'ordinary'] as const;
export type PluginTier = (typeof PLUGIN_TIERS)[number];

/** What a plugin declares of its environment: its tier and the capabilities it holds. */
export interface PluginCapabilities {
  readonly tier: PluginTier;
  readonly capabilities: readonly CapabilityName[];
}

/** What the host grants from a declaration: one environment per plugin, and nothing beside it. */
export interface PluginEnvironment {
  /** The tier the declaration names. */
  readonly tier: PluginTier;
  /** The repository revision the host binds read-only at `/repo` (a core plugin that owns git's store or the tree). */
  readonly repository: boolean;
  /** The working tree git does not hold: a core plugin that owns the file system. */
  readonly filesystem: boolean;
  /** The network, on the product's allow-list: a core plugin that owns it. */
  readonly network: boolean;
  /** An agent over ACP, run by the host: the capability a plugin asks for, never one it owns as a source of its own. */
  readonly agents: boolean;
}

/**
 * The one rule of the declaration, as a sentence a person reads: a core plugin owns exactly one source, and an ordinary
 * plugin owns none. A capability an ordinary plugin names is the host data it asks for, and the host answers it.
 */
export function capabilityProblem(declaration: PluginCapabilities, plugin: string): string | undefined {
  if (!PLUGIN_TIERS.includes(declaration.tier)) return `the plugin "${plugin}" declares the tier ${JSON.stringify(declaration.tier)}: a plugin is "core" (the gate to one outside source) or "ordinary" (no environment at all)`;
  const unknown = declaration.capabilities.filter((name) => !(CAPABILITY_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) return `the plugin "${plugin}" declares the capability ${JSON.stringify(unknown[0])}: the capabilities are ${CAPABILITY_NAMES.map((name) => `"${name}"`).join(', ')}`;
  const repeated = declaration.capabilities.filter((name, at) => declaration.capabilities.indexOf(name) !== at);
  if (repeated.length > 0) return `the plugin "${plugin}" declares the capability ${JSON.stringify(repeated[0])} twice: a plugin holds each capability once`;
  if (declaration.tier === 'core' && declaration.capabilities.length !== 1) {
    return `the core plugin "${plugin}" declares ${declaration.capabilities.length === 0 ? 'no capability' : `${String(declaration.capabilities.length)} capabilities`}: a core plugin is the one gate to one outside source, and it names that source`;
  }
  return undefined;
}

/**
 * The environment the host grants one plugin from its declaration (decision 0038): the source a core plugin owns, and
 * nothing for an ordinary plugin — its capabilities are what it asks the host for, not what it may reach itself.
 */
export function environmentOf(declaration: PluginCapabilities): PluginEnvironment {
  const core = declaration.tier === 'core';
  return {
    tier: declaration.tier,
    repository: core && (declaration.capabilities.includes('git') || declaration.capabilities.includes('filesystem')),
    filesystem: core && declaration.capabilities.includes('filesystem'),
    network: core && declaration.capabilities.includes('network'),
    agents: declaration.capabilities.includes('agents'),
  };
}

/** The whole declaration of one plugin, as its `plugin.json` states it and the host reads it: a manifest naming no tier is ordinary. */
export function declarationOf(manifest: { readonly tier?: string; readonly capabilities?: readonly string[] }): PluginCapabilities {
  const tier = manifest.tier === undefined ? 'ordinary' : manifest.tier;
  return { tier: tier === 'core' ? 'core' : 'ordinary', capabilities: (manifest.capabilities ?? []) as readonly CapabilityName[] };
}
