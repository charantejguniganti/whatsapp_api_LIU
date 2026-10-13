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

    const stats = {
      total: convs.length,
      aiActive: convs.filter((c) => c.state === CONV_STATE.AI_ACTIVE || !c.state).length,
      humanTakeover: convs.filter((c) => c.state === CONV_STATE.HUMAN_TAKEOVER).length,
      aiResumed: convs.filter((c) => c.state === CONV_STATE.AI_RESUMED).length,
      pendingNotification: convs.filter((c) => c.notificationSent).length,
    };

    return res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/leads
// ---------------------------------------------------------------------------
router.get('/leads', async (req, res, next) => {
  try {
    const store = await getStore();
    const convService = createConversationService(store);

    // Get all conversation records
    const convs = await convService.listConversations();

    // Enrich with lead data
    const enriched = await Promise.all(
      convs.map(async (conv) => {
        const leadState = await store.get(`lead:${conv.phone}`);
        const history = await store.get(`history:${conv.phone}`);
        const summary = await store.get(`summary:${conv.phone}`);
        return {
          phone: conv.phone,
          state: conv.state ?? CONV_STATE.AI_ACTIVE,
          notificationSent: conv.notificationSent ?? false,
          notifiedAt: conv.notifiedAt ?? null,
          claimedBy: conv.claimedBy ?? null,
          claimedAt: conv.claimedAt ?? null,
          resumedAt: conv.resumedAt ?? null,
          customerName: leadState?.data?.name ?? null,
          interest: leadState?.data?.interest ?? null,
          leadComplete: leadState?.state === 'COMPLETE',
          messageCount: history?.length ?? 0,
          lastMessage: history && history.length > 0 ? history[history.length - 1].content : null,
          lastMessageAt: conv.updatedAt ?? conv.notifiedAt ?? conv.claimedAt ?? null,
          summary: summary ?? conv.summary ?? null,
        };
      })
    );

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

    const [conv, leadState, history, summary] = await Promise.all([
      store.get(`conv:${phone}`),
      store.get(`lead:${phone}`),
      store.get(`history:${phone}`),
      store.get(`summary:${phone}`),
    ]);

    return res.json({
      phone,
      conversation: conv ?? { phone, state: CONV_STATE.AI_ACTIVE },
      lead: leadState ?? null,
      history: history ?? [],
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

export default router;
