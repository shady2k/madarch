/** Declared graph aggregates, with their complete ground; no interpretation or stored opinion. */
import type { FactDecl } from '../product/manifest/kinds.js';
import type { RenderContext } from './blocks.js';
import type { GraphEntity } from './graph-read.js';
import type { StatementModel } from './model.js';
import { byCodePoint } from '../model/order.js';
import { kindAddress } from './addresses.js';

export interface FactGround {
  kind: string;
  measure: FactDecl['measure'];
  field?: string;
  buckets?: readonly number[];
  limit?: number;
  total: number;
  missing: number;
  entities: string[];
  computedAt: string;
  value: number | null;
  rows: { label: string; value: number; entity?: string }[];
}
export interface FactStatement {
  id: string;
  label: string;
  display: FactDecl['display'];
  measure: FactDecl['measure'];
  value: number | null;
  rows: { label: string; value: number; entity?: string }[];
  ground: FactGround;
  statement: StatementModel;
}
export interface FactsView {
  role: string;
  kinds: { kind: string; label: string; statements: FactStatement[] }[];
}

function aggregate(entities: readonly GraphEntity[], fact: FactDecl, now: Date, language: string): Pick<FactStatement, 'value' | 'rows'> & { missing: number } {
  if (fact.measure === 'count') return { value: entities.length, rows: [], missing: 0 };
  let missing = 0;
  const values: { entity: GraphEntity; value: string | number | boolean }[] = [];
  for (const entity of entities) {
    const value = entity.properties[fact.field!];
    const valid = fact.measure === 'group-by' ? ['string', 'number', 'boolean'].includes(typeof value)
      : fact.measure === 'top-n' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime();
    if (!valid) missing++;
    else values.push({ entity, value: value as string | number | boolean });
  }
  if (fact.measure === 'top-n') return { value: null, missing, rows: values.sort((a, b) => Number(b.value) - Number(a.value) || byCodePoint(a.entity.key, b.entity.key)).slice(0, fact.limit).map(({ entity, value }) => ({ label: entity.label, value: Number(value), entity: entity.key })) };
  const groups = new Map<string, number>();
  if (fact.measure === 'histogram') {
    const buckets = fact.buckets!;
    const unit = language === 'ru' ? 'дн.' : 'days';
    const labels = buckets.map((upper, i) => `${i === 0 ? 0 : buckets[i - 1]}–${upper} ${unit}`);
    labels.push(`${buckets[buckets.length - 1]}+ ${unit}`);
    for (const label of labels) groups.set(label, 0);
    for (const { value } of values) {
      const days = (now.getTime() - Date.parse(String(value))) / 86400000;
      const at = buckets.findIndex((upper) => days < upper);
      const label = labels[at < 0 ? buckets.length : at]!;
      groups.set(label, groups.get(label)! + 1);
    }
  } else {
    for (const { value } of values) groups.set(String(value), (groups.get(String(value)) ?? 0) + 1);
  }
  const rows = [...groups].map(([label, value]) => ({ label, value }));
  if (fact.measure === 'group-by') rows.sort((a, b) => b.value - a.value || byCodePoint(a.label, b.label));
  return { value: null, rows, missing };
}

/** Every page is read; no listing limit silently reduces an aggregate's population. */
export async function buildFacts(ctx: RenderContext, role: string, language = 'en', now = new Date()): Promise<FactsView> {
  const kinds: FactsView['kinds'] = [];
  for (const kind of ctx.manifest.kinds.values()) {
    const facts = (kind.facts ?? []).filter((fact) => role === 'everything' || (fact.audience ?? kind.audience ?? []).includes(role));
    if (facts.length === 0) continue;
    const entities: GraphEntity[] = [];
    let after: string | undefined;
    do {
      const page = await ctx.graph.list(kind.name, { limit: 500, ...(after === undefined ? {} : { after }) });
      entities.push(...page.rows);
      if (page.next !== null && (page.next === after || page.rows.length === 0)) throw new Error(`${ctx.manifest.file}:${kind.line}: aggregate pagination made no progress for ${kind.name}`);
      after = page.next ?? undefined;
    } while (after !== undefined);
    const label = kind.labels?.[language]?.many ?? kind.labels?.['en']?.many ?? kind.name;
    const statements = facts.map((fact): FactStatement => {
      const result = aggregate(entities, fact, now, language);
      const label = fact.labels[language] ?? fact.labels['en']!;
      const ground: FactGround = { kind: kind.name, measure: fact.measure, ...(fact.field === undefined ? {} : { field: fact.field }), ...(fact.buckets === undefined ? {} : { buckets: fact.buckets }), ...(fact.limit === undefined ? {} : { limit: fact.limit }), total: entities.length, missing: result.missing, entities: entities.map((entity) => entity.key).sort(byCodePoint), computedAt: now.toISOString(), value: result.value, rows: result.rows };
      const id = `fact:${kind.name}/${fact.id}`;
      const statement: StatementModel = { page: { id, kind: kind.name, label, href: kindAddress(kind.name) }, name: fact.id, sentence: label, paragraph: result.value === null ? `${label}: ${result.rows.map((row) => `${row.label}: ${row.value}`).join('; ')}` : `${label}: ${result.value}`, file: ctx.manifest.kindFiles?.get(kind.name) ?? ctx.manifest.file, line: kind.line, grounded: true, grounds: [{ url: kindAddress(kind.name), resolution: { state: 'ok', target: kind.name, kind: kind.name, label, href: kindAddress(kind.name) }, excerpt: null }], aggregate: ground, relying: [], resolutions: {} };
      return { id, label, display: fact.display, measure: fact.measure, value: result.value, rows: result.rows, ground, statement };
    });
    kinds.push({ kind: kind.name, label, statements });
  }
  return { role, kinds };
}
