/**
 * The model roles a product's features ask for (madarch-j6ho.2): a closed set,
 * each assigned to one (agent, model) pair in the reader's settings.
 *
 * `writing` is the writer's existing agent/model choice (madarch-m38l.11),
 * carried over unchanged. `classification` and `analysis` are the two tiers of
 * the answer-key judge; `editing` is the editorial pass of madarch-ztyq.9. A
 * role that is not assigned uses the default pair (`writing`) and says so: a
 * fallback is never silent.
 *
 * No model name stands here. The pairs name an agent and, when the reader
 * chose one, the model and reasoning level that agent reported over ACP.
 */

export const MODEL_ROLES = ['writing', 'classification', 'analysis', 'editing'] as const;

export type ModelRole = typeof MODEL_ROLES[number];

export interface ModelPair {
  readonly agent: string;
  readonly model?: string;
  readonly reasoning?: string;
}

export interface ModelAssignments {
  readonly writing: ModelPair | null;
  readonly classification: ModelPair | null;
  readonly analysis: ModelPair | null;
  readonly editing: ModelPair | null;
}

export type ModelRoleSource = 'assigned' | 'fallback' | 'none';

export interface ResolvedModelRole {
  readonly role: ModelRole;
  readonly pair: ModelPair | null;
  readonly source: ModelRoleSource;
  /** The role whose pair is used when `source` is `fallback`; the default pair is `writing`. */
  readonly fallbackFrom?: 'writing';
  /** One line for the report and the settings page; absent when the role has its own pair or has none. */
  readonly note?: string;
}

export interface ModelRoleView {
  readonly defaultRole: 'writing';
  readonly defaultPair: ModelPair | null;
  readonly roles: readonly ResolvedModelRole[];
}

export function emptyModelAssignments(): ModelAssignments {
  return { writing: null, classification: null, analysis: null, editing: null };
}

export function isModelRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

/** The pair with only the fields that are set, in a stable order. */
export function modelPair(pair: { agent: string; model?: string | undefined; reasoning?: string | undefined }): ModelPair {
  return {
    agent: pair.agent,
    ...(pair.model === undefined ? {} : { model: pair.model }),
    ...(pair.reasoning === undefined ? {} : { reasoning: pair.reasoning }),
  };
}

/**
 * Resolves every role. An unassigned non-default role uses the default pair
 * (`writing`) with a note; when `writing` too is unassigned there is no default
 * pair and the role resolves to none.
 */
export function resolveModelRoles(assignments: ModelAssignments): ModelRoleView {
  const defaultPair = assignments.writing;
  const roles = MODEL_ROLES.map((role): ResolvedModelRole => {
    const assigned = assignments[role];
    if (assigned !== null) return { role, pair: assigned, source: 'assigned' };
    if (role !== 'writing' && defaultPair !== null) {
      return {
        role,
        pair: defaultPair,
        source: 'fallback',
        fallbackFrom: 'writing',
        note: `${role} is not assigned, so it uses the default pair (writing)`,
      };
    }
    return { role, pair: null, source: 'none' };
  });
  return { defaultRole: 'writing', defaultPair, roles };
}

/** The resolved role with `role`, from a view; every role is in the view. */
export function roleOf(view: ModelRoleView, role: ModelRole): ResolvedModelRole {
  const found = view.roles.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`src/knowledge/model-roles.ts:1: the role ${JSON.stringify(role)} is missing from the resolved roles; full path ${import.meta.dir}/model-roles.ts`);
  return found;
}

/** The assignments a view was made from, for a writer that re-reads the file. */
export function assignmentsOf(view: ModelRoleView): ModelAssignments {
  const pair = (role: ModelRole): ModelPair | null => {
    const found = roleOf(view, role);
    return found.source === 'assigned' ? found.pair : null;
  };
  return { writing: pair('writing'), classification: pair('classification'), analysis: pair('analysis'), editing: pair('editing') };
}
