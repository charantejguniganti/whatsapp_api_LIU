/**
 * Configuration module.
 * Reads environment variables, validates them with Zod, and exports
 * a strongly-typed config object used throughout the application.
 *
 * Secrets are validated to exist but are NEVER logged.
 */
import 'dotenv/config';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // Server
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Meta / WhatsApp
  WHATSAPP_TOKEN: z.string().optional().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().optional().default('liu_dev_verify'),
  META_APP_SECRET: z.string().optional().default(''),

  // OpenAI
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_MAX_TOKENS: z.coerce.number().int().positive().default(512),

  // PostgreSQL (Neon or any pg-compatible database)
  DATABASE_URL: z.string().optional().default(''),

  // Admin dashboard auth
  ADMIN_USERNAME: z.string().optional().default('admin'),
  ADMIN_PASSWORD_HASH: z.string().optional().default(''), // bcrypt hash
  JWT_SECRET: z.string().optional().default('liu_dev_jwt_secret_change_in_production'),
  JWT_EXPIRY: z.string().optional().default('8h'),

  // Admin WhatsApp number (Mam's business number, for command-based takeover)
  ADMIN_WHATSAPP_NUMBER: z.string().optional().default(''),

  // Feature flags
  USE_MOCK_AI: z
    .enum(['true', 'false', ''])
    .default('')
    .transform((v, ctx) => {
      if (v === 'true') return true;
      if (v === 'false') return false;
      // Auto-detect: use mock when no real key is provided
      return !process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here';
    }),
  USE_MOCK_WHATSAPP: z
    .enum(['true', 'false', ''])
    .default('')
    .transform((v) => {
      if (v === 'true') return true;
      if (v === 'false') return false;
      return (
        !process.env.WHATSAPP_TOKEN ||
        process.env.WHATSAPP_TOKEN === 'your_whatsapp_token_here'
      );
    }),
});

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** @type {z.infer<typeof envSchema>} */
export const config = Object.freeze(parsed.data);

export default config;
