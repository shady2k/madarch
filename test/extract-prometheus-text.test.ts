import { describe, expect, test } from 'bun:test';
import { parsePrometheusText } from '../src/extract/operations/prometheus-text.js';

describe('Prometheus exposition literal grammar', () => {
  test('metadata, escaped labels, timestamps and numeric grammar retain literal positions', () => {
    const text = '# HELP work_total Count\\nnext line\n# TYPE work_total counter\nwork_total{zone="a\\\"b",path="c\\\\d"} 1.5e+2 123\n';
    const result = parsePrometheusText(text);
    expect(result.errors).toEqual([]);
    expect(result.declarations.map((entry) => [entry.name, entry.kind, entry.value])).toEqual([
      ['work_total', 'help', 'Count\\nnext line'], ['work_total', 'type', 'counter'],
    ]);
    expect(result.samples.map((entry) => [entry.name, entry.labels, entry.line])).toEqual([['work_total', ['zone', 'path'], 3]]);
    const sample = result.samples[0]!;
    expect(text.slice(sample.start, sample.end)).toBe('work_total{zone="a\\\"b",path="c\\\\d"} 1.5e+2 123');
  });
  test('printf slots are typed argument identities, never guessed metric names', () => {
    const result = parsePrometheusText('queue_events_total{state=%q} %d\nqueue_size %.3f\n', true);
    expect(result.errors).toEqual([]);
    expect(result.argumentCount).toBe(3);
    expect(result.samples.map((entry) => [entry.name, entry.labelArguments, entry.valueArgument])).toEqual([
      ['queue_events_total', [0], 1], ['queue_size', [], 2],
    ]);
    expect(parsePrometheusText('queue_events_total{state="%q"} %d\n', true).samples).toEqual([]);
  });
  test('all sample number forms and empty label sets', () => {
    const result = parsePrometheusText('a{} +Inf\nb -Inf\nc NaN\nd -.5E-2\ne 1.\nf +2\n');
    expect(result.errors).toEqual([]);
    expect(result.samples.map((entry) => entry.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  for (const text of [
    'ok 1\nbad{a="x",a="y"} 2\n', 'bad{a="unterminated} 1\n',
    'bad{a="x\\t"} 1\n', 'bad 1e\n', 'bad 1 trailing\n', 'bad 1 1.5\n',
    '9bad 1\n', 'bad{9label="x"} 1\n', 'bad{a="x" b="y"} 1\n',
    '# TYPE bad unknown\n', '# HELP bad x\\t\n', 'prose that mentions a_total\n',
  ]) test(`malformed document never returns a silently smaller result: ${JSON.stringify(text)}`, () => {
    const result = parsePrometheusText(text);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.line).toBeGreaterThan(0);
    expect(result.errors[0]!.column).toBeGreaterThan(0);
    expect(result.samples).toEqual([]);
    expect(result.declarations).toEqual([]);
  });
  for (const format of ['x %[2]d\n', 'x %*d\n', 'x %s\n', 'x %\n', '# TYPE x %q\n']) {
    test(`unsupported printf syntax is explicit: ${JSON.stringify(format)}`, () => {
      const result = parsePrometheusText(format, true);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.samples).toEqual([]);
      expect(result.declarations).toEqual([]);
    });
  }
  test('ordinary comments, metadata-only fragments and escaped literal percent are distinct', () => {
    expect(parsePrometheusText('# this is not a declaration\n').declarations).toEqual([]);
    expect(parsePrometheusText('# TYPE disk_bytes gauge\n').declarations[0]?.name).toBe('disk_bytes');
    expect(parsePrometheusText('work_total{unit="%%"} %d\n', true).argumentCount).toBe(1);
    expect(parsePrometheusText('not-a-sample 1\n').samples).toEqual([]);
  });
  test('literal size bound fails explicitly', () => {
    expect(parsePrometheusText(' '.repeat(1_048_577)).errors[0]?.reason).toContain('exceeds');
  });
});
