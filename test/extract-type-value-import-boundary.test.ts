import { expect, test } from 'bun:test';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { symbolKey } from '../src/extract/code/keys.js';
import type { TreeReader } from '../src/extract/records.js';

function treeOf(files: Readonly<Record<string, string>>): TreeReader {
  return { paths: Object.keys(files).sort(), read(path) {
    const source = files[path];
    if (source === undefined) throw new Error(`missing fixture path ${path}`);
    return new TextEncoder().encode(source);
  } };
}

test('an ordinary interface import used as a constructor field type retains graph calls without a runtime export gap', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'src/store.ts': [
      'export interface Store { save(value: string): void }',
      'export class MemoryStore implements Store { save(value: string): void {} }',
      'export const used = 1;',
    ].join('\n'),
    'src/service.ts': [
      "import { Store, used } from './store';",
      'export class Service {',
      '  constructor(private readonly store: Store) {}',
      '  run(): void { this.store.save(String(used)); }',
      '}',
    ].join('\n'),
    'src/main.ts': [
      "import { Service } from './service';",
      "import { MemoryStore } from './store';",
      'const service = new Service(new MemoryStore());',
      'service.run();',
    ].join('\n'),
  }));
  expect(extraction.gaps).toEqual([]);
  const imported = facts.imports.find((entry) => entry.local === 'Store');
  expect(imported?.typeOnly).toBe(true);
  expect(imported?.targetExpression).toBeUndefined();
  expect(facts.bindings.some((entry) => entry.importId === imported?.id)).toBe(true);
  expect(facts.exports?.some((entry) => entry.name === 'Store')).toBe(false);
  expect(facts.sites.some((site) => site.use === 'type' && site.to === symbolKey('src/store.ts', 'Store') && site.span.path === 'src/service.ts')).toBe(true);
  const run = symbolKey('src/service.ts', 'Service.run');
  const calls = extraction.edges.filter((edge) => edge.type === 'code.calls' && edge.from === run);
  expect(calls.filter((edge) => edge.to === symbolKey('src/store.ts', 'Store.save'))).toHaveLength(1);
  const implementation = calls.filter((edge) => edge.to === symbolKey('src/store.ts', 'MemoryStore.save'));
  expect(implementation).toHaveLength(1);
  expect(implementation[0]?.properties['via']).toBe('interface');
  for (const local of ['used', 'Service', 'MemoryStore']) {
    const valueImport = facts.imports.find((entry) => entry.local === local);
    expect(valueImport?.typeOnly).toBeUndefined();
    expect(valueImport?.targetExpression).toBeDefined();
  }
});

test('explicit whole and inline type imports retain structural facts while mixed type/value names join only runtime exports', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'lib/types.ts': 'export interface Shape { size: number } export type Size = number;',
    'lib/state.ts': 'export const State = { ready: 1 }; export type State = typeof State[keyof typeof State];',
    'lib/use.ts': [
      'import type { Shape } from "./types";',
      'import { type Size } from "./types";',
      'import { Size as Count } from "./types";',
      'import { State } from "./state";',
      'export function read(shape: Shape, size: Size, count: Count, state: State) { return State.ready; }',
      'export function shadow(Count: unknown) { return Count; }',
    ].join('\n'),
  }));
  expect(extraction.gaps).toEqual([]);
  for (const name of ['Shape', 'Size', 'Count']) {
    const imported = facts.imports.find((entry) => entry.local === name);
    expect(imported?.typeOnly).toBe(true);
    expect(imported?.targetExpression).toBeUndefined();
    expect(facts.bindings.some((binding) => binding.importId === imported?.id)).toBe(true);
  }
  const state = facts.imports.find((entry) => entry.local === 'State');
  expect(state?.typeOnly).toBeUndefined();
  expect(state?.targetExpression).toBeDefined();
  expect(facts.exports?.filter((entry) => entry.path === 'lib/state.ts' && entry.name === 'State')).toHaveLength(1);
});

test('mixed runtime uses, typeof queries and unused imports cannot hide missing runtime exports', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'lib/types.ts': 'export interface Shape { size: number }',
    'lib/mixed.ts': 'import { Shape } from "./types"; export function read(shape: Shape) { return Shape; }',
    'lib/query.ts': 'import { Shape } from "./types"; export type Value = typeof Shape;',
    'lib/runtime-query.ts': 'import { Shape } from "./types"; export const kind = typeof Shape;',
    'lib/unused.ts': 'import { Shape } from "./types";',
  }));
  for (const path of ['lib/mixed.ts', 'lib/query.ts', 'lib/runtime-query.ts', 'lib/unused.ts']) {
    const imported = facts.imports.find((entry) => entry.path === path);
    expect(imported).toBeDefined();
    expect(imported?.typeOnly).toBeUndefined();
    expect(imported?.targetExpression).toBeUndefined();
    expect(extraction.gaps.some((gap) => gap.path === path && gap.reason.includes('internal import has no unique exported value'))).toBe(true);
  }
});

