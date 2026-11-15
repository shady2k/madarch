/**
 * The home of a product that has no kinds manifest (madarch-64o5.133): the product was created, the graph is empty, and
 * the page names the file a fill would read and the guide that writes one. The frame draws it before any template
 * composes, because a product without a manifest has no graph to ask: its catalogue cannot be published.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Paragraph, Stack, TextLink } from './ui/typography.js';
import type { FillStatusAnswer } from './command.js';

export function MissingManifest({ product, status }: { readonly product: string | null; readonly status: FillStatusAnswer | null }): ReactElement {
  const { t } = useTranslation();
  const file = status?.manifestFile ?? '';
  const guide = status?.manifestGuide ?? '';
  return (
    <Card data-testid="missing-manifest">
      <CardHeader>
        {product === null ? null : <Paragraph data-testid="missing-manifest-product">{product}</Paragraph>}
        <CardTitle>{t('firstRun.created')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Stack>
          <Paragraph data-testid="missing-manifest-what">{t('firstRun.noManifest')}</Paragraph>
          {file === '' ? null : <Paragraph data-testid="missing-manifest-file">{t('firstRun.manifestFile', { file })}</Paragraph>}
          {guide === '' ? null : <Paragraph><TextLink href={guide} rel="noreferrer" data-testid="missing-manifest-guide">{t('firstRun.manifestGuide')}</TextLink></Paragraph>}
        </Stack>
      </CardContent>
    </Card>
  );
}
