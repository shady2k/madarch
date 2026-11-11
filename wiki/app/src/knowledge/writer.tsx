/** The agent stage status on product pages, with links to the fill page for choices and retry. */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent } from '@/components/ui/card.js';
import { KLink } from './blocks.js';
import { kindNameOf } from './kind-names.js';
import { WIKI_FILL } from './routes.js';
import { runIsPaused, runIsStopped } from './run-controls.js';
import { FailureNote } from './errors.js';
import type { AgentOffer, WikiStatus, WriterUnit } from './types.js';

/**
 * The sentence under an agent's name: what is installed, its version and where, or plainly what madarch does not know.
 * A bundled program is never described with a package, a version or a folder madarch would install it into.
 */
export function agentOfferNote(t: (key: string, options?: Record<string, unknown>) => string, agent: AgentOffer): string {
  if (agent.installed) {
    if (agent.where === null) return t('knowledge.writer.installed');
    return agent.version === null
      ? t('knowledge.writer.installedUnknownVersion', { where: agent.where })
      : t('knowledge.writer.installedAt', { where: agent.where, version: agent.version });
  }
  const install = agent.install;
  if (install === null) return t('knowledge.writer.installUnknown', { agent: agent.label });
  if (install.kind === 'bundled') return t('knowledge.writer.notInstalledBundled', { program: install.program });
  return t('knowledge.writer.notInstalled', { package: install.package, version: install.version, size: install.size, folder: install.folder });
}

export const UNIT_STATE_KEY: Record<WriterUnit['state'], string> = {
  waiting: 'knowledge.writer.unitWaiting',
  writing: 'knowledge.writer.unitWriting',
  written: 'knowledge.writer.unitWritten',
  failed: 'knowledge.writer.unitFailed',
  'not-written': 'knowledge.writer.unitNotWritten',
};

/**
 * What a reader calls the page a unit writes: the kind's name the manifest declares and the page's own title, so «Термин
 * Capture» and never the writer's word for its work (madarch-m38l.23). A page whose kind or title the status could not
 * resolve is named by what it is known by.
 */
export function unitName(unit: WriterUnit, kinds: WikiStatus['kinds'], language: string): string {
  if (unit.title === undefined) return unit.unit;
  return unit.kind === undefined ? unit.title : `${kindNameOf(kinds, unit.kind, 'one', language)} ${unit.title}`;
}

/**
 * The agent stage on the pages of the product, in one line while it runs: who writes the pages, how far it is, and the way
 * to the fill page, where every page it takes up stands with its state and its journal (madarch-m38l.23). A failed run keeps
 * its reason and its two buttons here; a finished one is only the top bar's status.
 */
export function WriterLine({ status }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const writer = status.writer;
  const dismissKey = `${status.product.id}:${writer.finishedAt ?? ''}`;
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return window.sessionStorage.getItem('madarch-writer-dismissed'); } catch { return null; } });
  // A run a person paused or stopped says so where the run is never shown: the popover in the top bar and the fill page
  // carry its words and its presses (madarch-m38l.17), and this line would repeat them over every page of the product.
  if (writer.agent === null || writer.state === 'idle' || writer.state === 'done' || runIsPaused(status) || runIsStopped(status)) return null;
  if (writer.state === 'failed' && dismissed === dismissKey) return null;
  const agent = writer.agent.label;
  const written = writer.units.filter((unit) => unit.state === 'written').length;
  // How many pages the run means to write, as the writer counted them: not the pages it has merely taken up, which
  // would make «1 из 2» look nearly done at the very start. Until the count comes, the line says only the count.
  const total = writer.total;
  const open = <KLink href={WIKI_FILL} className="text-small" testId="writer-line-open">{t('knowledge.fillPage.open')}</KLink>;
  if (writer.state === 'failed') {
    return (
      <Alert variant="problem" className="mb-8" data-testid="writer-line" data-state="failed">
        <AlertTitle>{t('knowledge.writer.failedTitle', { agent })}</AlertTitle>
        <AlertDescription>
          {writer.message !== undefined && <div data-testid="writer-message"><FailureNote scope="writer" code={writer.code} message={writer.message} /></div>}
          <p className="mb-0 mt-2">{open}</p>
          <p className="mb-0 mt-3">
            <KLink href={WIKI_FILL} testId="writer-retry">{t('knowledge.writer.retry')}</KLink>
            {' '}
            <Button variant="default" size="default" data-testid="writer-dismiss" onClick={() => { try { window.sessionStorage.setItem('madarch-writer-dismissed', dismissKey); } catch { /* the dismissal lasts until the page is read again */ } setDismissed(dismissKey); }}>{t('knowledge.writer.dismiss')}</Button>
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  const language = i18n.resolvedLanguage ?? 'en';
  const current = writer.units.find((unit) => unit.unit === writer.current) ?? writer.units.find((unit) => unit.state === 'writing');
  const name = current === undefined ? null : unitName(current, status.kinds, language);
  const words = writer.state === 'waiting'
    ? t('knowledge.writer.lineWaiting', { agent })
    : total === undefined
      ? name === null ? t('knowledge.writer.lineWritingCountShort', { agent, done: written }) : t('knowledge.writer.lineWritingCount', { agent, done: written, name })
      : name === null ? t('knowledge.writer.lineWritingShort', { agent, done: written, total }) : t('knowledge.writer.lineWriting', { agent, done: written, total, name });
  return (
    <Card className="mb-8" data-testid="writer-line" data-state={writer.state}>
      <CardContent className="pt-6">
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
          <span className="text-ink" data-testid="writer-line-words">{words}</span>
          {open}
        </p>
      </CardContent>
    </Card>
  );
}
