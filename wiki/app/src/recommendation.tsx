/** The reader-facing next-step link, shown on the home and every document page. */
import type { ReactElement } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { NextStepRecommendation, RegistryOffer } from './api.js';
import { PageLink } from './view.js';
import { addressOfGroup, addressOfStageRoute } from './routes.js';
import { appPath } from './app-base.js';
import { navigateTo } from './hold.js';

/** The offer's kind a recommendation names, when the registry is served. */
function declaredKind(recommendation: NextStepRecommendation, offer?: RegistryOffer | null) {
  if (recommendation.kindName === undefined) return undefined;
  return offer?.present && !('refused' in offer) ? offer.kinds.find((entry) => entry.name === recommendation.kindName) : undefined;
}

/** Where the recommendation's target opens: a held page, the kind's group or stage, else the home. */
function addressForTarget(target: string, pagePaths: readonly string[], recommendation: NextStepRecommendation, offer?: RegistryOffer | null): { path?: string; href?: string } {
  if (pagePaths.includes(target)) return { path: target };
  const kind = recommendation.kindName !== undefined && offer?.present && !('refused' in offer)
    ? offer.kinds.find((entry) => entry.name === recommendation.kindName)
    : undefined;
  if (kind !== undefined) {
    // A kind the registry requires but the product holds no page of has no
    // group to open: the stage route shows where the kind is expected.
    return recommendation.rule === 'fill-required'
      ? { href: addressOfStageRoute(kind.stage) }
      : { href: addressOfGroup(kind.name) };
  }
  return { href: '/' };
}

/** A link to one of the app's own addresses, opened on the client side without a reload. */
function AppLink({ href, className, children }: { href: string; className?: string; children: string }): ReactElement {
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(appPath(href));
  };
  return <a href={appPath(href)} className={className} onClick={follow}>{children}</a>;
}

export function NextStep({ recommendation, pagePaths = [], offer, currentPath }: { recommendation?: NextStepRecommendation; pagePaths?: readonly string[]; offer?: RegistryOffer | null; currentPath?: string }): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (recommendation === undefined) return null;
  const kind = declaredKind(recommendation, offer);
  const kindLabel = kind?.labels?.[i18n.resolvedLanguage?.startsWith('ru') ? 'ru' : 'en'] ?? recommendation.kindName;
  const target = addressForTarget(recommendation.target, pagePaths, recommendation, offer);
  const action = recommendation.rule === 'answer-question'
    ? t('nextStep.answerAction', { title: recommendation.questionTitle ?? '' })
    : recommendation.rule === 'fill-required' && kindLabel !== undefined
      ? t('nextStep.fillKindAction', { kind: kindLabel })
      : recommendation.action;
  const reason = recommendation.rule === 'answer-question' ? t('nextStep.answerReason')
    : recommendation.rule === 'review-assumption'
      ? (recommendation.target === currentPath ? t('nextStep.reviewAssumptionReason') : t('nextStep.reviewAssumptionPageReason', { page: recommendation.target }))
      : recommendation.rule === 'fill-required'
        ? (kindLabel !== undefined ? t('nextStep.fillKindReason', { kind: kindLabel }) : t('nextStep.fillLinkReason', { detail: recommendation.reason }))
        : recommendation.rule === 'registry-hint' ? t('nextStep.hintReason')
          : recommendation.rule === 'inspect-update' ? t('nextStep.genericReason') : recommendation.reason;
  return (
    <section className="next-step" data-testid="next-step" data-rule={recommendation.rule} aria-label={t('nextStep.title')}>
      <p className="next-step-label">{t('nextStep.title')}</p>
      <p className="next-step-action">{action}</p>
      <p className="next-step-reason">{reason}</p>
      {target.path !== undefined
        ? <PageLink path={target.path} className="next-step-link">{t('nextStep.openTarget')}</PageLink>
        : <AppLink href={target.href ?? '/'} className="next-step-link">{t('nextStep.openTarget')}</AppLink>}
    </section>
  );
}
