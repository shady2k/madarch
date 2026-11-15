
/**
 * A command template bound to no entity (decision 0036, section 7): `/p/run?run=<id>` binds the template's `run`
 * variable, and the component reads it while the page's operation holds no `$run` (no query uses it).
 */
import { describe, expect, test } from 'bun:test';
import { composePage, type Bootstrap } from '../src/page-contract/index.js';

const RUN_TEMPLATE = `template: run
variables:
  run:
    type: String
    required: true
sections:
  - id: run
    component: run
    params:
      runVariable: run
`;

function bootstrap(): Bootstrap {
  return {
    structureRevision: 'r1',
    home: null,
    catalogueTemplate: 'entity',
    templates: [{ name: 'run', body: RUN_TEMPLATE }],
    recordTemplates: [],
    ownTemplates: [],
    roles: ['all'],
  };
}

describe('a command template', () => {
  test('binds a variable no query uses, and the operation declares no unused variable', () => {
    const composition = composePage(bootstrap(), { template: 'run', params: { run: 'fill-1' }, lang: 'ru' });
    expect(composition.findings).toEqual([]);
    expect(composition.variables.run).toBe('fill-1');
    expect(composition.operation).toBe('');
    expect(composition.sections.map((one) => one.component)).toEqual(['run']);
  });

  test('refuses a required variable the address does not bind', () => {
    const composition = composePage(bootstrap(), { template: 'run', params: {}, lang: 'en' });
    expect(composition.findings.map((one) => one.message).join('\n')).toContain('$run is required');
  });
});
