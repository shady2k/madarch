/**
 * What a page shows while its data loads: a title bar and bars of text, or the
 * rows of a list, where the page will be (never a blank and never a bare
 * "Loading"). The region says it is busy for assistive technology.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton.js';

export function PageSkeleton({ testId, rows = false }: { testId: string; rows?: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" aria-label={t('knowledge.loading')} data-testid={testId} className="page-skeleton">
      {!rows && <Skeleton className="mb-3 h-3 w-24" />}
      {!rows && <Skeleton className="mb-6 h-9 w-2/3 max-w-[28rem]" />}
      <div className="space-y-3">
        {(rows ? [92, 70, 84, 60, 78, 66] : [100, 94, 88, 97, 72, 100, 90, 64]).map((width, index) => (
          <Skeleton key={index} className={rows ? 'h-8' : 'h-4'} style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}
