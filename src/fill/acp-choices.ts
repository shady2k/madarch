/**
 * What an ACP agent says a session can be set to (madarch-m38l.11): the model and the reasoning level. Nothing here is
 * a list of models: madarch offers exactly what the agent reports in `session/new` (`configOptions`, or the earlier
 * `models` form), and sets a choice back through `session/set_config_option` (or `session/set_model`).
 */
import type { AcpSession } from './acp.js';

/** One value an agent offers for an option. */
interface ChoiceValue {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

/** One option the reader can choose from: where it is set, what it is now, what it can be. */
interface Choice {
  /** The agent's id for the option (`session/set_config_option`'s `configId`); null for the earlier model form. */
  readonly configId: string | null;
  readonly name: string;
  readonly current: string | null;
  readonly values: readonly ChoiceValue[];
}

/** The two options madarch offers. A null one is an agent that reports no such choice. */
export interface AgentChoices {
  readonly model: Choice | null;
  readonly reasoning: Choice | null;
}

/** The reader's saved choice: values the agent offered. */
export interface AgentPreferences {
  readonly model?: string;
  readonly reasoning?: string;
}

const REASONING_IDS = ['thought_level', 'reasoning_effort', 'effort', 'reasoning'];

/** The model and the reasoning level of a session, as the agent reported them. */
export function choicesOf(session: Pick<AcpSession, 'configOptions' | 'models'> & Partial<Pick<AcpSession, 'model'>>): AgentChoices {
  const options = session.configOptions;
  const modelOption = options.find((option) => option.category === 'model') ?? options.find((option) => option.id === 'model');
  const reasoningOption = options.find((option) => option.category === 'thought_level') ?? options.find((option) => REASONING_IDS.includes(option.id));
  let model: Choice | null = modelOption === undefined || modelOption.values.length === 0 ? null : { configId: modelOption.id, name: modelOption.name, current: modelOption.current, values: modelOption.values };
  if (model === null && session.models !== null && session.models.available.length > 0) {
    model = { configId: null, name: 'Model', current: session.models.current, values: session.models.available.map((entry) => ({ value: entry.id, name: entry.name, ...(entry.description === undefined ? {} : { description: entry.description }) })) };
  } else if (model !== null && model.current === null && session.model !== undefined) {
    model = { ...model, current: session.model };
  }
  const reasoning: Choice | null = reasoningOption === undefined || reasoningOption.values.length === 0 ? null : { configId: reasoningOption.id, name: reasoningOption.name, current: reasoningOption.current, values: reasoningOption.values };
  return { model, reasoning };
}
