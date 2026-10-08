import { describe, expect, test } from 'bun:test';
import { assigned, checkModel, numberedLines, Repo, runScript, withRepo } from './model-check-repo.js';

/**
 * The model check's requirements-resolve requirement (docs/changes/
 * use-cases-data-entities/capabilities/model-check.md): every requirement a
 * scenario names, `capability/requirement`, resolves to a heading
 * `## Requirement: <id>` in the file named after the capability under
 * `docs/system/capabilities/`, read at the checked revision — a missing
 * file or heading fails the check naming the scenario, the requirement,
 * the model file and line where it is named, and which of the two is
 * missing. Every test builds its own small git repository and states the
 * expected finding from the requirement text, never from the code under
 * test.
 */

/** Writes the sources commit and returns the evidence pair a model can name. */
function sourcesCommit(repo: Repo): { commit: string; blob: string } {
  repo.write('src/core.ts', numberedLines(30));
  const commit = repo.commit('the sources');
  return { commit, blob: repo.blob('src/core.ts', commit) };
}

/** The review a requirements fixture needs: sources to the element, everything else excluded. */
function requirementsReview(): string[][] {
  return assigned([['src/', 'core', ''], ['docs/', 'excluded', 'the capability specs']]);
}

/**
 * A model whose one scenario names the given requirements: two elements
 * and the relation the scenario's single step stands on, all with
 * resolving evidence, then the scenario itself. `extra` lines join the
 * scenario's YAML, so a test can add a second scenario.
 */
function scenarioModel(commit: string, blob: string, requirements: readonly string[], scenarioId = 'send-model', extra: readonly string[] = []): string {
  const requirementLines = requirements.length === 0 ? '' : ['    requirements:', ...requirements.map((r) => `      - ${r}`)].join('\n') + '\n';
  const evidence = ['      - file: src/core.ts', `        commit: ${commit}`, `        blob: ${blob}`].join('\n');
  return [
    'version: 1',
    '',
    'elements:',
    '  - id: core',
    '    kind: service',
    '    name: Core',
    '    evidence:',
    evidence,
    '  - id: store',
    '    kind: service',
    '    name: Store',
    '    evidence:',
    evidence,
    '',
    'relations:',
    '  - id: core-sends-to-store',
    '    name: sends the model',
    '    from: core',
    '    to: store',
    '    evidence:',
    evidence,
    '',
    'scenarios:',
    `  - id: ${scenarioId}`,
    '    name: Send the model',
    requirementLines + '    steps:',
    '      - { id: s1, relation: core-sends-to-store }',
    ...extra,
    '',
  ].join('\n');
}

/** One capability spec: a title, then one `## Requirement:` heading per id given, each as written. */
function spec(title: string, headings: readonly string[]): string {
  return [`# ${title}`, '', ...headings.map((heading) => `## Requirement: ${heading}`), ''].join('\n');
}

