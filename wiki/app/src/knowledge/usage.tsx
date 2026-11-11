import { Stack, Text, PageSection, SectionTitle, Paragraph } from '@/components/ui/typography.js';

/**
 * What the model calls cost (madarch-stm0.4, decision 0035, item 22): a kind's page says what the agent spent on it —
 * every run counted, the newest runs listed, one line per plugin run, field and model — and a run's page says what its
 * own trace recorded, one line per kind, field and model. Every number is the agent's own report; a model it did not
 * name, or a report it never gave, is said in words rather than drawn as a zero.
 */
import { useTranslation } from 'react-i18next';
import type { ReactElement } from 'react';
import { PageSkeleton } from './skeleton.js';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { getKindUsage } from './api.js';
import { useRead } from './live.js';
import type { AgentUsageReport, KindUsageView } from './types.js';

/** One token count as a reader's locale writes it. */
export function tokensText(tokens: number, language: string): string {
  return new Intl.NumberFormat(language).format(tokens);
}

/** One amount as the agent named it: its number and its unit (`0.42 USD`, `3 credits`). */
export function amountText(amount: { readonly amount: number; readonly currency: string }, language: string): string {
  const plain = Number(amount.amount.toFixed(6));
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(plain)} ${amount.currency}`;
}

/** Several amounts of different units, each on its own, in code point order of the unit. */
export function amountsText(amounts: readonly { readonly amount: number; readonly currency: string }[], language: string): string {
  return [...amounts].sort((left, right) => (left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0))
    .map((amount) => amountText(amount, language)).join(', ');
}

/** A kind's agent spend, as its page states it; nothing at all when no model call filled the kind yet. */
export function KindUsage({ kind, version }: { kind: string; version: number }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const read = useRead<{ usage: KindUsageView }>(`kind-usage\0${kind}`, version, (signal) => getKindUsage(kind, signal));
  if (read.data === null && read.error === null) return <PageSkeleton testId="kind-usage-loading" rows />;
  if (read.data === null) return <Alert variant="problem" data-testid="kind-usage-error"><AlertDescription><Paragraph>{read.error ?? ''}</Paragraph></AlertDescription></Alert>;
  const usage = read.data.usage;
  // A kind no model call filled pays no section: the page says what is there, never an empty table.
  if (usage.runs.length === 0) return null;
  return (
    <PageSection className="mb-8" data-testid="kind-usage" data-kind={usage.kind}>
      <SectionTitle className="mb-2 mt-0">{t('knowledge.usage.title')}</SectionTitle>
      <Paragraph className="mb-3 text-small text-muted" data-testid="kind-usage-total">
        {t('knowledge.usage.total', {
          runs: usage.total.runs,
          tokens: tokensText(usage.total.totalTokens, language),
          input: tokensText(usage.total.inputTokens, language),
          output: tokensText(usage.total.outputTokens, language),
          cost: usage.total.cost.length === 0 ? '' : t('knowledge.usage.costPart', { cost: amountsText(usage.total.cost, language) }),
        })}
      </Paragraph>
      <Stack className="table-wrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('knowledge.usage.colRun')}</TableHead>
              <TableHead>{t('knowledge.usage.colPlugin')}</TableHead>
              <TableHead>{t('knowledge.usage.colField')}</TableHead>
              <TableHead>{t('knowledge.usage.colModel')}</TableHead>
              <TableHead className="text-end">{t('knowledge.usage.colTokens')}</TableHead>
              <TableHead className="text-end">{t('knowledge.usage.colCost')}</TableHead>
              <TableHead>{t('knowledge.usage.colState')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.runs.flatMap((run) => run.rows.map((row) => (
              <TableRow key={`${row.run}\0${row.unit}\0${row.kind}\0${row.field}\0${row.model ?? ''}`} data-testid="kind-usage-row" data-run={row.run} data-model={row.model ?? ''}>
                <TableCell className="whitespace-nowrap"><code title={row.run}>{runLabel(row.run)}</code></TableCell>
                <TableCell><code>{row.plugin}</code></TableCell>
                <TableCell>{row.field === '' ? <Text className="text-muted">{t('knowledge.usage.wholeKind')}</Text> : <code>{row.field}</code>}</TableCell>
                <TableCell>{row.model === null ? <Text className="text-muted">{t('knowledge.usage.noModel')}</Text> : <code>{row.model}</code>}</TableCell>
                <TableCell className="text-end whitespace-nowrap">
                  {row.reported === false
                    ? <Text className="text-muted">{t('knowledge.usage.noTokens')}</Text>
                    : t('knowledge.usage.tokens', { input: tokensText(row.inputTokens, language), output: tokensText(row.outputTokens, language), total: tokensText(row.totalTokens, language) })}
                </TableCell>
                <TableCell className="text-end whitespace-nowrap">{row.cost === null ? <Text className="text-muted">–</Text> : amountText(row.cost, language)}</TableCell>
                <TableCell>
                  {row.stopped === null
                    ? <Text className="text-small text-muted">{t('knowledge.usage.turns', { turns: row.turns })}</Text>
                    : <Badge data-testid="kind-usage-stop" variant="solid">{t('knowledge.usage.stop', { bound: row.stopped })}</Badge>}
                </TableCell>
              </TableRow>
            )))}
          </TableBody>
        </Table>
      </Stack>
      {usage.moreRuns && <Paragraph className="mb-0 mt-2 text-small text-muted" data-testid="kind-usage-more">{t('knowledge.usage.moreRuns')}</Paragraph>}
    </PageSection>
  );
}

/** A run's id as the table shows it: the fill's own naming is long, and the title keeps the whole. */
function runLabel(run: string): string {
  return run.length <= 28 ? run : `${run.slice(0, 25)}…`;
}

/** What one run's model calls cost, as the run's own trace recorded them; nothing for a run that made none. */
export function RunAgentUsage({ usage }: { usage: AgentUsageReport }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  if (usage.lines.length === 0) return null;
  return (
    <PageSection data-testid="run-usage">
      <SectionTitle className="mb-2 mt-0">{t('knowledge.usage.title')}</SectionTitle>
      <Paragraph className="mb-3 text-small text-muted" data-testid="run-usage-total">
        {t('knowledge.usage.runTotal', {
          turns: usage.turns,
          tokens: tokensText(usage.totalTokens, language),
          input: tokensText(usage.inputTokens, language),
          output: tokensText(usage.outputTokens, language),
          cost: usage.cost.length === 0 ? '' : t('knowledge.usage.costPart', { cost: amountsText(usage.cost, language) }),
        })}
      </Paragraph>
      <Stack className="table-wrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('knowledge.usage.colPlugin')}</TableHead>
              <TableHead>{t('knowledge.usage.colField')}</TableHead>
              <TableHead>{t('knowledge.usage.colModel')}</TableHead>
              <TableHead className="text-end">{t('knowledge.usage.colTokens')}</TableHead>
              <TableHead className="text-end">{t('knowledge.usage.colCost')}</TableHead>
              <TableHead>{t('knowledge.usage.colState')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.lines.map((line) => (
              <TableRow key={`${line.kind}\0${line.field}\0${line.model}`} data-testid="run-usage-row">
                <TableCell><code>{line.plugin}</code> <Text className="text-small text-muted">{line.kind}</Text></TableCell>
                <TableCell>{line.field === '' ? <Text className="text-muted">{t('knowledge.usage.wholeKind')}</Text> : <code>{line.field}</code>}</TableCell>
                <TableCell>{line.model === '' ? <Text className="text-muted">{t('knowledge.usage.noModel')}</Text> : <code>{line.model}</code>}</TableCell>
                <TableCell className="text-end whitespace-nowrap">{t('knowledge.usage.tokens', { input: tokensText(line.inputTokens, language), output: tokensText(line.outputTokens, language), total: tokensText(line.totalTokens, language) })}</TableCell>
                <TableCell className="text-end whitespace-nowrap">{line.cost.length === 0 ? <Text className="text-muted">–</Text> : amountsText(line.cost, language)}</TableCell>
                <TableCell>{line.stopped === null ? <Text className="text-small text-muted">{t('knowledge.usage.turns', { turns: line.turns })}</Text> : <Badge data-testid="run-usage-stop" variant="solid">{t('knowledge.usage.stop', { bound: line.stopped.bound })}</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Stack>
    </PageSection>
  );
}
