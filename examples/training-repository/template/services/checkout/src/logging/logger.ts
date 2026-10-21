import pino from 'pino';

/** The JSON logger of the checkout backend. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'checkout' },
});
