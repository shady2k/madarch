import pino from 'pino';

/** The JSON logger of the payments service; every module logs through it. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'payments' },
});
