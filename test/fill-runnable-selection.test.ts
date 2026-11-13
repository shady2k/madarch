import { expect, test } from 'bun:test';
import { assertPluginTurnsEnabled } from '../src/product/manifest/fill-config.js';

test('selected producers refuse a workflow that omits plugin turns before accepting work', () => {
  expect(() => assertPluginTurnsEnabled(['probe'], { ok: true, file: '/product/madarch/workflows.yaml', line: 4, stages: ['repository-tree'] }, { ok: true, file: '/product/workspace.yaml', stages: {}, lines: {} })).toThrow('/product/madarch/workflows.yaml:4: selected producer probe cannot run');
});
test('selected producers refuse an explicitly disabled plugin stage at its declaration', () => {
  expect(() => assertPluginTurnsEnabled(['probe'], { ok: true, file: '/product/madarch/workflows.yaml', line: 4, stages: ['repository-tree', 'plugin-turns'] }, { ok: true, file: '/product/workspace.yaml', stages: { 'plugin-turns': { enabled: false } }, lines: { 'plugin-turns': 8 } })).toThrow('/product/workspace.yaml:8: selected producer probe cannot run');
});
test('enabled plugin turns run; a selection needing no plugin does not require the stage', () => {
  expect(() => assertPluginTurnsEnabled(['probe'], { ok: true, file: '/product/madarch/workflows.yaml', line: 4, stages: ['plugin-turns'] }, { ok: true, file: '/product/workspace.yaml', stages: {}, lines: {} })).not.toThrow();
  expect(() => assertPluginTurnsEnabled([], { ok: true, file: '/product/madarch/workflows.yaml', line: 4, stages: [] }, { ok: true, file: '/product/workspace.yaml', stages: {}, lines: {} })).not.toThrow();
});
