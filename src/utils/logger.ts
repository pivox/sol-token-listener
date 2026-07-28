import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'sol-token-listener' },
  redact: {
    paths: [
      'privateKey',
      'secretKey',
      'SOLANA_PRIVATE_KEY_BASE58',
      'SOLANA_KEYPAIR_PATH',
      '*.privateKey',
      '*.secretKey',
    ],
    censor: '[REDACTED]',
  },
});
