import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assigned, checkModel, completeRepo, Repo, runScript, withRepo } from './model-check-repo.js';
import type { ModelCheckReport } from '../src/check/model-check.js';
import { sortedByCodePoint } from '../src/model/order.js';

/**
 * The model check's problems (docs/changes/agent-model/capabilities/
 * model-check.md, requirement problems): cycle-between-siblings,
 * sink-without-reader, hidden-coupling, plus one test each for the rest of
 * the six kinds and the guards around them. Every test builds its own small
 * git repository and states the expected finding from the definition, never
 * from the code under test. Problems never fail the check.
 */

/** The YAML lines of one element with resolving evidence on its own source file. */
function elementGroup(id: string, kind: string, commit: string, blob: string, extra: readonly string[] = []): string[] {
  return [`  - id: ${id}`, `    kind: ${kind}`, `    evidence:`, `      - file: src/${id}.ts`, `        commit: ${commit}`, `        blob: ${blob}`, ...extra];
}

/** The YAML lines of one named relation with resolving evidence on its initiator's source file. */
function relationGroup(id: string, from: string, to: string, commit: string, blob: string, extra: readonly string[] = []): string[] {
  return [`  - id: ${id}`, `    name: ${id}`, `    from: ${from}`, `    to: ${to}`, `    evidence:`, `      - file: src/${from}.ts`, `        commit: ${commit}`, `        blob: ${blob}`, ...extra];
}

/** The YAML lines of one interface with resolving evidence on its provider's source file. */
function interfaceGroup(id: string, provider: string, contract: string, commit: string, blob: string): string[] {
  return [`  - id: ${id}`, `    provider: ${provider}`, `    contract: ${contract}`, `    evidence:`, `      - file: src/${provider}.ts`, `        commit: ${commit}`, `        blob: ${blob}`];
}

/** The YAML lines of one transfer, for a relation's `extra` lines. */
function transfer(direction: 'forward' | 'reverse', confidentiality: string): string[] {
  return ['    transfers:', `      - direction: ${direction}`, `        confidentiality: ${confidentiality}`, '        categories: []'];
}

/** Writes a model holding the given element, interface and relation groups, with its review, and commits both. */
function commitModel(repo: Repo, elements: string[][], interfaces: string[][], relations: string[][], assignmentRows: string[][]): string {
  const parts = ['version: 1'];
  for (const [heading, groups] of [
    ['elements', elements],
    ['interfaces', interfaces],
    ['relations', relations],
  ] as const) {
    if (groups.length > 0) parts.push('', `${heading}:`, ...groups.flat());
  }
  parts.push('');
  repo.writeModel('model.yaml', parts.join('\n'));
  repo.writeReview([], assigned(assignmentRows));
  return repo.commit('the model');
}

/** Writes one source file per id and commits them all as `the sources`; the sources commit is the model's evidence. */
function commitSources(repo: Repo, ids: readonly string[]): string {
  for (const id of ids) repo.write(`src/${id}.ts`, `export const ${id} = 1;\n`);
  return repo.commit('the sources');
}

/** The problems section of the check of `repo`, the one thing every test here reads. */
function problemsOf(repo: Repo): ModelCheckReport['problems'] {
  return checkModel(repo.path).problems;
}

