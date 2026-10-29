/**
 * The fill worker's editorial seam (madarch-ztyq.9): it resolves the editing role from the model
 * roles the server sends with the fill start. An assigned or fallback pair starts the ACP editing
 * judge; no pair leaves the deterministic checks running and gives the journal a reason. A host's
 * jev, when there is one, is handed through first. No real agent and no model: every judge here is
 * a scripted object.
 */
import { describe, expect, test } from 'bun:test';
import { editorialJudgeFor } from '../src/knowledge/fill-worker.js';
import { resolveModelRoles, type ModelPair, type ModelRoleView } from '../src/knowledge/model-roles.js';
import type { EditorialJudge } from '../src/writer/editorial.js';

const view = (writing: ModelPair | null, editing: ModelPair | null): ModelRoleView => resolveModelRoles({ writing, classification: null, analysis: null, editing });
const judge = (name: string): EditorialJudge => ({ judge: async () => ({ requests: [], unreviewedPages: [] }) });
const pair = (agent: string): ModelPair => ({ agent });

describe('the fill worker resolves the editing role (madarch-ztyq.9)', () => {
  test('an assigned editing pair starts a judge of its own, and the pair reaches the factory exactly once', () => {
    const seen: ModelPair[] = [];
    const built = judge('editing');
    const resolved = editorialJudgeFor({ roles: view(pair('writing-agent'), pair('editing-agent')) }, {
      judgeForPair: (asked) => { seen.push(asked); return built; },
    });
    expect(resolved.skipReason).toBeUndefined();
    expect(resolved.judge).toBe(built);
    expect(seen).toEqual([{ agent: 'editing-agent' }]);
  });

  test('an unassigned editing role uses the default writing pair and says so through the resolution', () => {
    const seen: ModelPair[] = [];
    const resolved = editorialJudgeFor({ roles: view(pair('writing-agent'), null) }, {
      judgeForPair: (asked) => { seen.push(asked); return judge('fallback'); },
    });
    expect(resolved.judge).toBeDefined();
    expect(seen).toEqual([{ agent: 'writing-agent' }]);
  });

  test('with no pair at all the deterministic checks stand and the skip names why; a host jev is still handed through', () => {
    const built = judge('jev');
    const none = editorialJudgeFor({ roles: view(null, null) }, { jev: built });
    expect(none.judge).toBeUndefined();
    expect(none.jev).toBe(built);
    expect(none.skipReason).toContain('the editing role resolves to no pair');
    const noRoles = editorialJudgeFor({}, undefined);
    expect(noRoles.skipReason).toContain('carried no resolved model roles');
  });

  test('a host jev and a resolved editing pair are both handed on: the jev reads first in the pass', () => {
    const jev = judge('jev');
    const role = judge('editing');
    const resolved = editorialJudgeFor({ roles: view(null, pair('editing-agent')) }, {
      jev,
      judgeForPair: () => role,
    });
    expect(resolved.jev).toBe(jev);
    expect(resolved.judge).toBe(role);
    expect(resolved.skipReason).toBeUndefined();
  });
});
