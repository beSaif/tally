import { z } from 'zod';
import { isValidDay, isValidMinute } from './dates';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const resolvedLanguageSchema = z.enum(['en', 'fr']);
export const languageSchema = z.enum(['auto', 'en', 'fr']);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const daySchema = z.string().refine(isValidDay, 'expected YYYY-MM-DD');
export const minuteSchema = z.string().refine(isValidMinute, 'expected YYYY-MM-DDTHH:MM');
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const entrySourceSchema = z.enum(['text', 'voice', 'photo', 'manual']);

export const deleteAccountSchema = z.object({ email: emailSchema });

export const notificationPrefsSchema = z.object({
  reminder: z.boolean(),
  reminder_time: hhmmSchema,
  reminder_only_if_empty: z.boolean(),
  budget: z.boolean(),
  weekly: z.boolean(),
  monthly: z.boolean(),
});

export const settingsInputSchema = z.object({
  currency: currencySchema.optional(),
  language: languageSchema.optional(),
  budget_cents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  model: z.string().trim().min(1).max(80).optional(),
  setup_complete: z.boolean().optional(),
  notifications: notificationPrefsSchema.partial().optional(),
});

export const categoriesInputSchema = z.object({
  categories: z.array(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(40) })).max(60),
});

export const newEntrySchema = z.object({
  amount_cents: z.number().int().min(0).max(1_000_000_000),
  currency: currencySchema.optional(),
  description: z.string().trim().min(1).max(200),
  category_id: z.string().uuid().nullable().optional(),
  category: z.string().trim().max(40).nullable().optional(),
  occurred_at: minuteSchema,
  note: z.string().trim().max(500).nullable().optional(),
  source: entrySourceSchema,
  raw_input: z.string().max(4000).nullable().optional(),
});
export const entriesCreateSchema = z.object({ entries: z.array(newEntrySchema).min(1).max(50) });
export const entryPatchSchema = newEntrySchema.partial();

export const rangeQuerySchema = z.object({ from: daySchema, to: daySchema });
export const summaryQuerySchema = z.object({
  from: daySchema,
  to: daySchema,
  prev_from: daySchema.optional(),
  prev_to: daySchema.optional(),
});

export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
  }),
  user_agent: z.string().max(500).optional(),
  lang: resolvedLanguageSchema,
  tz: z.string().min(1).max(64),
});
export const pushPatchSchema = z.object({ lang: resolvedLanguageSchema.optional(), tz: z.string().min(1).max(64).optional() });
export const pushTestSchema = z.object({ endpoint: z.string().url().max(2000).optional() });
export const pushSkipSchema = z.object({ day: daySchema });

/** What Gemini must return for a parse request (validated client-side before anything is shown). */
export const geminiParseSchema = z.object({
  transcript: z.string().default(''),
  entries: z
    .array(
      z.object({
        amount: z.coerce.number().min(0),
        currency: z.string().default(''),
        description: z.string().default(''),
        category: z.string().nullable().default(null),
        occurred_at: z.string().default(''),
        note: z.string().nullable().default(null),
        confidence: z.coerce.number().min(0).max(1).default(0.5),
      }),
    )
    .default([]),
  reply: z.string().nullable().default(null),
});
export type GeminiParseRaw = z.infer<typeof geminiParseSchema>;
