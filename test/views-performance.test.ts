import { describe, expect, test } from 'bun:test';
import {
  buildViewSet,
  createLadybugEngine,
  createSqliteHistory,
  renderMermaidPages,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
  type ElementKind,
} from '../src/index.js';

/**
 * Performance requirement (views.md's "Quality requirements"): rendering
 * every view of a model of 1 000 elements takes under ten seconds on a
 * developer's laptop. Skipped when `MADARCH_SKIP_PERF` is set; under CI the
 * measured time is logged rather than asserted, the same as
 * `test/query-engine-performance.test.ts`.
 */

const AT = Date.UTC(2026, 8, 25);

function element(id: string, kind: ElementKind, ancestors: string[]): CompiledElement {
  const compiled: CompiledElement = { id, kind, ancestors, zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
  if (ancestors.length > 0) compiled.parent = ancestors[ancestors.length - 1];
  return compiled;
}

function relation(id: string, from: string, to: string, refines?: string): CompiledRelation {
  const compiled: CompiledRelation = { id, name: `calls ${to}`, from, to, interaction: false, environments: ['*'], states: ['as-is'] };
  if (refines !== undefined) compiled.refines = refines;
  return compiled;
}

/**
 * 10 domains of 49 services, each with one module: 990 elements and 501
 * views (the landscape, the domains, the services). Each service calls a
 * service of the next domain, and its module refines that call.
 */
function wideModel(): CompiledModel {
  const elements: CompiledElement[] = [];
  const relations: CompiledRelation[] = [];
  for (let d = 0; d < 10; d++) {
    elements.push(element(`d${d}`, 'domain', []));
    for (let s = 0; s < 49; s++) {
      const service = `d${d}-s${s}`;
      const target = `d${(d + 1) % 10}-s${(s + 1) % 49}`;
      elements.push(element(service, 'service', [`d${d}`]));
      elements.push(element(`${service}-m`, 'module', [`d${d}`, service]));
      relations.push(relation(`${service}-calls`, service, target));
      relations.push(relation(`${service}-m-calls`, `${service}-m`, `${target}-m`, `${service}-calls`));
    }
  }
  return { schemaVersion: 1, elements, interfaces: [], relations, categories: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
}

describe('performance: every view of a 990-element model', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'is built and rendered as Mermaid pages in under ten seconds',
    () => {
      const model = wideModel();
      expect(model.elements.length).toBe(990);
      const history = createSqliteHistory({ clock: { now: () => AT } });
      expect(history.store({ source: 'wide', commit: 'v1', committedAt: AT, model }).errors).toEqual([]);
      const engine = createLadybugEngine();
      engine.rebuild(history.assertions());

      const started = performance.now();
      const { views, errors } = buildViewSet(engine, model, { valid: AT, known: AT });
      expect(errors).toEqual([]);
      const rendered = renderMermaidPages(views!);
      const elapsed = performance.now() - started;
      expect(rendered.errors).toEqual([]);
      expect(rendered.pages!.length).toBe(501);

      if (process.env['CI']) {
        // eslint-disable-next-line no-console
        console.log(`every view of 990 elements: ${Math.round(elapsed)}ms`);
      } else {
        expect(elapsed).toBeLessThan(10_000);
      }

      engine.close();
      history.close();
    },
    60_000,
  );
});
