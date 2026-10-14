/**
 * The product facts shown before the wiki's document groups. The view model
 * holds already-resolved, registry-selected values; the reader never
 * interprets product Markdown or assigns meaning to a heading itself.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegistryOffer } from './api.js';
import { PageLink } from './view.js';

export type HomeOverviewProjection = {
  audience?: string;
  problem?: string;
  outcome?: string;
  currentMilestone?: { title?: string; state?: string; nextStep?: string; path?: string };
};

function presentText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function safeProductPagePath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
    !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function HomeOverviewFacts({ overview, legacyAudience, pagePaths }: {
  /** The optional projection supplied by the production /api/product response. */
  overview?: HomeOverviewProjection;
  legacyAudience?: string;
  /** Page paths currently held by the wiki; overview links must name one of these. */
  pagePaths: readonly string[];
}): ReactElement | null {
  const { t } = useTranslation();
  const audience = presentText(overview?.audience) ?? presentText(legacyAudience);
  const problem = presentText(overview?.problem);
  const outcome = presentText(overview?.outcome);
  const milestone = overview?.currentMilestone;
  const milestoneTitle = presentText(milestone?.title);
  const proposedMilestonePath = presentText(milestone?.path);
  const milestonePath = proposedMilestonePath !== undefined && safeProductPagePath(proposedMilestonePath) && pagePaths.includes(proposedMilestonePath)
    ? proposedMilestonePath
    : undefined;
  const milestoneState = presentText(milestone?.state);
  const nextStep = presentText(milestone?.nextStep);
  if (audience === undefined && problem === undefined && outcome === undefined &&
    milestoneTitle === undefined && milestoneState === undefined && nextStep === undefined) return null;
  return (
    <section className="home-overview-facts" aria-label={t('home.overviewFacts')} data-testid="home-overview-facts">
      <dl className="grid gap-4">
        {audience === undefined ? null : (
          <div data-testid="home-audience">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.audienceLabel')}</dt>
            <dd className="home-audience mt-1">{audience}</dd>
          </div>
        )}
        {problem === undefined ? null : (
          <div data-testid="home-problem">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.problemLabel')}</dt>
            <dd className="mt-1 text-secondary">{problem}</dd>
          </div>
        )}
        {outcome === undefined ? null : (
          <div data-testid="home-outcome">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.outcomeLabel')}</dt>
            <dd className="mt-1 text-secondary">{outcome}</dd>
          </div>
        )}
        {milestoneTitle === undefined && milestoneState === undefined && nextStep === undefined ? null : (
          <div data-testid="home-milestone">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.currentMilestoneLabel')}</dt>
            {milestoneTitle === undefined ? null : (
              <dd className="mt-1">
                {milestonePath === undefined
                  ? milestoneTitle
                  : <PageLink path={milestonePath}>{milestoneTitle}</PageLink>}
              </dd>
            )}
            {milestoneState === undefined ? null : (
              <dd className="mt-1 text-secondary" data-testid="home-milestone-state">
                {t('home.milestoneState', { state: milestoneState })}
              </dd>
            )}
            {nextStep === undefined ? null : (
              <dd className="mt-1 text-secondary" data-testid="home-next-step">
                {t('home.nextStep', { step: nextStep })}
              </dd>
            )}
          </div>
        )}
      </dl>
    </section>
  );
}

/** Selects the active-locale manifest label when nonblank, otherwise preserving the manifest name unchanged. */
export function registryDisplayLabel(offer: RegistryOffer | null | undefined, canonicalName: string, locale: 'en' | 'ru'): string | undefined {
  if (offer === undefined || offer === null || !offer.present || 'refused' in offer) return undefined;
  const kind = offer.kinds.find((candidate) => candidate.name === canonicalName);
  return kind === undefined ? undefined : presentText(kind.labels?.[locale]) ?? kind.name;
}

/** Resolves a stage from the registry only: active-locale label, exact name, then identity. */
export function registryStageDisplayLabel(offer: RegistryOffer | null | undefined, stageId: string, locale: 'en' | 'ru'): string | undefined {
  if (offer === undefined || offer === null || !offer.present || 'refused' in offer) return undefined;
  const stage = offer.stages.find((candidate) => candidate.id === stageId);
  return stage === undefined ? undefined : presentText(stage.labels?.[locale]) ?? stage.name ?? stage.id;
}