test('cycle-between-siblings: three modules under one service form one cycle, naming them and their relations, citing the Acyclic Dependencies Principle', () => {
  withRepo((repo) => {
    const commit = commitSources(repo, ['svc', 'a', 'b', 'c']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [
        elementGroup('svc', 'service', commit, blob('svc')),
        elementGroup('a', 'module', commit, blob('a'), ['    parent: svc']),
        elementGroup('b', 'module', commit, blob('b'), ['    parent: svc']),
        elementGroup('c', 'module', commit, blob('c'), ['    parent: svc']),
      ],
      [],
      [
        relationGroup('ra', 'a', 'b', commit, blob('a')),
        relationGroup('rb', 'b', 'c', commit, blob('b')),
        relationGroup('rc', 'c', 'a', commit, blob('c')),
      ],
      [
        ['src/svc.ts', 'svc', ''],
        ['src/a.ts', 'a', ''],
        ['src/b.ts', 'b', ''],
        ['src/c.ts', 'c', ''],
      ],
    );

    const report = checkModel(repo.path);
    expect(report.outcome).toBe('passed');
    expect(report.problems).toHaveLength(1);
    const cycle = report.problems[0]!;
    expect(cycle.problem).toBe('cycle');
    expect(cycle.ids).toEqual(['a', 'b', 'c', 'ra', 'rb', 'rc']);
    expect(cycle.method).toBe('Acyclic Dependencies Principle; Arcan Cyclic Dependency');
    expect(cycle.source).toBe('R. C. Martin, Design Principles and Design Patterns (2000); F. Arcelli Fontana et al., Arcan (ICSA 2017)');
    for (const relation of ['ra', 'rb', 'rc']) expect(cycle.message).toContain(relation);

    // Problems never fail the check: the script still exits 0 and prints the problem between stale and warnings.
    const run = runScript(repo.path);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('problem cycle:');
  });
});

test('sink-without-reader: a topic one relation sends to and none receives from is a magic sink, naming the interface and the sending relation', () => {
  withRepo((repo) => {
    const commit = commitSources(repo, ['ui', 'core']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [elementGroup('ui', 'module', commit, blob('ui')), elementGroup('core', 'service', commit, blob('core'))],
      [interfaceGroup('orders-topic', 'core', 'topic::orders', commit, blob('core'))],
      [relationGroup('ui-sends', 'ui', 'core', commit, blob('ui'), ['    interface: orders-topic', '    action: send'])],
      [
        ['src/ui.ts', 'ui', ''],
        ['src/core.ts', 'core', ''],
      ],
    );

    const report = checkModel(repo.path);
    expect(report.outcome).toBe('passed');
    expect(report.problems).toHaveLength(1);
    const sink = report.problems[0]!;
    expect(sink.problem).toBe('magic-source-or-sink');
    expect(sink.ids).toEqual(['orders-topic', 'ui-sends']);
    expect(sink.method).toBe('sensible data flow diagram: no magic data sources or sinks');
    expect(sink.source).toBe('S. Hernan, S. Lambert, T. Ostwald, A. Shostack, Uncover Security Design Flaws Using the STRIDE Approach (MSDN Magazine, 2006)');
    expect(sink.message).toContain('sink');
    expect(sink.message).toContain('within this model only');
  });
});

test('hidden-coupling: two unrelated modules whose files changed together in six commits are reported with the count and the three newest commits', () => {
  withRepo((repo) => {
    // The sources commit holds svc and x only, so x and y never share a commit but the six below.
    repo.write('src/svc.ts', 'export const svc = 1;\n');
    repo.write('src/x.ts', 'export const x = 1;\n');
    const sources = repo.commit('the sources');
    repo.write('src/y.ts', 'export const y = 1;\n');
    repo.commit('y arrives');
    const coChanges: string[] = [];
    for (let round = 1; round <= 6; round++) {
      repo.write('src/x.ts', `export const x = 1; // round ${round}\n`);
      repo.write('src/y.ts', `export const y = 1; // round ${round}\n`);
      coChanges.push(repo.commit(`round ${round} touches both`));
    }
    const last = coChanges[5]!;
    const xBlob = repo.blob('src/x.ts', last);
    const yBlob = repo.blob('src/y.ts', last);
    commitModel(
      repo,
      [
        elementGroup('svc', 'service', sources, repo.blob('src/svc.ts', sources)),
        elementGroup('x', 'module', last, xBlob, ['    parent: svc']),
        elementGroup('y', 'module', last, yBlob, ['    parent: svc']),
      ],
      [],
      [],
      [
        ['src/svc.ts', 'svc', ''],
        ['src/x.ts', 'x', ''],
        ['src/y.ts', 'y', ''],
      ],
    );

    const report = checkModel(repo.path);
    expect(report.outcome).toBe('passed');
    expect(report.problems).toHaveLength(1);
    const coupling = report.problems[0]!;
    expect(coupling.problem).toBe('hidden-coupling');
    expect(coupling.ids).toEqual(['x', 'y']);
    expect(coupling.method).toBe('modularity violation (co-change without a structural dependency)');
    expect(coupling.source).toBe('R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015)');
    expect(coupling.message).toContain('6');
    // The threshold and the window are printed with the finding.
    expect(coupling.message).toContain('5');
    expect(coupling.message).toContain('180');
    // The three newest of the six commits, never the older ones.
    for (const newest of [coChanges[3]!, coChanges[4]!, coChanges[5]!]) expect(coupling.message).toContain(newest);
    for (const older of [coChanges[0]!, coChanges[1]!, coChanges[2]!]) expect(coupling.message).not.toContain(older);
  });
});

