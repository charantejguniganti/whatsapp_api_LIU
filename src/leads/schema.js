/**
 * Zod schemas for lead validation.
 */
import { z } from 'zod';

export const LeadSchema = z.object({
  /** WhatsApp number in E.164 format */
  phone: z
    .string()
    .min(7)
    .max(20)
    .regex(/^\+?[1-9]\d{6,18}$/, 'Invalid phone number format'),

  /** Customer's name */
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100)
    .trim(),

  /** What they are interested in */
  interest: z
    .string()
    .min(3, 'Please describe the interest')
    .max(500)
    .trim(),

  /** Preferred contact time or window */
  preferredContactTime: z
    .string()
    .max(200)
    .trim()
    .optional()
    .default('Anytime during office hours'),

  /** Explicit consent to be contacted */
  consentGiven: z.boolean().default(false),

  /** ISO timestamp of when the lead was captured */
  capturedAt: z.string().datetime().optional(),

  /** Source channel */
  source: z.enum(['whatsapp', 'simulate', 'api']).default('whatsapp'),
});

/** @typedef {z.infer<typeof LeadSchema>} Lead */

export const PartialLeadSchema = LeadSchema.partial().extend({
  phone: z.string(), // phone is always required
});
