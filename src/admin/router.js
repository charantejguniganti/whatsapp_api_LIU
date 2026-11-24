/**
 * Admin API Router
 *
 * All routes require a valid JWT (via requireAuth middleware).
 *
 * POST   /admin/login                   - Get a JWT token
 * GET    /admin/leads                   - List all conversations / leads
 * GET    /admin/leads/:phone            - Get full lead detail + history
 * POST   /admin/leads/:phone/takeover   - Mam claims a conversation
 * POST   /admin/leads/:phone/resume     - Return conversation to Liv
 * GET    /admin/conversations           - All conversation states
 * GET    /admin/stats                   - Quick counts for dashboard header
 */
import { Router } from 'express';
import { z } from 'zod';
import { login, requireAuth } from './auth.js';
import { createConversationService, CONV_STATE } from '../conversations/service.js';
import { getStore } from '../store/index.js';
import logger from '../logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /admin/login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const token = await login(username, password);
  if (!token) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Set cookie for dashboard (SameSite strict, HttpOnly)
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });

  return res.json({ token });
});

// ---------------------------------------------------------------------------
// POST /admin/logout
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  res.clearCookie('admin_token');
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Everything below requires authentication
// ---------------------------------------------------------------------------
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /admin/stats
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res, next) => {
  try {
    const store = await getStore();
    const convService = createConversationService(store);
    const convs = await convService.listConversations();

    const newEnquiries = convs.filter((c) => c.status === 'New').length;
    const inProgress = convs.filter((c) => c.status === 'In Progress' || c.status === 'Consultant Requested').length;
    const waitingForCustomer = convs.filter((c) => c.status === 'Waiting for Customer').length;
    const closed = convs.filter((c) => c.status === 'Closed').length;

    const stats = {
      total: convs.length,
      newEnquiries,
      inProgress,
      waitingForCustomer,
      closed,
      // Backward compatibility mappings
      aiActive: convs.filter((c) => c.state === CONV_STATE.AI_ACTIVE || !c.state).length,
      humanTakeover: inProgress,
      aiResumed: waitingForCustomer,
      pendingNotification: newEnquiries,
    };

    return res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/leads — Returns conversations sorted by latest message timestamp
// ---------------------------------------------------------------------------
router.get('/leads', async (req, res, next) => {
  try {
    const store = await getStore();
    const convService = createConversationService(store);

    // Get all conversation records, sorted by latest message timestamp
    const enriched = await convService.listConversations();

    return res.json({ leads: enriched, total: enriched.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/leads/:phone
// ---------------------------------------------------------------------------
router.get('/leads/:phone', async (req, res, next) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const store = await getStore();

    const [conv, leadState, rawHistory, summary] = await Promise.all([
      store.get(`conv:${phone}`),
      store.get(`lead:${phone}`),
      store.get(`history:${phone}`),
      store.get(`summary:${phone}`),
    ]);

    const history = Array.isArray(rawHistory) ? rawHistory : [];
    const total = history.length;

    let slicedHistory = history;
    let hasMore = false;

    if (req.query.limit) {
      const limit = parseInt(req.query.limit, 10) || 50;
      const offset = parseInt(req.query.offset, 10) || 0;
      // Chronological order: [oldest ... newest]
      // offset=0, limit=30 returns the newest 30 messages
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = Math.max(0, total - offset);
      slicedHistory = history.slice(startIndex, endIndex);
      hasMore = startIndex > 0;
    }

    return res.json({
      phone,
      conversation: conv ?? { phone, state: CONV_STATE.AI_ACTIVE },
      lead: leadState ?? null,
      history: slicedHistory,
      totalMessages: total,
      hasMore,
      summary: summary ?? conv?.summary ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:phone/takeover
// ---------------------------------------------------------------------------
router.post('/leads/:phone/takeover', async (req, res, next) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const store = await getStore();
    const convService = createConversationService(store);

    await convService.claimConversation(phone, req.admin?.sub ?? 'admin');

    logger.info({ phone, by: req.admin?.sub }, 'Takeover via admin API');
    return res.json({ ok: true, phone, state: CONV_STATE.HUMAN_TAKEOVER });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:phone/resume
// ---------------------------------------------------------------------------
router.post('/leads/:phone/resume', async (req, res, next) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const store = await getStore();
    const convService = createConversationService(store);

    await convService.resumeAi(phone);
    await convService.resetNotification(phone); // allow re-notify on next qualified msg

    logger.info({ phone, by: req.admin?.sub }, 'AI resumed via admin API');
    return res.json({ ok: true, phone, state: CONV_STATE.AI_RESUMED });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/whatsapp/status
// ---------------------------------------------------------------------------
router.get('/whatsapp/status', async (req, res, next) => {
  try {
    const { getBaileysStatus } = await import('../whatsapp/baileysClient.js');
    return res.json(getBaileysStatus());
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/whatsapp/start
// ---------------------------------------------------------------------------
router.post('/whatsapp/start', async (req, res, next) => {
  try {
    const { initBaileys, getBaileysStatus } = await import('../whatsapp/baileysClient.js');
    await initBaileys(true);
    return res.json(getBaileysStatus());
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/whatsapp/pairing-code
// Generates a Baileys pairing code for phone-number based linking
// ---------------------------------------------------------------------------
router.post('/whatsapp/pairing-code', async (req, res, next) => {
  try {
    const { phone } = req.body ?? {};
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required (with country code)' });
    }

    const { requestPairingCode } = await import('../whatsapp/baileysClient.js');
    const result = await requestPairingCode(phone);
    return res.json({
      ok: true,
      pairingCode: result.pairingCode,
      expiresAt: result.expiresAt,
      phone: result.phone,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'Pairing code generation error');
    return res.status(400).json({ error: err.message || 'Failed to generate pairing code' });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:phone/reply (Mam sends message from dashboard)
// ---------------------------------------------------------------------------
router.post('/leads/:phone/reply', async (req, res, next) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { message } = req.body ?? {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message required' });
    }

    const store = await getStore();
    const { sendTextMessage } = await import('../whatsapp/client.js');

    // Send reply via active channel (Baileys or Meta Cloud API)
    await sendTextMessage(phone, message.trim());

    // Update conversation history with timestamp
    const now = new Date().toISOString();
    const historyKey = `history:${phone}`;
    const history = (await store.get(historyKey)) ?? [];
    const updated = [
      ...history,
      { role: 'assistant', content: message.trim(), timestamp: now },
    ].slice(-20);
    await store.set(historyKey, updated);

    // Update conversation timestamp & latest message
    const existingConv = (await store.get(`conv:${phone}`)) ?? { phone };
    await store.set(`conv:${phone}`, {
      ...existingConv,
      lastMessage: message.trim(),
      lastMessageTimestamp: now,
      updatedAt: now,
    });

    return res.json({ ok: true, phone, message: message.trim() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/leads/:phone — Delete single conversation (Local DB only)
// ---------------------------------------------------------------------------
router.delete('/leads/:phone', async (req, res, next) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const store = await getStore();
    const convService = createConversationService(store);

    await convService.deleteConversation(phone);
    logger.info({ phone, by: req.admin?.sub }, 'Chat deleted via admin API');
    return res.json({
      ok: true,
      message: `Conversation ${phone} successfully deleted from local database. WhatsApp history remains untouched.`,
      phone,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/leads — Delete all conversations (Local DB only)
// ---------------------------------------------------------------------------
router.delete('/leads', async (req, res, next) => {
  try {
    const store = await getStore();
    const convService = createConversationService(store);

    const result = await convService.deleteAllConversations();
    logger.info({ count: result.count, by: req.admin?.sub }, 'All chats deleted via admin API');
    return res.json({
      ok: true,
      message: 'All conversations successfully deleted from local database. WhatsApp history remains untouched.',
      deletedCount: result.count,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