test('a runtime value query keeps its exact export proof even though its result is used as a type', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'lib/value.ts': 'export const Shape = { size: 1 };',
    'lib/query.ts': 'import { Shape } from "./value"; export type Value = typeof Shape;',
  }));
  expect(extraction.gaps).toEqual([]);
  const imported = facts.imports.find((entry) => entry.path === 'lib/query.ts');
  expect(imported?.typeOnly).toBeUndefined();
  expect(imported?.targetExpression).toBeDefined();
  expect(imported?.targetChain).toHaveLength(1);
});

test('an ordinary import of an interface whose name is used only in type positions needs no runtime export', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'services/payments/src/domain/payment.ts': [
      'export const PaymentStatus = { Pending: "pending", Captured: "captured" } as const;',
      'export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];',
      'export interface Payment { id: string; status: PaymentStatus }',
    ].join('\n'),
    'services/payments/src/store/payment-repository.ts': [
      "import { PrismaClient, Payment as PaymentRow } from '@prisma/client';",
      "import { Payment, PaymentStatus } from '../domain/payment';",
      'export interface PaymentRepository {',
      '  findById(id: string): Promise<Payment | undefined>;',
      '  save(payment: Payment): Promise<void>;',
      '}',
      'export function blank(id: string): Payment {',
      '  return { id, status: PaymentStatus.Pending };',
      '}',
      'export function toRow(row: PaymentRow): Payment {',
      '  return { id: row.id, status: PaymentStatus.Pending };',
      '}',
    ].join('\n'),
  }));
  expect(extraction.gaps).toEqual([]);
  const payment = facts.imports.find((entry) => entry.local === 'Payment');
  expect(payment?.typeOnly).toBe(true);
  expect(payment?.targetExpression).toBeUndefined();
  const status = facts.imports.find((entry) => entry.local === 'PaymentStatus');
  expect(status?.typeOnly).toBeUndefined();
  expect(status?.targetExpression).toBeDefined();
  // The erased interface keeps its graph sites and never becomes a value export.
  expect(facts.exports?.some((entry) => entry.name === 'Payment')).toBe(false);
  expect(facts.sites.some((site) => site.use === 'type' &&
    site.to === symbolKey('services/payments/src/domain/payment.ts', 'Payment') &&
    site.span.path === 'services/payments/src/store/payment-repository.ts')).toBe(true);
});

test('a value use of an interface-only import keeps the runtime export gap', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'lib/payment.ts': 'export interface Payment { id: string }',
    'lib/table.ts': 'import { Payment } from "./payment"; export const table = { Payment };',
  }));
  const imported = facts.imports.find((entry) => entry.local === 'Payment');
  expect(imported?.typeOnly).toBeUndefined();
  expect(imported?.targetExpression).toBeUndefined();
  expect(extraction.gaps.some((gap) => gap.path === 'lib/table.ts' &&
    gap.reason.includes('internal import has no unique exported value'))).toBe(true);
});

test('one import statement keeps the runtime join of a value specifier while its type-only neighbour erases', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'lib/shapes.ts': 'export interface Shape { size: number } export const UNIT = 1;',
    'lib/measure.ts': [
      'import { Shape, UNIT } from "./shapes";',
      'export function area(shape: Shape): number { return shape.size * UNIT; }',
    ].join('\n'),
  }));
  expect(extraction.gaps).toEqual([]);
  expect(facts.imports.find((entry) => entry.local === 'Shape')?.typeOnly).toBe(true);
  const unit = facts.imports.find((entry) => entry.local === 'UNIT');
  expect(unit?.typeOnly).toBeUndefined();
  expect(unit?.targetExpression).toBeDefined();
  expect(unit?.targetChain).toHaveLength(1);
});

test('the source name an aliased import reads is not a value use of another import of the same name', async () => {
  const { extraction, facts } = await extractCodeWithFacts(treeOf({
    'lib/rows.ts': 'export interface Payment { id: string }',
    'lib/db.ts': 'export interface Payment { id: string }',
    'lib/store.ts': [
      'import { Payment as PaymentRow } from "./db";',
      'import { Payment } from "./rows";',
      'export function load(row: PaymentRow): Payment { return { id: row.id }; }',
    ].join('\n'),
  }));
  // `Payment` on the first line names an export of ./db; it is not a use of the
  // local `Payment` the second line declares, so neither import needs a value.
  expect(extraction.gaps).toEqual([]);
  expect(facts.imports.find((entry) => entry.local === 'Payment')?.typeOnly).toBe(true);
  expect(facts.imports.find((entry) => entry.local === 'PaymentRow')?.typeOnly).toBe(true);
});