test('a shallow clone whose boundary falls inside the window says hidden coupling was computed over the available history only', () => {
  withRepo((repo) => {
    repo.write('src/svc.ts', 'export const svc = 1;\n');
    repo.write('src/x.ts', 'export const x = 1;\n');
    const sources = repo.commit('the sources');
    repo.write('src/y.ts', 'export const y = 1;\n');
    repo.commit('y arrives');
    let last = '';
    for (let round = 1; round <= 6; round++) {
      repo.write('src/x.ts', `export const x = 1; // round ${round}\n`);
      repo.write('src/y.ts', `export const y = 1; // round ${round}\n`);
      last = repo.commit(`round ${round} touches both`);
    }
    commitModel(
      repo,
      [
        elementGroup('svc', 'service', sources, repo.blob('src/svc.ts', sources)),
        elementGroup('x', 'module', last, repo.blob('src/x.ts', last), ['    parent: svc']),
        elementGroup('y', 'module', last, repo.blob('src/y.ts', last), ['    parent: svc']),
      ],
      [],
      [],
      [
        ['src/svc.ts', 'svc', ''],
        ['src/x.ts', 'x', ''],
        ['src/y.ts', 'y', ''],
      ],
    );

    // Control, the full history: six co-changes are reported, and nothing says shallow.
    const whole = checkModel(repo.path);
    expect(whole.problems.map((p) => p.problem)).toEqual(['hidden-coupling']);
    expect(whole.notes.find((f) => f.message.includes('shallow'))).toBeUndefined();

    // Two commits deep, the cut falls inside the 180-day window: one co-change survives.
    const clonePath = join(tmpdir(), `madarch-shallow-${process.pid}-${Date.now()}`);
    const cloned = spawnSync('git', ['clone', '--quiet', '--depth', '2', `file://${repo.path}`, clonePath], { encoding: 'utf8' });
    try {
      expect(cloned.status).toBe(0);
      const boundary = spawnSync('git', ['rev-list', '--max-parents=0', '--format=%ct', 'HEAD'], { cwd: clonePath, encoding: 'utf8' });
      expect(boundary.status).toBe(0);
      const boundarySeconds = Number(boundary.stdout.split('\n').find((line) => /^\d+$/.test(line)));

      const report = checkModel(clonePath);

      expect(report.problems).toEqual([]);
      const shallow = report.notes.find((f) => f.message.includes('shallow'));
      expect(shallow?.message).toContain('hidden coupling was computed over the available history only');
      expect(shallow?.message).toContain(new Date(boundarySeconds * 1000).toISOString());
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });
});

test('unstable dependency: an element depending on a sibling less stable than itself is reported with both instability values', () => {
  withRepo((repo) => {
    // Instabilities by hand: a points at r and s (Ce=2, Ca=1, I=2/3); c is pointed at by p and points at a (Ce=1, Ca=1, I=1/2);
    // p (I=1), r and s (I=0). The only arrow to a less stable end is c -> a: 0.67 > 0.50.
    const commit = commitSources(repo, ['a', 'c', 'p', 'r', 's']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [elementGroup('a', 'service', commit, blob('a')), elementGroup('c', 'service', commit, blob('c')), elementGroup('p', 'service', commit, blob('p')), elementGroup('r', 'service', commit, blob('r')), elementGroup('s', 'service', commit, blob('s'))],
      [],
      [relationGroup('rpc', 'p', 'c', commit, blob('p')), relationGroup('rca', 'c', 'a', commit, blob('c')), relationGroup('rar', 'a', 'r', commit, blob('a')), relationGroup('ras', 'a', 's', commit, blob('a'))],
      [
        ['src/a.ts', 'a', ''],
        ['src/c.ts', 'c', ''],
        ['src/p.ts', 'p', ''],
        ['src/r.ts', 'r', ''],
        ['src/s.ts', 's', ''],
      ],
    );

    const problems = problemsOf(repo);
    expect(problems).toHaveLength(1);
    const unstable = problems[0]!;
    expect(unstable.problem).toBe('unstable-dependency');
    expect(unstable.ids).toEqual(['a', 'c', 'rca']);
    expect(unstable.method).toBe('Stable Dependencies Principle; Arcan Unstable Dependency');
    expect(unstable.message).toContain('0.50');
    expect(unstable.message).toContain('0.67');
  });
});

test('hub: an element with five relations in and five out is reported with the threshold; four in and five out, or five in and four out, is not', () => {
  withRepo((repo) => {
    // h takes five relations in and gives five out; h2 takes four in and gives five out, one short
    // of the threshold; h3 takes five in and gives four out, also one short.
    const inOfH = ['i1', 'i2', 'i3', 'i4', 'i5'];
    const outOfH = ['o1', 'o2', 'o3', 'o4', 'o5'];
    const inOfH2 = ['j1', 'j2', 'j3', 'j4'];
    const outOfH2 = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const inOfH3 = ['g1', 'g2', 'g3', 'g4', 'g5'];
    const outOfH3 = ['m1', 'm2', 'm3', 'm4'];
    const everyone = ['h', 'h2', 'h3', ...inOfH, ...outOfH, ...inOfH2, ...outOfH2, ...inOfH3, ...outOfH3];
    const commit = commitSources(repo, everyone);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    const elements = everyone.map((id) => elementGroup(id, 'service', commit, blob(id)));
    const relations = [
      ...inOfH.map((id, index) => relationGroup(`rh${index + 1}`, id, 'h', commit, blob(id))),
      ...outOfH.map((id, index) => relationGroup(`rh-out${index + 1}`, 'h', id, commit, blob('h'))),
      ...inOfH2.map((id, index) => relationGroup(`rh2-${index + 1}`, id, 'h2', commit, blob(id))),
      ...outOfH2.map((id, index) => relationGroup(`rh2-out${index + 1}`, 'h2', id, commit, blob('h2'))),
      ...inOfH3.map((id, index) => relationGroup(`rh3-${index + 1}`, id, 'h3', commit, blob(id))),
      ...outOfH3.map((id, index) => relationGroup(`rh3-out${index + 1}`, 'h3', id, commit, blob('h3'))),
    ];
    commitModel(repo, elements, [], relations, everyone.map((id) => [`src/${id}.ts`, id, '']));

    const problems = problemsOf(repo);
    expect(problems).toHaveLength(1);
    const hub = problems[0]!;
    expect(hub.problem).toBe('hub');
    // The finding names the element and the relation ids behind its arrows in and out at its level.
    const expectedHubIds = sortedByCodePoint(['h', ...inOfH.map((_, index) => `rh${index + 1}`), ...outOfH.map((_, index) => `rh-out${index + 1}`)]);
    expect(hub.ids).toEqual(expectedHubIds);
    expect(hub.method).toBe('Arcan Hub-Like Dependency');
    expect(hub.source).toBe('F. Arcelli Fontana et al., Arcan (ICSA 2017)');
    expect(hub.message).toContain('5');
    expect(hub.message).toContain('threshold');
    expect(hub.message).not.toContain('h2');
    expect(hub.message).not.toContain('h3');
    // The human output names the finding's ids too, not only the JSON.
    const run = runScript(repo.path);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('problem hub:');
    expect(run.stdout).toContain(`(ids: ${expectedHubIds.join(', ')})`);
  });
});

test('store sink and source by transfers: a store all transfers move into is a sink, one they all leave is a source, one without transfers is neither', () => {
  withRepo((repo) => {
    const commit = commitSources(repo, ['w', 'db', 'w2', 'db2', 'w3', 'idle']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [
        elementGroup('w', 'service', commit, blob('w')),
        elementGroup('db', 'store', commit, blob('db')),
        elementGroup('w2', 'service', commit, blob('w2')),
        elementGroup('db2', 'store', commit, blob('db2')),
        elementGroup('w3', 'service', commit, blob('w3')),
        elementGroup('idle', 'store', commit, blob('idle')),
      ],
      [],
      [
        relationGroup('rwd', 'w', 'db', commit, blob('w'), transfer('forward', 'internal')),
        relationGroup('rw2', 'w2', 'db2', commit, blob('w2'), transfer('reverse', 'internal')),
        relationGroup('rw3', 'w3', 'idle', commit, blob('w3')),
      ],
      [
        ['src/w.ts', 'w', ''],
        ['src/db.ts', 'db', ''],
        ['src/w2.ts', 'w2', ''],
        ['src/db2.ts', 'db2', ''],
        ['src/w3.ts', 'w3', ''],
        ['src/idle.ts', 'idle', ''],
      ],
    );

    const problems = problemsOf(repo);
    expect(problems).toHaveLength(2);
    const [sink, source] = problems;
    expect(sink!.problem).toBe('magic-source-or-sink');
    expect(sink!.ids).toEqual(['db', 'rwd']);
    expect(sink!.message).toContain('sink');
    expect(source!.problem).toBe('magic-source-or-sink');
    expect(source!.ids).toEqual(['db2', 'rw2']);
    expect(source!.message).toContain('source');
    for (const finding of problems) expect(finding.ids).not.toContain('idle');
  });
});

test('trust boundary by zones: an interaction whose ends sit in different zones is reported as a question to examine', () => {
  withRepo((repo) => {
    const commit = commitSources(repo, ['svc2', 'ext']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    const parts = ['version: 1', '', 'zones:', '  - id: internet', '    kind: network', '  - id: office', '    kind: network', '', 'elements:'];
    parts.push(
      ...elementGroup('svc2', 'service', commit, blob('svc2'), ['    zones:', '      add: [office]']),
      ...elementGroup('ext', 'external', commit, blob('ext'), ['    zones:', '      add: [internet]']),
      '',
      'interfaces:',
      ...interfaceGroup('api2', 'svc2', 'http::GET::/api', commit, blob('svc2')),
      '',
      'relations:',
      ...relationGroup('s2e', 'svc2', 'ext', commit, blob('svc2'), ['    interface: api2']),
      '',
    );
    repo.writeModel('model.yaml', parts.join('\n'));
    repo.writeReview([], assigned([['src/svc2.ts', 'svc2', ''], ['src/ext.ts', 'ext', '']]));
    repo.commit('the model');

    const problems = problemsOf(repo);
    expect(problems).toHaveLength(1);
    const crossing = problems[0]!;
    expect(crossing.problem).toBe('trust-boundary-crossing');
    expect(crossing.ids).toEqual(['ext', 's2e', 'svc2']);
    expect(crossing.method).toBe('STRIDE per element: data flow across a trust boundary (examine tampering, information disclosure, denial of service)');
    // Reported as a question: the text says what to examine, it does not declare a defect.
    expect(crossing.message).toContain('examine');
    expect(crossing.message).toContain('internet');
    expect(crossing.message).toContain('office');
  });
});

test('confidential transfer to an external element is a question, forward or reverse; a public transfer to an external is not', () => {
  withRepo((repo) => {
    const commit = commitSources(repo, ['b', 'ext2', 'ext3', 'ext4']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [elementGroup('b', 'module', commit, blob('b')), elementGroup('ext2', 'external', commit, blob('ext2')), elementGroup('ext3', 'external', commit, blob('ext3')), elementGroup('ext4', 'external', commit, blob('ext4'))],
      [],
      [
        // Two transfers over one relation to one external: one finding, not two.
        relationGroup('bx', 'b', 'ext2', commit, blob('b'), [
          '    transfers:',
          '      - direction: forward',
          '        confidentiality: confidential',
          '        categories: []',
          '      - direction: forward',
          '        confidentiality: secret',
          '        categories: []',
        ]),
        relationGroup('bx3', 'b', 'ext3', commit, blob('b'), transfer('forward', 'public')),
        // The reverse transfer flows against the relation's direction, so its recipient is the relation's own from end.
        relationGroup('bxe', 'ext4', 'b', commit, blob('b'), transfer('reverse', 'confidential')),
      ],
      [
        ['src/b.ts', 'b', ''],
        ['src/ext2.ts', 'ext2', ''],
        ['src/ext3.ts', 'ext3', ''],
        ['src/ext4.ts', 'ext4', ''],
      ],
    );

    const problems = problemsOf(repo);
    expect(problems).toHaveLength(2);
    const [forward, reverse] = problems;
    expect(forward!.problem).toBe('trust-boundary-crossing');
    expect(forward!.ids).toEqual(['b', 'bx', 'ext2']);
    expect(forward!.message).toContain('confidential');
    expect(forward!.message).toContain('external');
    expect(forward!.message).toContain('examine');
    expect(forward!.message).not.toContain('ext3');
    expect(problems.filter((problem) => problem.ids.includes('bx'))).toHaveLength(1);
    expect(reverse!.ids).toEqual(['b', 'bxe', 'ext4']);
    expect(reverse!.message).toContain('ext4');
  });
});

test('a refinement is counted once: a relation and its own refinement are not a cycle', () => {
  withRepo((repo) => {
    // r carries P -> Q; s refines it as m -> n. Nothing reverses, so no kind may report anything.
    const commit = commitSources(repo, ['P', 'Q', 'm', 'n']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [
        elementGroup('P', 'service', commit, blob('P')),
        elementGroup('Q', 'service', commit, blob('Q')),
        elementGroup('m', 'module', commit, blob('m'), ['    parent: P']),
        elementGroup('n', 'module', commit, blob('n'), ['    parent: Q']),
      ],
      [],
      [relationGroup('r', 'P', 'Q', commit, blob('P')), relationGroup('s', 'm', 'n', commit, blob('m'), ['    refines: r'])],
      [
        ['src/P.ts', 'P', ''],
        ['src/Q.ts', 'Q', ''],
        ['src/m.ts', 'm', ''],
        ['src/n.ts', 'n', ''],
      ],
    );

    expect(problemsOf(repo)).toEqual([]);
  });
});

test('a bulk commit is ignored: five co-changes where one touches more than thirty files report nothing', () => {
  withRepo((repo) => {
    const filler = Array.from({ length: 29 }, (_, i) => `fill/f${String(i + 1).padStart(2, '0')}`);
    repo.write('src/svc2b.ts', 'export const svc2b = 1;\n');
    repo.write('src/x2.ts', 'export const x2 = 1;\n');
    const sources = repo.commit('the sources');
    repo.write('src/y2.ts', 'export const y2 = 1;\n');
    repo.commit('y2 arrives');
    for (const file of filler) repo.write(`src/${file}.ts`, `export const one = 1;\n`);
    repo.commit('the filler files arrive');

    // Four small co-changes (below the threshold of five), then a fifth that touches 31 files and must be skipped as bulk.
    for (let round = 1; round <= 4; round++) {
      repo.write('src/x2.ts', `export const x2 = 1; // round ${round}\n`);
      repo.write('src/y2.ts', `export const y2 = 1; // round ${round}\n`);
      repo.commit(`round ${round} touches both`);
    }
    for (const file of filler) repo.write(`src/${file}.ts`, `export const two = 2;\n`);
    repo.write('src/x2.ts', 'export const x2 = 1; // bulk\n');
    repo.write('src/y2.ts', 'export const y2 = 1; // bulk\n');
    repo.commit('the bulk round touches 31 files');

    const head = repo.run(['rev-parse', 'HEAD']).stdout.trim();
    commitModel(
      repo,
      [
        elementGroup('svc2b', 'service', sources, repo.blob('src/svc2b.ts', sources)),
        elementGroup('x2', 'module', head, repo.blob('src/x2.ts', head), ['    parent: svc2b']),
        elementGroup('y2', 'module', head, repo.blob('src/y2.ts', head), ['    parent: svc2b']),
      ],
      [],
      [],
      [
        ['src/svc2b.ts', 'svc2b', ''],
        ['src/x2.ts', 'x2', ''],
        ['src/y2.ts', 'y2', ''],
        ['src/fill/', 'excluded', 'test filler'],
      ],
    );

    expect(problemsOf(repo)).toEqual([]);
  });
});

test('commits older than the window do not count: four co-changes inside 180 days and one outside report nothing', () => {
  withRepo((repo) => {
    // The checked revision sits at the fixture's fixed moment (2025-09-01); the old round is about 212 days before it.
    // Each file arrives in its own commit, so the only commits touching x3 and y3 together
    // are the old round and the four recent ones.
    repo.write('src/svc3.ts', 'export const svc3 = 1;\n');
    const sources = repo.commit('svc3 arrives');
    repo.write('src/x3.ts', 'export const x3 = 1;\n');
    repo.commit('x3 arrives');
    repo.write('src/y3.ts', 'export const y3 = 1;\n');
    repo.commit('y3 arrives');
    repo.write('src/x3.ts', 'export const x3 = 1; // long ago\n');
    repo.write('src/y3.ts', 'export const y3 = 1; // long ago\n');
    repo.commitAt('the old round touches both, long ago', '2025-02-01T00:00:00 +0000');
    for (let round = 1; round <= 4; round++) {
      repo.write('src/x3.ts', `export const x3 = 1; // round ${round}\n`);
      repo.write('src/y3.ts', `export const y3 = 1; // round ${round}\n`);
      repo.commit(`round ${round} touches both`);
    }
    const head = repo.run(['rev-parse', 'HEAD']).stdout.trim();
    commitModel(
      repo,
      [
        elementGroup('svc3', 'service', sources, repo.blob('src/svc3.ts', sources)),
        elementGroup('x3', 'module', head, repo.blob('src/x3.ts', head), ['    parent: svc3']),
        elementGroup('y3', 'module', head, repo.blob('src/y3.ts', head), ['    parent: svc3']),
      ],
      [],
      [],
      [
        ['src/svc3.ts', 'svc3', ''],
        ['src/x3.ts', 'x3', ''],
        ['src/y3.ts', 'y3', ''],
      ],
    );

    expect(problemsOf(repo)).toEqual([]);
  });
});


test('a store is read through its children: a transfer into a module inside a store makes the store a sink', () => {
  withRepo((repo) => {
    const commit = commitSources(repo, ['w', 'db', 'part']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [
        elementGroup('w', 'service', commit, blob('w')),
        elementGroup('db', 'store', commit, blob('db')),
        elementGroup('part', 'module', commit, blob('part'), ['    parent: db']),
      ],
      [],
      [relationGroup('rwp', 'w', 'part', commit, blob('w'), transfer('forward', 'internal'))],
      [
        ['src/w.ts', 'w', ''],
        ['src/db.ts', 'db', ''],
        ['src/part.ts', 'part', ''],
      ],
    );

    const problems = problemsOf(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe('magic-source-or-sink');
    expect(problems[0]!.ids).toEqual(['db', 'rwp']);
    expect(problems[0]!.message).toContain('sink');
  });
});

test('a relation between the pair is not hidden coupling: two co-changing modules joined by a relation report nothing', () => {
  withRepo((repo) => {
    // x sits under p, y under q, so the x -> y relation crosses levels and no level's
    // dependency problems fire; the pair itself is joined by that relation.
    const commit = commitSources(repo, ['p', 'q', 'x', 'y']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    for (let round = 1; round <= 6; round++) {
      repo.write('src/x.ts', `export const x = 1; // round ${round}\n`);
      repo.write('src/y.ts', `export const y = 1; // round ${round}\n`);
      repo.commit(`round ${round} touches both`);
    }
    commitModel(
      repo,
      [
        elementGroup('p', 'service', commit, blob('p')),
        elementGroup('q', 'service', commit, blob('q')),
        elementGroup('x', 'module', commit, blob('x'), ['    parent: p']),
        elementGroup('y', 'module', commit, blob('y'), ['    parent: q']),
      ],
      [],
      [relationGroup('rxy', 'x', 'y', commit, blob('x'))],
      [
        ['src/p.ts', 'p', ''],
        ['src/q.ts', 'q', ''],
        ['src/x.ts', 'x', ''],
        ['src/y.ts', 'y', ''],
      ],
    );

    expect(problemsOf(repo)).toEqual([]);
  });
});

test('an ancestor and its descendant are one line: six co-changes of a service and its module report nothing', () => {
  withRepo((repo) => {
    repo.write('src/svc4.ts', 'export const svc4 = 1;\n');
    repo.commit('svc4 arrives');
    repo.write('src/x4.ts', 'export const x4 = 1;\n');
    repo.commit('x4 arrives');
    for (let round = 1; round <= 6; round++) {
      repo.write('src/svc4.ts', `export const svc4 = 1; // round ${round}\n`);
      repo.write('src/x4.ts', `export const x4 = 1; // round ${round}\n`);
      repo.commit(`round ${round} touches both`);
    }
    const head = repo.run(['rev-parse', 'HEAD']).stdout.trim();
    commitModel(
      repo,
      [
        elementGroup('svc4', 'service', head, repo.blob('src/svc4.ts', head)),
        elementGroup('x4', 'module', head, repo.blob('src/x4.ts', head), ['    parent: svc4']),
      ],
      [],
      [],
      [
        ['src/svc4.ts', 'svc4', ''],
        ['src/x4.ts', 'x4', ''],
      ],
    );

    expect(problemsOf(repo)).toEqual([]);
  });
});
test('problems print by kind in the fixed order: a cycle, then an unstable dependency, then a magic sink', () => {
  withRepo((repo) => {
    // The cycle p -> q -> r -> p (I(p) = 1, I(q) = 1/2, I(r) = 1/3) leaves r -> p unstable;
    // the send-only topic on r adds the sink. The ids alone would order the findings the
    // other way round ("b-topic" before "p"), so the kind order is what this asserts.
    const commit = commitSources(repo, ['svc', 'p', 'q', 'r']);
    const blob = (id: string): string => repo.blob(`src/${id}.ts`, commit);
    commitModel(
      repo,
      [
        elementGroup('svc', 'service', commit, blob('svc')),
        elementGroup('p', 'module', commit, blob('p'), ['    parent: svc']),
        elementGroup('q', 'module', commit, blob('q'), ['    parent: svc']),
        elementGroup('r', 'module', commit, blob('r'), ['    parent: svc']),
      ],
      [interfaceGroup('b-topic', 'r', 'topic::orders', commit, blob('r'))],
      [
        relationGroup('rp', 'p', 'q', commit, blob('p')),
        relationGroup('rq', 'q', 'r', commit, blob('q')),
        relationGroup('rr', 'r', 'p', commit, blob('r')),
        relationGroup('prs', 'p', 'r', commit, blob('p'), ['    interface: b-topic', '    action: send']),
      ],
      [
        ['src/svc.ts', 'svc', ''],
        ['src/p.ts', 'p', ''],
        ['src/q.ts', 'q', ''],
        ['src/r.ts', 'r', ''],
      ],
    );

    expect(problemsOf(repo).map((problem) => problem.problem)).toEqual(['cycle', 'unstable-dependency', 'magic-source-or-sink']);
  });
});

test('a complete model with none of the six problems reports no problems at all', () => {
  const repo = completeRepo();
  try {
    const report = checkModel(repo.path);
    expect(report.outcome).toBe('passed');
    expect(report.problems).toEqual([]);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});
