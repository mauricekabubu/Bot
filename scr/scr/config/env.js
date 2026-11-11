import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  GEMINI_API_KEY: z.string().optional(), GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_FALLBACK_MODELS: z.string().default('').transform((value) =>
    [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))]
  ),
  OPENAI_API_KEY: z.string().optional(), OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-3-5-haiku-latest'),
  OLLAMA_BASE_URL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  OLLAMA_MODEL: z.string().default('llama3.2'),
  AI_ADMIN_CONTACTS: z.string().default(''),
  AI_PROVIDER_PRIORITY: z.string().default('gemini,openai,claude,ollama'),
  AI_MAX_FAILOVER_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(3),
  AI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(60000),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(32).max(2048).default(500),
  TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  DATABASE_PATH: z.string().default('../data/atom-maurice.db'),
  WHATSAPP_SESSION_PATH: z.string().default('../data/whatsapp-session'),
  WHATSAPP_MEDIA_PATH: z.string().default('../data/whatsapp-media'),
  WHATSAPP_MEDIA_MAX_TOTAL_MB: z.coerce.number().int().min(10).max(5000).default(500),
  WHATSAPP_UNREAD_RECOVERY_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
  WHATSAPP_DEVICE_SYNC_TIMEOUT_MS: z.coerce.number().int().min(180000).max(900000).default(180000),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().min(1).max(10000).default(4000),
  MAX_FILE_SIZE_MB: z.coerce.number().min(1).max(25).default(10),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(15),
  OUTBOUND_TEST_RECIPIENTS: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEB_SEARCH_API_KEY: z.string().optional(), WEB_SEARCH_ENDPOINT: z.string().url().optional()
}).refine(
  (values) => values.WHATSAPP_MEDIA_MAX_TOTAL_MB >= values.MAX_FILE_SIZE_MB,
  {
    message: 'WHATSAPP_MEDIA_MAX_TOTAL_MB must be at least MAX_FILE_SIZE_MB.',
    path: ['WHATSAPP_MEDIA_MAX_TOTAL_MB'],
  },
);
const parsed = schema.parse(process.env);
export const config = {
  ...parsed,
  DATABASE_PATH: path.resolve(parsed.DATABASE_PATH),
  WHATSAPP_SESSION_PATH: path.resolve(parsed.WHATSAPP_SESSION_PATH),
  WHATSAPP_MEDIA_PATH: path.resolve(parsed.WHATSAPP_MEDIA_PATH),
};
