/**
 * A refresh limited to one task's pages (madarch-m38l.14, «Поправить страницы
 * сейчас»): the plan the agent is given is exactly the impact the wiki showed
 * before the press — the product pages the task's grounds reach through the
 * graph, and no other page. Each brief carries the task, its grounds, and the
 * sentences of that page that stand on them, so the agent knows what to change
 * and where; a page the task does not reach has no unit at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { readKnowledgePages } from '../knowledge/index/index.js';
import type { ChangeNote, EditBrief } from '../writer/edit.js';
import { impactOf } from './impact.js';
import { impactGroundsOf } from './planned.js';
import type { RefreshPlan } from './plan.js';
import { readTasks, type PlannedTask } from './tasks.js';

export interface TaskRun {
  readonly task: PlannedTask;
  /** The plan the writer's card shows: the task's pages alone, each with the task as its reason. */
  readonly plan: RefreshPlan;
  readonly briefs: Map<string, EditBrief>;
}

/** A task-limited run that cannot be planned: it says which file or ground, and plans nothing. */
export class TaskRunRefusal extends Error {}

/** The plan and the briefs of the run that fixes one task's pages. */
export async function planTaskRun(input: { readonly owner: DatabaseOwner; readonly productFolder: string; readonly task: string }): Promise<TaskRun> {
  const read = readTasks(input.productFolder);
  const task = read.tasks.find((candidate) => candidate.slug === input.task || candidate.id === input.task || candidate.id === `task:${input.task}`);
  if (task === undefined) {
    const broken = read.findings.find((finding) => finding.file.endsWith(`/${input.task}.md`));
    throw new TaskRunRefusal(broken === undefined ? `docs/tasks/${input.task}.md:1: there is no task ${input.task} in the product repository` : broken.message);
  }
  if (task.status === 'closed') throw new TaskRunRefusal(`${task.file}:1: the task ${task.slug} is closed, so its pages are not written again`);
  const impact = await impactOf(input.owner, input.productFolder, impactGroundsOf(task));
  if (impact.writable.length === 0) {
    throw new TaskRunRefusal(`${task.file}:1: the task ${task.slug} reaches no page of the product the agent writes (${impact.pages.map((page) => page.file).join(', ') || 'no page at all'}); its grounds are ${impact.grounds.join(', ')}`);
  }
  const pages = readKnowledgePages(input.productFolder).pages;
  const idOf = (file: string): string => pages.find((page) => page.file === file)?.id ?? file;
  const statementsOf = (file: string): { name: string; sentence: string }[] =>
    impact.statements.filter((statement) => statement.file === file).map((statement) => ({ name: statement.statement, sentence: statement.text }));
  const briefs = new Map<string, EditBrief>();
  for (const file of impact.writable) {
    let current: string;
    try {
      current = readFileSync(join(input.productFolder, file), 'utf8');
    } catch (error) {
      throw new TaskRunRefusal(`${file}:1: the page cannot be read to be edited: ${(error as Error).message}`);
    }
    const note: ChangeNote = { kind: 'task', task: task.slug, title: task.title, grounds: [...task.grounds].sort(byCodePoint), statements: statementsOf(file) };
    briefs.set(file, { current, notes: [note], omitted: 0 });
  }
  const touched = new Set(impact.writable);
  const plan: RefreshPlan = {
    languageChanged: false,
    pages: impact.writable.map((file) => ({ id: idOf(file), path: file, reasons: [{ kind: 'task', task: task.slug, title: task.title }] })),
    unchanged: pages.map((page) => page.file).filter((file) => !touched.has(file)).sort(byCodePoint),
    unplaced: [],
    problems: [],
  };
  return { task, plan, briefs };
}