describe('requirements-resolve', () => {
  test('requirement-found: a scenario naming a requirement the spec holds reports nothing about it', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept', 'store-version — The kept model has a version']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store', 'server/store-version']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
      expect(report.notes).toEqual([]);
    });
  });

  test('requirement-found: a heading ended by the end of the line or a space satisfies the id as the em-dash form does', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store', 'bare-id Title written after a space']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store', 'server/bare-id']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
    });
  });

  test('requirement-found: a heading whose id merely starts the same way does not satisfy a shorter id, and the reverse', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      // `store-version` is a requirement; `store` is not, so a heading for
      // `store-version` must not satisfy `store` — and a heading for `store`
      // must not satisfy `store-version` either.
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store-version — The kept model has a version']));
      repo.write('docs/system/capabilities/billing.md', spec('Billing', ['store, written with a comma']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store', 'billing/store-version']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors).toHaveLength(2);
      for (const [index, needle] of ['- server/store', '- billing/store-version'].entries()) {
        expect(report.errors[index]!.file).toBe('madarch/model.yaml');
        expect(report.errors[index]!.line).toBe(repo.lineOf('model.yaml', needle));
        expect(report.errors[index]!.message).toContain(needle.slice(2));
      }
    });
  });

  test('unknown-requirement: a scenario naming a requirement the spec does not hold fails, naming the scenario, the requirement, the model file and line, and saying the spec has no such requirement', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/archive']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]!.id).toBe('server/archive');
      expect(report.errors[0]!.file).toBe('madarch/model.yaml');
      expect(report.errors[0]!.line).toBe(repo.lineOf('model.yaml', '- server/archive'));
      expect(report.errors[0]!.message).toContain('send-model');
      // The finding says server.md has no requirement "archive": the
      // requirement's own id, neither the whole `server/archive` nor a
      // fragment of it.
      expect(report.errors[0]!.message).toContain('server.md has no requirement "archive"');
    });
  });

  test('unknown-capability: a scenario naming a capability with no spec at all fails, saying there is no such capability spec', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['billing/refund']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]!.id).toBe('billing/refund');
      expect(report.errors[0]!.file).toBe('madarch/model.yaml');
      expect(report.errors[0]!.line).toBe(repo.lineOf('model.yaml', '- billing/refund'));
      expect(report.errors[0]!.message).toContain('send-model');
      expect(report.errors[0]!.message).toContain('billing/refund');
      // The finding says there is no capability spec "billing" and names
      // the file it looked for.
      expect(report.errors[0]!.message).toContain('there is no capability spec "billing"');
      expect(report.errors[0]!.message).toContain('docs/system/capabilities/billing.md');
    });
  });

  test('every unresolved requirement is reported, sorted by file, then line, then id in code-point order', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      // Two scenarios in two model files: one names two unknown requirements
      // block-style (zebra written before ant), the other names two on one
      // line (yak written before ant). The report is sorted by file, then
      // line, then id — not by the order the walk found them in.
      repo.writeModel('a-first.yaml', scenarioModel(commit, blob, ['server/zebra', 'billing/ant'], 'a-model', [
        '',
        '  - id: send-model',
        '    name: Sends again',
        '    requirements: [server/yak, billing/ant]',
        '    steps:',
        '      - { id: s1, relation: core-sends-to-store }',
      ]));
      repo.writeModel('z-second.yaml', [
        'version: 1',
        '',
        'elements: []',
        '',
        'scenarios:',
        '  - id: late-model',
        '    name: Sends late',
        '    requirements:',
        '      - server/yak',
        '    steps:',
        '      - { id: s1, relation: core-sends-to-store }',
        '',
      ].join('\n'));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors.map((f) => `${f.file}:${f.line}:${f.id}`)).toEqual([
        `madarch/a-first.yaml:${repo.lineOf('a-first.yaml', '- server/zebra')}:server/zebra`,
        `madarch/a-first.yaml:${repo.lineOf('a-first.yaml', '- billing/ant')}:billing/ant`,
        // One line, two findings: the id decides, in code-point order.
        `madarch/a-first.yaml:${repo.lineOf('a-first.yaml', 'requirements: [server/yak, billing/ant]')}:billing/ant`,
        `madarch/a-first.yaml:${repo.lineOf('a-first.yaml', 'requirements: [server/yak, billing/ant]')}:server/yak`,
        `madarch/z-second.yaml:${repo.lineOf('z-second.yaml', '- server/yak')}:server/yak`,
      ]);
    });
  });

  test('the specs are read at the checked revision, not the working tree: a requirement removed after the model named it fails only at the newer revision', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      const modelCommit = repo.commit('the model');
      // After the model lands, the spec is rewritten: the requirement is
      // gone at the working tree but still present at the revision the
      // model was checked against.
      repo.write('docs/system/capabilities/server.md', spec('Server', ['archive — Old models are archived']));
      const removedAt = repo.commit('the spec loses the requirement');

      const atOld = checkModel(repo.path, { rev: modelCommit });
      expect(atOld.outcome).toBe('passed');
      expect(atOld.errors).toEqual([]);

      const atNew = checkModel(repo.path, { rev: removedAt });
      expect(atNew.outcome).toBe('failed');
      expect(atNew.errors).toHaveLength(1);
      expect(atNew.errors[0]!.message).toContain('server/store');
      expect(atNew.errors[0]!.message).toContain('server.md');
    });
  });

  test('a scenario that names no requirement resolves nothing, with the key left out entirely too: the check passes with no findings about it', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      // One scenario states `requirements` as an empty list; the other
      // leaves the key out: neither resolves anything, and neither may
      // become a finding about a requirement it never named.
      repo.writeModel('model.yaml', scenarioModel(commit, blob, [], 'send-model', [
        '',
        '  - id: bare-model',
        '    name: Sends bare',
        '    steps:',
        '      - { id: s1, relation: core-sends-to-store }',
      ]));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
    });
  });

  test('a model that does not compile reports nothing this section could compute', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['billing/refund']).replace('    name: Store\n', '    name: Store\n    parent: nowhere\n'));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      // Only the loader's refusal is reported: no requirement finding.
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]!.message).toContain('nowhere');
    });
  });

  test('the command reports an unresolved requirement the way a person reads it, exiting 1', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/archive']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const run = runScript(repo.path);

      expect(run.status).toBe(1);
      expect(run.stdout).toContain('error: madarch/model.yaml:');
      expect(run.stdout).toContain('send-model');
      expect(run.stdout).toContain('server/archive');
      expect(run.stdout).toContain('server.md');
    });
  });

  test('the command reports a found requirement the way a person reads it, exiting 0', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const run = runScript(repo.path);

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain('send-model');
    });
  });

  test('a heading inside a fenced code block is an example, not a requirement', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', ['# Server', '', 'An example of the form:', '', '```markdown', '## Requirement: archive — An example heading', '```', ''].join('\n'));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/archive']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors).toContainEqual(
        expect.objectContaining({ path: 'scenarios[0].requirements[0]', message: expect.stringContaining('has no requirement "archive"') }),
      );
    });
  });

  test('a heading inside an indented fenced code block is an example too', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', ['# Server', '', '  ```markdown', '## Requirement: archive — An example heading', '  ```', ''].join('\n'));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/archive']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('has no requirement "archive"') }));
    });
  });

  test('a fence is closed only by the same character, at least as long, with nothing after it', () => {
    const cases: { name: string; spec: string[] }[] = [
      { name: 'a shorter closing run', spec: ['# Server', '', '````markdown', '## Requirement: archive — An example', '```', ''] },
      { name: 'a closing run of the other character', spec: ['# Server', '', '```', '## Requirement: archive — An example', '~~~', ''] },
      { name: 'a closing line with a suffix', spec: ['# Server', '', '```', '## Requirement: archive — An example', '``` extra', ''] },
    ];
    for (const { name, spec: lines } of cases) {
      withRepo((repo) => {
        const { commit, blob } = sourcesCommit(repo);
        repo.write('docs/system/capabilities/server.md', [...lines, '## Requirement: store — Sent models are kept', ''].join('\n'));
        repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
        repo.writeReview([], requirementsReview());
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome, name).toBe('failed');
        expect(report.errors, name).toContainEqual(expect.objectContaining({ message: expect.stringContaining('has no requirement "store"') }));
      });
    }
  });

  test('a fence that opens and closes leaves the headings after it readable', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', ['# Server', '', '```markdown', '## Requirement: archive — An example', '```', '', '## Requirement: store — Sent models are kept', ''].join('\n'));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
    });
  });

  test('a closing fence may carry trailing spaces', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', ['# Server', '', '```markdown', '## Requirement: archive — An example', '```   ', '', '## Requirement: store — Sent models are kept', ''].join('\n'));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
    });
  });

  test('a fence marker is read only at the start of a line, and only a run of three', () => {
    const cases: { name: string; prose: string }[] = [
      { name: 'a marker inside a line of prose', prose: 'The format writes ```yaml and ~~~ for a fence.' },
      { name: 'a single backtick', prose: '`store` is the id of the requirement.' },
      { name: 'a single tilde', prose: '~10 items are enough.' },
    ];
    for (const { name, prose } of cases) {
      withRepo((repo) => {
        const { commit, blob } = sourcesCommit(repo);
        repo.write('docs/system/capabilities/server.md', ['# Server', '', prose, '', '## Requirement: store — Sent models are kept', ''].join('\n'));
        repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
        repo.writeReview([], requirementsReview());
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome, name).toBe('passed');
        expect(report.errors, name).toEqual([]);
      });
    }
  });

  test('a marker indented by three spaces is a fence, and hides the headings in it', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', ['# Server', '', '   ```markdown', '## Requirement: store — Sent models are kept', '   ```', ''].join('\n'));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('failed');
      expect(report.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('has no requirement "store"') }));
    });
  });

  test('a line indented by four spaces is an indented code block, not a fence, so it hides nothing', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', ['# Server', '', '    ```', '', '## Requirement: store — Sent models are kept', ''].join('\n'));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
    });
  });

  test('a heading whose line ends with a carriage return satisfies the id', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', '# Server\r\n\r\n## Requirement: store\r\n');
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.errors).toEqual([]);
      expect(report.outcome).toBe('passed');
    });
  });

  test('an unresolved requirement names the full path it is written at', () => {
    withRepo((repo) => {
      const { commit, blob } = sourcesCommit(repo);
      repo.write('docs/system/capabilities/server.md', spec('Server', ['store — Sent models are kept']));
      repo.writeModel('model.yaml', scenarioModel(commit, blob, ['server/archive', 'server/store']));
      repo.writeReview([], requirementsReview());
      repo.commit('the model');

      const report = checkModel(repo.path);

      expect(report.errors).toEqual([
        expect.objectContaining({ id: 'server/archive', file: 'madarch/model.yaml', path: 'scenarios[0].requirements[0]' }),
      ]);
    });
  });
});
