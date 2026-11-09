/** Read-only headless adapters for code-derived fill units. */

export type AgentKind = 'claude' | 'codex' | 'omp';
/**
 * The environment variable each agent's own client reads an API key from, for
 * a person who pays with a key instead of their subscription. madarch keeps
 * the name and never the key: it is not asked for, not read and not stored,
 * and the agent's client reads whatever the person put in madarch's
 * environment (the owner's decision of 2026-10-19 on madarch-tzte.6). omp has
 * no such variable madarch knows: it takes a model and a gateway extension
 * from this machine instead.
 */
export const AGENT_API_KEY_ENV: Readonly<Record<AgentKind, string | undefined>> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', omp: undefined };

const safeText = (text: string): string => text.replace(/(?:sk-ant-[A-Za-z0-9_-]{8,}|(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET(?:[_-]ACCESS[_-]KEY)?|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY))[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+|(?:api[_-]?key|token|secret)[=: ]+[^\s,;]+|Bearer\s+[^\s]+)/gi, '[REDACTED]').slice(0, 500);
const redact = (value: unknown): unknown => {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password|credential|private[_-]?key|client[_-]?secret|_token$)/i.test(key) ? key : key, /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password|credential|private[_-]?key|client[_-]?secret|_token$)/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
};
