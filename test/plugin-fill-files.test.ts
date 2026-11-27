import { expect, test } from 'bun:test';
import { readKinds } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { readKindAssertions } from '../src/graph/records.js';
import { byCodePoint } from '../src/model/order.js';
import { digestOf, fixture, open } from './plugin-fill-scenario-fixture.js';

test('2,603 fully covered Files fill without scheduling the available general agent or Summary', async () => {
  const f = fixture('files');
  const read = readKinds(f.product); if (!read.present) throw new Error('fixture manifest absent');
  expect(read.manifest.findings).toEqual([]);
  for (const agentSelected of [false, true]) {
    const plan = planManifestFill(read.manifest, f.product, ['Files'], agentSelected);
    expect(plan.order).toEqual(['scenarios']);
    expect([...plan.outputs.get('scenarios')!.keys()]).toEqual(['Files']);
    expect(plan.outputs.has('agent-fill')).toBe(false);
  }
  const { owner, run, rows, contract } = await open(f);
  try {
    // No adapter or token cap is supplied; merely available agent capability cannot require either.
    const result = await run('Files', 'files-covered');
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.state).toBe('succeeded');
    expect(result.units.filter(unit => unit.stageId === 'plugin-turns').map(unit => unit.unitId)).toEqual(['plugin-turns/scenarios:Files']);
    const actual = await rows('Files');
    expect(actual).toHaveLength(2603);
    expect(actual.map(row => [row.path, row.content, row.description]).sort((a, b) => byCodePoint(String(a[0]), String(b[0])))).toEqual(f.files.map(file => [file.path, file.content, file.description]).sort((a, b) => byCodePoint(a[0]!, b[0]!)));
    const sources = await owner.transaction('snapshot', tx => readKindAssertions(tx, 'vertex', 'plugin', ['installation'], { contract }));
    const producer = sources.filter(source => source.values['installation'] === JSON.stringify(['system-engine', 'scenarios']));
    expect(producer).toHaveLength(1);
    const snapshots = await owner.transaction('snapshot', tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content'], { contract }));
    const sourceByPath = new Map(f.files.map(file => [file.path, snapshots.find(snapshot => snapshot.key['digest'] === digestOf(file.content))]));
    expect(actual.every(row => {
      const snapshot = sourceByPath.get(String(row.path));
      return snapshot !== undefined && snapshot.values['content'] === row.content && row.assertions.filter(assertion => assertion.property !== '$exists').every(assertion =>
        assertion.source === producer[0]!.uid && assertion.evidence.includes(snapshot.uid)
        && assertion.evidenceAttachments.some(attachment => attachment.targetUid === snapshot.uid
          && JSON.parse(attachment.locator).locator.path === row.path
          && JSON.parse(attachment.locator).locator.lineStart === 1 && JSON.parse(attachment.locator).locator.lineEnd === 1));
    })).toBe(true);
    expect(await rows('Summary')).toEqual([]);
    expect(await readProducerOutcomes(owner, { runId: 'files-covered' })).toEqual([expect.objectContaining({ kind: 'Files', outcome: 'completed', produced: 2603 })]);
  } finally { await owner.close(); }
}, 300_000);
