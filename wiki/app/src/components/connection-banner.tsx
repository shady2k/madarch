/**
 * The frame's one line for a server that cannot answer (madarch-64o5.85, the owner's second walk): what happened, when
 * the next probe comes, a press to probe now, and the time of the data the page still shows. A return says «Связь
 * восстановлена» for two seconds. No page block repeats the state.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Metadata, Stack, Text } from './ui/typography.js';
import { retryNow, useConnection, type ConnectionState } from '../connection.js';

function words(state: ConnectionState, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (state.restored) return t('connection.restored');
  return state.reason === 'starting' ? t('connection.starting') : t('connection.offline');
}

export function ConnectionBanner({ lastDataAt }: { readonly lastDataAt: number | null }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const connection = useConnection();
  const [, tick] = useState(0);
  // The countdown moves while a probe waits; the restored line's own timer ends it.
  useEffect(() => {
    if (!connection.offline) return;
    const timer = setInterval(() => { tick((at) => at + 1); }, 500);
    return () => { clearInterval(timer); };
  }, [connection.offline]);
  if (!connection.offline && !connection.restored) return null;
  const seconds = connection.nextRetryAt === null ? null : Math.max(0, Math.ceil((connection.nextRetryAt - Date.now()) / 1000));
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const dataTime = lastDataAt === null ? null : new Date(lastDataAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  return (
    <Alert
      className="mb-4"
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
      data-state={connection.restored ? 'restored' : connection.reason ?? 'offline'}
    >
      <AlertDescription>
        <Stack className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Text className="font-medium" data-testid="connection-message">{words(connection, t)}</Text>
          {connection.offline ? (
            <Text className="text-small text-secondary" data-testid="connection-countdown">
              {seconds === null ? t('connection.checking') : t('connection.retryIn', { seconds })}
            </Text>
          ) : null}
          {connection.offline ? (
            <Button variant="outline" size="sm" onClick={retryNow} data-testid="connection-retry">{t('connection.retryNow')}</Button>
          ) : null}
          {connection.offline && dataTime !== null ? (
            <Metadata data-testid="connection-data-as-of">{t('connection.dataAsOf', { time: dataTime })}</Metadata>
          ) : null}
        </Stack>
      </AlertDescription>
    </Alert>
  );
}
