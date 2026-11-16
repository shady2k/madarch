/** Closed HTTP command envelopes. Validation happens before a command can change state. */
import { z } from 'zod';
import { MAX_EDITORIAL_REQUESTS } from '../writer/editorial.js';

const text = z.string().trim().min(1);
const choice = z.string().nullable().optional();
const language = z.enum(['en', 'ru']);
const plan = z.strictObject({ store: z.array(z.string()), agentPages: z.array(z.string()), keptPages: z.array(z.string()), unansweredQuestions: z.array(z.string()), keptAnswers: z.array(z.string()) });
const selection = z.strictObject({ selected: z.array(text), agent: choice, model: choice, reasoning: choice, tokenCap: z.int().min(1).nullable().optional(), pluginsOnly: z.boolean().optional() });
const id = z.strictObject({ id: text });
export const commandRequests: Readonly<Record<string, z.ZodType>> = {
  'start the fill': z.strictObject({ agent: choice, language: language.optional() }),
  'plan the fill': selection,
  'fill the selected entities': selection,
  'pause the fill': z.strictObject({}),
  'stop the fill': z.strictObject({ confirm: z.boolean().optional() }),
  'choose the agent': z.strictObject({ agent: z.string().nullable(), install: z.boolean().optional() }),
  'read the settings': z.strictObject({ role: text }),
  'start over': z.strictObject({ preview: plan.optional() }),
  'save the answer': z.strictObject({ question: text, text: z.string() }),
  'save the correction': z.strictObject({ statement: text, reason: z.string() }),
  'record that a problem is not one': z.strictObject({ id: text, reason: z.string() }),
  'create a task from a problem': id,
  'read the product settings': z.strictObject({ language: language.optional(), model: choice, reasoning: choice, editorialRequestsPerPage: z.int().min(0).max(MAX_EDITORIAL_REQUESTS).optional(), tokenCap: z.int().min(1).optional() }),
  'assign the model role': z.strictObject({ role: text, agent: z.string().nullable(), model: choice, reasoning: choice, install: z.boolean().optional() }),
  'read the graph verdicts': z.strictObject({ itemsPerRun: z.int().min(0), modelCallsPerRun: z.int().min(0) }),
  'rewrite the pages': z.strictObject({}),
  'start from scratch': z.strictObject({ preview: plan.optional() }),
  'propose the task of an answer': z.strictObject({ question: text, choice: z.enum(['code', 'docs']), language: language.optional() }),
  'close a task by hand': id,
  'fix the pages of a task now': id,
};

const run = text;
const flag = z.literal('1');
const unsigned = z.string().refine(value => value !== '' && (value === '0' || !value.startsWith('0')) && [...value].every(char => char >= '0' && char <= '9'), 'unsigned integer');
export const queryRequests: Readonly<Record<string, z.ZodType>> = {
  'render a diagram': z.strictObject({ entity: text, format: z.enum(['likec4', 'mermaid', 'archify']), depth: z.literal('1').optional(), aggregateAbove: unsigned.refine(value => value !== '0', 'positive integer').optional(), lang: text.optional() }),
  "read the kind's agent spend": z.strictObject({ kind: text }),
  'read the source': z.strictObject({ path: text, repo: text.optional(), at: text.optional() }),
  'read the run': z.strictObject({ run: run.optional() }),
  'read fill history': z.strictObject({ run: run.optional() }),
  'list the problems': z.strictObject({ count: flag.optional() }),
  'pause the fill': z.strictObject({ run: run.optional() }),
  'stop the fill': z.strictObject({ run: run.optional() }),
  'plan the refresh': z.strictObject({ language: language.optional() }),
  'ask the agent for its models': z.strictObject({ agent: text.optional(), fresh: flag.optional() }),
  'read the graph verdicts': z.strictObject({ peek: flag.optional(), force: flag.optional(), verdict: z.enum(['valid', 'invalid', 'unreviewed', 'non-valid']).optional(), role: z.enum(['node', 'edge']).optional(), kind: text.optional(), limit: unsigned.optional(), offset: unsigned.optional() }),
  'read the agent journal': z.strictObject({ id: text, run: z.string().refine(value => value.startsWith('run-') && value.length > 4 && [...value.slice(4)].every(char => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'.includes(char)), 'run id').optional() }),
};
