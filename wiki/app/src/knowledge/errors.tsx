import { TechnicalText } from '@/components/ui/technical-text.js';
import { Paragraph } from '@/components/ui/typography.js';
/**
 * A failure of the fill or the writer, told once in the reader's language, with the engineer's detail (the English
 * message with its paths) behind a link and the Problems page one click away (madarch-m38l.11). The server sends a
 * `code` for the kind of failure and keeps `message` as the detail; a code the app has no words for shows the message.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { KLink } from './blocks.js';
import { WIKI_PROBLEMS } from './routes.js';

export function FailureNote({ scope, code, message }: { scope: 'fill' | 'writer'; code: string | undefined; message: string | undefined }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (message === undefined && code === undefined) return null;
  const key = `errors.${scope}.${code ?? ''}`;
  const known = code !== undefined && i18n.exists(key);
  if (!known) return message === undefined ? null : <Paragraph className="m-0" data-testid="failure-message">{message}</Paragraph>;
  return (
    <div data-testid="failure-note" data-code={code}>
      <Paragraph className="m-0">{t(key)}</Paragraph>
      <Paragraph className="mb-0 mt-1 text-small">
        <KLink href={WIKI_PROBLEMS}>{t('errors.problems')}</KLink>
        {message !== undefined && message !== '' && (
          <>
            {' · '}
            <Button type="button" variant="link" size="content" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="failure-details">
              {open ? t('knowledge.findingsHide') : t('knowledge.findingsDetails')}
            </Button>
          </>
        )}
      </Paragraph>
      {open && message !== undefined && <TechnicalText className="!mb-0 !mt-2" data-testid="failure-detail">{message}</TechnicalText>}
    </div>
  );
}
