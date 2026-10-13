/**
 * WhatsApp webhook router.
 *
 * GET  /webhook  - Meta verification challenge
 * POST /webhook  - Incoming message events
 */
import { Router } from 'express';
import config from '../config/index.js';
import logger from '../logger.js';
import { verifySignature } from './signature.js';
import { parseWebhookMessages, isValidWebhookBody } from './parser.js';
import { processMessage } from '../ai/agent.js';
import { createLeadService } from '../leads/service.js';
import { getStore } from '../store/index.js';
import { sendTextMessage } from '../whatsapp/client.js';

import {
  createConversationService,
  classifyMessage,
  buildEnquirySummary,
  MESSAGE_CLASS,
  CONV_STATE,
} from '../conversations/service.js';

const router = Router();

// Deduplication TTL: 24 hours
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// GET /webhook — Meta hub verification
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info({ mode, tokenMatch: token === config.WHATSAPP_VERIFY_TOKEN }, 'Webhook verification');

  if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  logger.warn({ mode, token: '[REDACTED]' }, 'Webhook verification failed');
  return res.status(403).json({ error: 'Forbidden' });
});

// ---------------------------------------------------------------------------
// POST /webhook — Inbound message events
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  // 1. Signature verification (only when app secret is configured)
  if (config.META_APP_SECRET) {
    const signature = req.headers['x-hub-signature-256'] ?? '';
    const rawBody = req.rawBody ?? '';

    if (!verifySignature(rawBody, signature, config.META_APP_SECRET)) {
      logger.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // 2. Validate payload shape
  if (!isValidWebhookBody(req.body)) {
    // Meta sends status updates that aren't messages — silently acknowledge
    return res.status(200).json({ status: 'ok' });
  }

  // Acknowledge immediately (Meta requires < 5s response)
  res.status(200).json({ status: 'ok' });

  // 3. Process messages asynchronously
  const messages = parseWebhookMessages(req.body);
  const store = await getStore();
  const leadService = createLeadService(store);
  const convService = createConversationService(store);

  for (const msg of messages) {
    try {
      await processInboundMessage(msg, store, leadService, convService);
    } catch (err) {
      logger.error({ err, messageId: msg.messageId }, 'Failed to process inbound message');
    }
  }
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a phone number for comparison (strips leading +, spaces, dashes).
 */
function normalisePhone(p) {
  return (p ?? '').replace(/[\s+\-()]/g, '');
}

/**
 * Handle admin WhatsApp commands (TAKE <phone> / RESUME <phone>).
 * Returns true if the message was handled as an admin command.
 */
async function handleAdminCommand(msg, convService) {
  const adminNumber = config.ADMIN_WHATSAPP_NUMBER;
  if (!adminNumber) return false;

  const senderNorm = normalisePhone(msg.from);
  const adminNorm = normalisePhone(adminNumber);
  if (senderNorm !== adminNorm) return false;

  const text = msg.text.trim();
  const takeMatch = text.match(/^TAKE\s+([+\d\s\-()]+)$/i);
  if (takeMatch) {
    const targetPhone = takeMatch[1].trim();
    await convService.claimConversation(targetPhone, 'admin_whatsapp');
    await sendTextMessage(
      msg.from,
      `✅ You have claimed the conversation with ${targetPhone}. Liv will pause AI replies for this customer.`
    );
    return true;
  }

  const resumeMatch = text.match(/^RESUME\s+([+\d\s\-()]+)$/i);
  if (resumeMatch) {
    const targetPhone = resumeMatch[1].trim();
    await convService.resumeAi(targetPhone);
    await convService.resetNotification(targetPhone);
    await sendTextMessage(
      msg.from,
      `🤖 AI assistant Liv has resumed handling messages for ${targetPhone}.`
    );
    return true;
  }

  return false;
}

/**
 * Process a single inbound message with deduplication.
 */
async function processInboundMessage(msg, store, leadService, convService) {
  const dedupKey = `dedup:${msg.messageId}`;

  // Deduplication check
  const seen = await store.get(dedupKey);
  if (seen) {
    logger.debug({ messageId: msg.messageId }, 'Duplicate message skipped');
    return;
  }
  await store.set(dedupKey, true, DEDUP_TTL_MS);

  // Check if message is an admin command from Mam's WhatsApp number
  if (await handleAdminCommand(msg, convService)) {
    return;
  }

  logger.info({ from: msg.from, messageId: msg.messageId }, 'Processing inbound message');

  // Check if human has taken over this conversation
  const isAi = await convService.isAiActive(msg.from);
  if (!isAi) {
    logger.info({ from: msg.from }, 'Human takeover active; AI skipped');
    // Store message in history so Mam has full context
    const historyKey = `history:${msg.from}`;
    const history = (await store.get(historyKey)) ?? [];
    await store.set(historyKey, [...history, { role: 'user', content: msg.text }].slice(-20));
    return;
  }

  // Classify inbound message for qualification / spam filtering
  const classification = classifyMessage(msg.text);

  // Check if in lead collection flow
  if (await leadService.isInLeadFlow(msg.from)) {
    const { reply, complete, lead } = await leadService.processLeadMessage(msg.from, msg.text);
    if (reply) {
      await sendTextMessage(msg.from, reply);

      // If lead collection just completed, send Mam a qualified lead notification
      if (complete && lead && config.ADMIN_WHATSAPP_NUMBER) {
        const alreadyNotified = await convService.hasBeenNotified(msg.from);
        if (!alreadyNotified) {
          const summary = buildEnquirySummary({
            customerPhone: msg.from,
            customerName: lead.name,
            interest: lead.interest || 'Not specified',
            recentMessages: [msg.text],
            aiRecommendation: 'Lead details captured via flow',
          });
          await sendTextMessage(config.ADMIN_WHATSAPP_NUMBER, summary);
          await convService.markNotified(msg.from);
        }
      }
      return;
    }
  }

  // Retrieve conversation history
  const historyKey = `history:${msg.from}`;
  const history = (await store.get(historyKey)) ?? [];

  // Generate AI response
  const result = await processMessage({
    from: msg.from,
    message: msg.text,
    history,
  });

  // Persist updated history (last 10 exchanges)
  const updatedHistory = [
    ...history,
    { role: 'user', content: msg.text },
    { role: 'assistant', content: result.reply },
  ].slice(-20); // Keep last 20 messages (10 exchanges)
  await store.set(historyKey, updatedHistory);

  // Send reply
  await sendTextMessage(msg.from, result.reply);

  // Ensure conversation record is tracked in store
  const existingConv = (await store.get(`conv:${msg.from}`)) ?? { phone: msg.from };
  await store.set(`conv:${msg.from}`, {
    ...existingConv,
    phone: msg.from,
    updatedAt: new Date().toISOString(),
  });

  // Check if customer asked for human handover or message was qualified
  if (
    (result.handover || classification === MESSAGE_CLASS.QUALIFIED) &&
    config.ADMIN_WHATSAPP_NUMBER
  ) {
    const alreadyNotified = await convService.hasBeenNotified(msg.from);
    const customerName = await convService.getCustomerName(msg.from);
    const userMessages = updatedHistory
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    const summary = buildEnquirySummary({
      customerPhone: msg.from,
      customerName,
      interest: classification === MESSAGE_CLASS.QUALIFIED ? 'Qualified Service/Booking Enquiry' : 'Requested Human Handover',
      recentMessages: userMessages,
      aiRecommendation: result.handover ? 'Customer requested a person' : 'High intent booking/custom enquiry',
    });

    // Persist separate summary for this customer
    await store.set(`summary:${msg.from}`, summary);
    const updatedConv = (await store.get(`conv:${msg.from}`)) ?? { phone: msg.from };
    await store.set(`conv:${msg.from}`, {
      ...updatedConv,
      summary,
      updatedAt: new Date().toISOString(),
    });

    if (!alreadyNotified) {
      await sendTextMessage(config.ADMIN_WHATSAPP_NUMBER, summary);
      await convService.markNotified(msg.from);
    }
  }

  // Check if the AI response suggests starting lead collection
  const shouldCollectLead =
    result.reply.toLowerCase().includes('take your details') ||
    result.reply.toLowerCase().includes('have someone from our team contact');

  if (shouldCollectLead && !(await leadService.isInLeadFlow(msg.from))) {
    const leadQuestion = await leadService.startLeadCollection(msg.from);
    await sendTextMessage(msg.from, leadQuestion);
  }
}

export default router;
