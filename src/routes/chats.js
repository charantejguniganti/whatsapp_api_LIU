/**
 * routes/chats.js
 *
 * Chat Management API:
 *   GET    /api/chats          - List conversations sorted by latest message timestamp (descending)
 *   GET    /api/chats/:chatId  - Get full conversation detail and message history
 *   DELETE /api/chats/:chatId  - Permanently delete one conversation and local messages (local DB only)
 *   DELETE /api/chats          - Permanently delete all conversations and local messages (local DB only)
 *
 * CRITICAL: NEVER calls WhatsApp deletion APIs. Original WhatsApp history is untouched.
 */
import { Router } from 'express';
import { createConversationService } from '../conversations/service.js';
import { getStore } from '../store/index.js';
import logger from '../logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/chats — Returns conversations sorted by latest message timestamp (desc)
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const store = await getStore();
    const convService = createConversationService(store);
    const chats = await convService.listConversations();

    return res.json({
      ok: true,
      chats,
      total: chats.length,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/chats/:chatId — Get single conversation detail and message history
// ---------------------------------------------------------------------------
router.get('/:chatId', async (req, res, next) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const store = await getStore();

    const [conv, history, lead, summary] = await Promise.all([
      store.get(`conv:${chatId}`),
      store.get(`history:${chatId}`),
      store.get(`lead:${chatId}`),
      store.get(`summary:${chatId}`),
    ]);

    if (!conv && (!history || history.length === 0)) {
      return res.status(404).json({ ok: false, error: 'Chat not found' });
    }

    return res.json({
      ok: true,
      chat: {
        ...(conv || { phone: chatId }),
        history: history || [],
        lead: lead || null,
        summary: summary || conv?.summary || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/chats/:chatId — Delete one conversation (Local DB only)
// ---------------------------------------------------------------------------
router.delete('/:chatId', async (req, res, next) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chatId is required' });
    }

    const store = await getStore();
    const convService = createConversationService(store);
    await convService.deleteConversation(chatId);

    logger.info({ chatId }, 'Chat deleted locally via /api/chats/:chatId');
    return res.json({
      ok: true,
      message: `Conversation ${chatId} successfully deleted from local database. Original WhatsApp messages remain untouched.`,
      chatId,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/chats — Delete all conversations (Local DB only)
// ---------------------------------------------------------------------------
router.delete('/', async (req, res, next) => {
  try {
    const store = await getStore();
    const convService = createConversationService(store);
    const result = await convService.deleteAllConversations();

    logger.info({ count: result.count }, 'All chats deleted locally via /api/chats');
    return res.json({
      ok: true,
      message: 'All conversations successfully deleted from local database. Original WhatsApp messages remain untouched.',
      deletedCount: result.count,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
