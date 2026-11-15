/**
 * An agent offer's state in a person's words (the prepare page and the settings page): whether its adapter is installed
 * where, and whether it is signed in on this machine. One sentence names what is missing, so an agent that cannot run is
 * still shown, with the reason beside it.
 */
import type { TFunction } from 'i18next';
import type { AgentOffer } from './command.js';

/** What the agent offers on this machine, in a person's words. */
export function agentNote(t: TFunction, agent: AgentOffer): string {
  if (!agent.installed) {
    if (agent.install?.kind === 'npm') return t('knowledge.writer.notInstalled', { package: agent.install.package, version: agent.install.version, size: agent.install.size, folder: agent.install.folder });
    if (agent.install?.kind === 'bundled') return t('knowledge.writer.notInstalledBundled', { program: agent.install.program });
    return t('knowledge.writer.installUnknown', { agent: agent.label });
  }
  if (agent.version === null) return t('knowledge.writer.installedUnknownVersion', { where: agent.where ?? '—' });
  return t('knowledge.writer.installedAt', { where: agent.where ?? '—', version: agent.version });
}

/** Whether choosing this agent can start a run: its adapter is installed and its sign-in is known to be there. */
export function agentUsable(agent: AgentOffer): boolean {
  return agent.installed && agent.login !== 'not-signed-in';
}

