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

export function HomeOverviewFacts({ overview, legacyAudience }: {
  /** Fixture/view projection only; this is not the production API until the server work lands. */
  overview?: HomeOverviewProjection;
  legacyAudience?: string;
}): ReactElement {
  const { t } = useTranslation();
  const audience = presentText(overview?.audience) ?? presentText(legacyAudience);
  const problem = presentText(overview?.problem);
  const outcome = presentText(overview?.outcome);
  const milestone = overview?.currentMilestone;
  const milestoneTitle = presentText(milestone?.title);
  const milestonePath = presentText(milestone?.path);
  const milestoneState = presentText(milestone?.state);
  const nextStep = presentText(milestone?.nextStep);
  const missing = t('home.notDeclared');
  return (
    <section className="home-overview-facts" aria-label={t('home.overviewFacts')} data-testid="home-overview-facts">
      <dl className="grid gap-4">
        <div data-testid="home-audience">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.audienceLabel')}</dt>
          <dd className={audience === undefined ? 'home-audience home-audience-empty mt-1' : 'home-audience mt-1'}>
            {audience ?? t('home.noAudience')}
          </dd>
        </div>
        <div data-testid="home-problem">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.problemLabel')}</dt>
          <dd className="mt-1 text-secondary">{problem ?? missing}</dd>
        </div>
        <div data-testid="home-outcome">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.outcomeLabel')}</dt>
          <dd className="mt-1 text-secondary">{outcome ?? missing}</dd>
        </div>
        <div data-testid="home-milestone">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t('home.currentMilestoneLabel')}</dt>
          <dd className="mt-1">
            {milestonePath === undefined || milestoneTitle === undefined
              ? (milestoneTitle ?? missing)
              : <PageLink path={milestonePath}>{milestoneTitle}</PageLink>}
          </dd>
          <dd className="mt-1 text-secondary" data-testid="home-milestone-state">
            {t('home.milestoneState', { state: milestoneState ?? missing })}
          </dd>
          <dd className="mt-1 text-secondary" data-testid="home-next-step">
            {t('home.nextStep', { step: nextStep ?? missing })}
          </dd>
        </div>
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
