import pino from 'pino';

export const log = pino({
  base: null,
  redact: {
    paths: ['authorization', '*.authorization', 'token', '*.token'],
    censor: '[REDACTED]',
  },
});
