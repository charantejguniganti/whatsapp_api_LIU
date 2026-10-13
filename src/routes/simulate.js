/**
 * Simulate route — local development testing endpoint.
 *
 * POST /simulate
 * Send a simulated WhatsApp message without real credentials.
 *
 * Body:
 * {
 *   "from": "+91xxxxxxxxxx",
 *   "message": "Tell me about your corporate events"
 * }
 *
 * Returns:
 * {
 *   "from": "+91xxxxxxxxxx",
 *   "reply": "...",
 *   "handover": false,
 *   "mock": true
 * }
 *
 * NEVER sends real WhatsApp messages.
 * Available in development mode only.
 */
import { Router } from 'express';
import { z } from 'zod';
import config from '../config/index.js';
import logger from '../logger.js';
import { processMessage } from '../ai/agent.js';
import { createLeadService } from '../leads/service.js';
import { getStore } from '../store/index.js';

const router = Router();

const SimulateBodySchema = z.object({
  from: z
    .string()
    .min(7)
    .max(20)
    .default('+910000000000'),
  message: z.string().min(1).max(2000),
  clearHistory: z.boolean().optional().default(false),
});

router.post('/', async (req, res, next) => {
  // Only available outside production
  if (config.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const parsed = SimulateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Validation error',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { from, message, clearHistory } = parsed.data;

  try {
    const store = await getStore();
    const leadService = createLeadService(store);

    const historyKey = `history:${from}`;

    if (clearHistory) {
      await store.delete(historyKey);
      await store.delete(`lead:${from}`);
    }

    // Check if in lead collection flow
    if (await leadService.isInLeadFlow(from)) {
      const { reply, complete, lead } = await leadService.processLeadMessage(from, message);
      if (reply) {
        return res.json({
          from,
          reply,
          handover: false,
          leadCollected: complete,
          lead: lead ?? undefined,
          mock: true,
          flow: 'lead_collection',
        });
      }
    }

    const history = (await store.get(historyKey)) ?? [];

    const result = await processMessage({ from, message, history });

    // Update history
    const updated = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: result.reply },
    ].slice(-20);
    await store.set(historyKey, updated);

    // Auto-start lead collection if the AI mentions collecting details
    if (
      !result.handover &&
      (result.reply.toLowerCase().includes('take your details') ||
        result.reply.toLowerCase().includes('have someone from our team contact'))
    ) {
      await leadService.startLeadCollection(from);
    }

    logger.info({ from, mock: true }, 'Simulated message processed');

    return res.json({
      from,
      reply: result.reply,
      handover: result.handover,
      leadCollected: result.leadCollected,
      mock: true,
      flow: 'ai',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
