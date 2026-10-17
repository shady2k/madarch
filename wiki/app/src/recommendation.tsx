/** The reader-facing next-step link, shown on the home and every document page. */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { NextStepRecommendation, RegistryOffer } from './api.js';
import { PageLink } from './view.js';
import { addressOfGroup } from './routes.js';

function addressForTarget(target: string, pagePaths: readonly string[], offer?: RegistryOffer | null): { path?: string; href?: string } {
  if (pagePaths.includes(target)) return { path: target };
  if (target === '/') return { href: '/' };
  const kind = offer?.present && !('refused' in offer) ? offer.kinds.find((entry) => entry.folder === target) : undefined;
  return { href: kind === undefined ? '/' : addressOfGroup(kind.name) };
}

export function NextStep({ recommendation, pagePaths = [], offer }: { recommendation?: NextStepRecommendation; pagePaths?: readonly string[]; offer?: RegistryOffer | null }): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (recommendation === undefined) return null;
  const target = addressForTarget(recommendation.target, pagePaths, offer);
  const title = recommendation.action.startsWith('Answer: ') ? recommendation.action.slice('Answer: '.length) : '';
  const canonicalKind = recommendation.action.startsWith('Add ') ? recommendation.action.slice('Add '.length) : '';
  const declaredKind = offer?.present && !('refused' in offer) ? offer.kinds.find((entry) => entry.name === canonicalKind) : undefined;
  const kind = declaredKind?.labels?.[i18n.resolvedLanguage?.startsWith('ru') ? 'ru' : 'en'] ?? canonicalKind;
  const action = recommendation.rule === 'answer-question' ? t('nextStep.answerAction', { title })
    : recommendation.rule === 'review-assumption' ? t('nextStep.reviewAssumptionAction')
      : recommendation.rule === 'fill-required' ? (kind ? t('nextStep.fillKindAction', { kind }) : t('nextStep.fillLinkAction'))
        : recommendation.rule === 'inspect-update' ? t('nextStep.genericAction') : recommendation.action;
  const reason = recommendation.rule === 'answer-question' ? t('nextStep.answerReason')
    : recommendation.rule === 'review-assumption' ? t('nextStep.reviewAssumptionReason')
      : recommendation.rule === 'fill-required' ? (kind ? t('nextStep.fillKindReason', { kind }) : t('nextStep.fillLinkReason'))
        : recommendation.rule === 'inspect-update' ? t('nextStep.genericReason') : recommendation.reason;
  return (
    <section className="next-step" data-testid="next-step" data-rule={recommendation.rule} aria-label={t('nextStep.title')}>
      <p className="next-step-label">{t('nextStep.title')}</p>
      <p className="next-step-action">{action}</p>
      <p className="next-step-reason">{reason}</p>
      {target.path !== undefined
        ? <PageLink path={target.path} className="next-step-link">{t('nextStep.openTarget')}</PageLink>
        : <a className="next-step-link" href={target.href ?? '/'}>{t('nextStep.openTarget')}</a>}
    </section>
  );
}
