/**
 * Pino logger singleton.
 * In test environments we suppress output to keep test output clean.
 */
import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';

const logger = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  ...(process.env.LOG_PRETTY === 'true' && !isTest
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  redact: {
    // Never log sensitive fields
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'body.entry[*].changes[*].value.messages[*].text.body',
    ],
    censor: '[REDACTED]',
  },
});

export default logger;
