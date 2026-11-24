/**
 * Conversation Service
 *
 * Manages:
 *  - Conversation state (AI_ACTIVE / HUMAN_TAKEOVER / AI_RESUMED)
 *  - Enquiry qualification and spam classification
 *  - Conversation summaries for Mam notifications
 *  - Notification deduplication (one notification per fresh enquiry)
 *
 * State is persisted in the store under:
 *   conv:<phone>          -> ConversationRecord
 *   notification:<phone>  -> { sentAt, leadId }
 */
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conversation ownership states */
export const CONV_STATE = {
  /** Default: Liv handles all replies */
  AI_ACTIVE: 'AI_ACTIVE',
  /** Mam has claimed the conversation; AI replies paused */
  HUMAN_TAKEOVER: 'HUMAN_TAKEOVER',
  /** Mam explicitly returned the conversation to Liv */
  AI_RESUMED: 'AI_RESUMED',
};

/** Classification of an inbound customer message */
export const MESSAGE_CLASS = {
  ROUTINE: 'ROUTINE',       // FAQ, general info — AI answers, no notification
  QUALIFIED: 'QUALIFIED',   // Booking intent, custom package, personalised quote
  SPAM: 'SPAM',             // Obvious promotional or irrelevant content
  UNCERTAIN: 'UNCERTAIN',   // Short/odd message — ask a follow-up, don't discard
};

// ---------------------------------------------------------------------------
// Spam / qualification patterns
// ---------------------------------------------------------------------------

const SPAM_PATTERNS = [
  /\b(buy now|limited offer|100% guarantee|click here|free gift|earn money|make money fast|weight loss|casino|lottery|won a prize|congratulations you.ve (won|been selected)|prize|winner)\b/i,
  /http[s]?:\/\/\S+/,       // Contains a link (not from a real customer)
  /(.)\1{6,}/,              // Excessive character repetition e.g. aaaaaaa
];

const QUALIFIED_PATTERNS = [
  /\b(book|booking|appointment|schedule|enrol|enroll|register|sign up|sign me up)\b/i,
  /\b(want to (join|start|try|come|visit|purchase|buy))\b/i,
  /\b(how (do I|can I|to) (book|pay|join|start|enrol|enroll|register))\b/i,
  /\b(call me|call us|whatsapp me|contact me|reach me|reach out)\b/i,
  /\b(custom|customise|customise|personalise|personalize|tailor)\b/i,
  /\b(package|bundle|combination|combine)\b/i,
  /\b(quote|quotation|pricing for me|cost for me|how much for)\b/i,
  /\b(interested in (booking|starting|joining|enrolling))\b/i,
  /\b(when (are|is|do) you (available|open|free))\b/i,
  /\b(i want to (book|start|join|enrol|schedule|purchase))\b/i,
];

const ROUTINE_PATTERNS = [
  /\b(what is|what are|tell me about|explain|describe|how does|what does)\b/i,
  /\b(pilates|barre|yoga|dance|grooming|etiquette|wellness|nutrition|image consulting)\b/i,
  /\b(price|cost|fee|fees|charges|how much|pricing)\b/i,
  /\b(hi|hello|hey|good morning|good afternoon|good evening|namaste)\b/i,
  /\b(thank you|thanks|okay|ok|got it|understood|noted)\b/i,
  /\b(where|location|address|directions)\b/i,
  /\b(who|founder|founded|about liu|about live it up)\b/i,
];

/**
 * Classify a single inbound message.
 * Priority: SPAM > QUALIFIED > ROUTINE > UNCERTAIN
 *
 * @param {string} text
 * @returns {'ROUTINE'|'QUALIFIED'|'SPAM'|'UNCERTAIN'}
 */
export function classifyMessage(text) {
  if (!text || text.trim().length === 0) return MESSAGE_CLASS.UNCERTAIN;

  // Obvious spam first
  if (SPAM_PATTERNS.some((p) => p.test(text))) return MESSAGE_CLASS.SPAM;

  // Qualified enquiry
  if (QUALIFIED_PATTERNS.some((p) => p.test(text))) return MESSAGE_CLASS.QUALIFIED;

  // Routine FAQ
  if (ROUTINE_PATTERNS.some((p) => p.test(text))) return MESSAGE_CLASS.ROUTINE;

  // Short messages (< 15 chars) are uncertain, not spam
  if (text.trim().length < 15) return MESSAGE_CLASS.UNCERTAIN;

  return MESSAGE_CLASS.UNCERTAIN;
}

// ---------------------------------------------------------------------------
// Conversation summary generator
// ---------------------------------------------------------------------------

/**
 * Build a plain-text enquiry summary for Mam's notification.
 *
 * @param {Object} params
 * @param {string}   params.customerPhone
 * @param {string}   [params.customerName]
 * @param {string}   params.interest
 * @param {string[]} params.recentMessages  - Last few customer messages (for summary)
 * @param {string}   [params.aiRecommendation]
 * @returns {string}
 */
export function buildEnquirySummary({
  customerPhone,
  customerName,
  interest,
  recentMessages = [],
  aiRecommendation,
}) {
  const name = customerName || 'Not yet provided';
  const conversationSnippet = recentMessages.slice(-4).join(' | ');

  return (
    `*LIU — New Qualified Enquiry* 🔔\n\n` +
    `*Customer:* ${name}\n` +
    `*WhatsApp:* ${customerPhone}\n` +
    `*Interested in:* ${interest}\n` +
    `*Conversation snippet:* ${conversationSnippet || 'N/A'}\n` +
    (aiRecommendation ? `*AI note:* ${aiRecommendation}\n` : '') +
    `\nReply *TAKE ${customerPhone}* to claim this conversation.\n` +
    `Reply *RESUME ${customerPhone}* to return it to Liv later.`
  );
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * @param {import('../store/interface.js').IStore} store
 */
export function createConversationService(store) {

  // ── Read / write helpers ────────────────────────────────────────────────

  async function getConv(phone) {
    return store.get(`conv:${phone}`);
  }

  async function saveConv(phone, record) {
    await store.set(`conv:${phone}`, record);
  }

  // ── Contact Name Resolution ──────────────────────────────────────────────

  /**
   * Resolves contact name with strict priority:
   * 1. WhatsApp push name / profile name
   * 2. Saved contact name (from lead record or metadata)
   * 3. WhatsApp phone number as fallback
   */
  function resolveContactName(conv = {}, lead = null) {
    if (conv.isGroup && conv.groupName && conv.groupName.trim()) {
      return conv.groupName.trim();
    }
    // 1. WhatsApp push name / profile name
    if (conv.pushName && typeof conv.pushName === 'string' && conv.pushName.trim()) {
      const p = conv.pushName.trim();
      if (p !== 'null' && p !== 'undefined' && p.toLowerCase() !== 'customer') {
        return p;
      }
    }
    // 2. Saved contact name (from lead record or metadata)
    const saved = lead?.data?.name || conv.savedName || conv.customerName;
    if (saved && typeof saved === 'string' && saved.trim()) {
      const s = saved.trim();
      if (s !== 'null' && s !== 'undefined' && s.toLowerCase() !== 'customer') {
        return s;
      }
    }
    // 3. Fallback: Verified WhatsApp phone number, or Unresolved Contact for unverified LIDs
    if (conv.verifiedPhone) return conv.verifiedPhone;
    if (conv.isVerifiedPhone && conv.phone) return conv.phone;
    if (conv.phone && conv.phone.startsWith('+') && !conv.phone.includes('@lid')) {
      return conv.phone;
    }
    return 'Unresolved Contact';
  }

  // ── Conversation state management ────────────────────────────────────────

  /**
   * Get the current conversation state for a number.
   * Defaults to AI_ACTIVE for new conversations.
   * @param {string} phone
   * @returns {Promise<string>} CONV_STATE value
   */
  async function getConvState(phone) {
    const conv = await getConv(phone);
    return conv?.state ?? CONV_STATE.AI_ACTIVE;
  }

  /**
   * True if AI should reply to this customer right now.
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async function isAiActive(phone) {
    const state = await getConvState(phone);
    return state === CONV_STATE.AI_ACTIVE || state === CONV_STATE.AI_RESUMED;
  }

  /**
   * Mam claims this conversation — AI replies pause.
   * @param {string} phone - Customer phone number
   * @param {string} claimedBy - Identifier for Mam (e.g. "admin" or a number)
   * @returns {Promise<void>}
   */
  async function claimConversation(phone, claimedBy = 'admin') {
    const conv = (await getConv(phone)) ?? { phone };
    await saveConv(phone, {
      ...conv,
      state: CONV_STATE.HUMAN_TAKEOVER,
      claimedBy,
      claimedAt: new Date().toISOString(),
    });
    logger.info({ phone, claimedBy }, 'Conversation claimed by human');
  }

  /**
   * Return conversation to Liv.
   * @param {string} phone
   * @returns {Promise<void>}
   */
  async function resumeAi(phone) {
    const conv = (await getConv(phone)) ?? { phone };
    await saveConv(phone, {
      ...conv,
      state: CONV_STATE.AI_RESUMED,
      resumedAt: new Date().toISOString(),
      claimedBy: null,
    });
    logger.info({ phone }, 'Conversation returned to AI');
  }

  // ── Notification deduplication ───────────────────────────────────────────

  /**
   * True if Mam has already been notified about this customer's current enquiry.
   * Notifications reset when AI is resumed (next qualified message triggers again).
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async function hasBeenNotified(phone) {
    const conv = await getConv(phone);
    return conv?.notificationSent === true;
  }

  /**
   * Mark this conversation as notified.
   * @param {string} phone
   */
  async function markNotified(phone) {
    const conv = (await getConv(phone)) ?? { phone };
    await saveConv(phone, {
      ...conv,
      notificationSent: true,
      notifiedAt: new Date().toISOString(),
    });
  }

  /**
   * Reset the notification flag (called when AI is resumed so the next
   * qualified message triggers a fresh notification).
   * @param {string} phone
   */
  async function resetNotification(phone) {
    const conv = (await getConv(phone)) ?? { phone };
    await saveConv(phone, {
      ...conv,
      notificationSent: false,
      notifiedAt: null,
    });
  }

  // ── Customer name helper ─────────────────────────────────────────────────

  /**
   * Try to extract a stored customer name from their lead record.
   * @param {string} phone
   * @returns {Promise<string|null>}
   */
  async function getCustomerName(phone) {
    const lead = await store.get(`lead:${phone}`);
    return lead?.data?.name ?? null;
  }

  // ── Conversation Deletion & Tombstone Management (Local DB Only) ───────

  /**
   * Delete a single conversation and all its messages from local database.
   * Sets a tombstone to prevent old messages from being re-imported on sync.
   * NEVER calls WhatsApp deletion APIs.
   * @param {string} phone
   */
  async function deleteConversation(phone) {
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    const now = new Date().toISOString();

    // 1. Permanently remove all local data for this chat
    await Promise.all([
      store.delete(`conv:${cleanPhone}`),
      store.delete(`history:${cleanPhone}`),
      store.delete(`lead:${cleanPhone}`),
      store.delete(`quiz:${cleanPhone}`),
      store.delete(`summary:${cleanPhone}`),
      store.delete(`notified:${cleanPhone}`),
      store.delete(`notification:${cleanPhone}`),
    ]);

    // 2. Set tombstone record using the chat ID/phone to protect against sync re-import
    await store.set(`tombstone:${cleanPhone}`, {
      deletedAt: now,
      phone: cleanPhone,
    });

    logger.info({ phone: cleanPhone }, 'Locally deleted conversation and all associated messages');
    return { ok: true, phone: cleanPhone };
  }

  /**
   * Delete ALL conversations and messages from local database.
   * Sets tombstones so WhatsApp synchronization does not resurrect them.
   * NEVER calls WhatsApp deletion APIs.
   */
  async function deleteAllConversations() {
    const convKeys = await store.keys('conv:');
    const now = new Date().toISOString();

    for (const k of convKeys) {
      const phone = k.replace('conv:', '');
      await Promise.all([
        store.delete(`conv:${phone}`),
        store.delete(`history:${phone}`),
        store.delete(`lead:${phone}`),
        store.delete(`quiz:${phone}`),
        store.delete(`summary:${phone}`),
        store.delete(`notified:${phone}`),
        store.delete(`notification:${phone}`),
      ]);
      await store.set(`tombstone:${phone}`, {
        deletedAt: now,
        phone,
      });
    }

    // Set global tombstone marker
    await store.set('tombstone:global', {
      deletedAllAt: now,
    });

    logger.info({ count: convKeys.length }, 'Locally deleted all conversations and set sync tombstones');
    return { ok: true, count: convKeys.length };
  }

  // ── Lead listing for dashboard & APIs (Latest Message First) ─────────────

  /**
   * Return a summary list of all known conversations, sorted by latest message timestamp.
   * @returns {Promise<Array>}
   */
  async function listConversations() {
    const keys = await store.keys('conv:');
    const results = [];

    for (const key of keys) {
      const conv = await store.get(key);
      if (!conv || !conv.phone) continue;

      // Skip tombstoned conversations
      const tombstone = await store.get(`tombstone:${conv.phone}`);
      if (tombstone) continue;

      const [lead, history, summary, quiz] = await Promise.all([
        store.get(`lead:${conv.phone}`),
        store.get(`history:${conv.phone}`),
        store.get(`summary:${conv.phone}`),
        store.get(`quiz:${conv.phone}`),
      ]);

      const messages = Array.isArray(history) ? history : [];
      const lastMsgObj = messages.length > 0 ? messages[messages.length - 1] : null;
      const lastMessageRole = lastMsgObj?.role || conv.lastMessageRole || null;

      // Determine actual latest message timestamp safely
      const latestTimestamp =
        lastMsgObj?.timestamp ||
        conv.lastMessageTimestamp ||
        conv.updatedAt ||
        conv.notifiedAt ||
        conv.claimedAt ||
        new Date(0).toISOString();

      const resolvedName = resolveContactName(conv, lead);

      // Determine live enquiry status: Closed | Consultant Requested | In Progress | Waiting for Customer | New
      let status = 'New';
      if (quiz?.consultantRequested || conv.status === 'Consultant Requested') {
        status = 'Consultant Requested';
      } else if (conv.isClosed || conv.isResolved || (quiz?.status === 'COMPLETED' && !quiz?.consultantRequested) || lead?.state === 'COMPLETE') {
        status = 'Closed';
      } else if (
        conv.state === CONV_STATE.HUMAN_TAKEOVER ||
        (quiz?.status === 'IN_PROGRESS' && quiz?.quizState !== 'AWAITING_Q1')
      ) {
        status = 'In Progress';
      } else if (lastMessageRole === 'assistant') {
        status = 'Waiting for Customer';
      } else {
        status = 'New';
      }

      const isVerifiedPhone =
        conv.isVerifiedPhone ??
        (conv.phone && conv.phone.startsWith('+') && !conv.phone.includes('@lid'));

      results.push({
        phone: conv.phone,
        state: conv.state ?? CONV_STATE.AI_ACTIVE,
        status,
        notificationSent: conv.notificationSent ?? false,
        notifiedAt: conv.notifiedAt ?? null,
        claimedBy: conv.claimedBy ?? null,
        claimedAt: conv.claimedAt ?? null,
        resumedAt: conv.resumedAt ?? null,
        customerName: resolvedName,
        pushName: conv.pushName ?? null,
        savedName: conv.savedName ?? null,
        verifiedPhone: conv.verifiedPhone ?? (isVerifiedPhone ? conv.phone : null),
        isVerifiedPhone: !!isVerifiedPhone,
        lid: conv.lid ?? null,
        jid: conv.jid ?? null,
        replyJid: conv.replyJid ?? null,
        isGroup: conv.isGroup ?? false,
        groupName: conv.groupName ?? null,
        interest: lead?.data?.interest ?? null,
        leadComplete: lead?.state === 'COMPLETE' || quiz?.status === 'COMPLETED',
        quizState: quiz?.quizState ?? null,
        quizStatus: quiz?.status ?? null,
        messageCount: messages.length,
        lastMessage: lastMsgObj?.content || conv.lastMessage || conv.summary || null,
        lastMessageAt: latestTimestamp,
        lastMessageRole,
        summary: summary ?? conv.summary ?? null,
        updatedAt: conv.updatedAt ?? latestTimestamp,
      });
    }

    // Always sorted by latest message timestamp in descending order (latest first)
    return results.sort((a, b) => {
      const timeA = new Date(a.lastMessageAt || 0).getTime();
      const timeB = new Date(b.lastMessageAt || 0).getTime();
      return timeB - timeA;
    });
  }

  return {
    getConvState,
    isAiActive,
    claimConversation,
    resumeAi,
    hasBeenNotified,
    markNotified,
    resetNotification,
    getCustomerName,
    resolveContactName,
    deleteConversation,
    deleteAllConversations,
    listConversations,
  };
}

/**
 * Check if a chat ID / phone has been locally deleted (tombstoned).
 * Used during sync to prevent deleted conversations from being resurrected.
 * @param {import('../store/interface.js').IStore} store
 * @param {string} phone
 * @param {number|string} [messageTimestamp]
 * @returns {Promise<boolean>}
 */
export async function isChatTombstoned(store, phone, messageTimestamp) {
  if (!phone) return false;
  const cleanPhone = phone.replace(/[^\d+]/g, '');

  // 1. Direct conversation tombstone
  const tombstone = await store.get(`tombstone:${cleanPhone}`);
  if (tombstone) {
    if (tombstone.deletedAt) {
      const deletedAtMs = new Date(tombstone.deletedAt).getTime();
      if (messageTimestamp) {
        const msgTimeMs = typeof messageTimestamp === 'number'
          ? (messageTimestamp > 1e11 ? messageTimestamp : messageTimestamp * 1000)
          : new Date(messageTimestamp).getTime();
        // If message is older than deletion time, it is historic sync -> skip
        if (msgTimeMs <= deletedAtMs) {
          return true;
        }
      } else {
        // If no timestamp provided, treat as tombstoned within 5 minutes
        if (Date.now() - deletedAtMs < 300000) {
          return true;
        }
      }
    } else {
      return true;
    }
  }

  // 2. Global tombstone (from Delete All Chats)
  const globalTombstone = await store.get('tombstone:global');
  if (globalTombstone?.deletedAllAt) {
    const allDeletedAtMs = new Date(globalTombstone.deletedAllAt).getTime();
    if (messageTimestamp) {
      const msgTimeMs = typeof messageTimestamp === 'number'
        ? (messageTimestamp > 1e11 ? messageTimestamp : messageTimestamp * 1000)
        : new Date(messageTimestamp).getTime();
      if (msgTimeMs <= allDeletedAtMs) {
        return true;
      }
    } else {
      if (Date.now() - allDeletedAtMs < 300000) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolves contact name with priority:
 * 1. WhatsApp push name / profile name
 * 2. Saved contact name (lead record or metadata)
 * 3. WhatsApp phone number as fallback
 * @param {object} conv
 * @param {object} [lead]
 * @returns {string}
 */
export function resolveContactName(conv = {}, lead = null) {
  if (conv.isGroup && conv.groupName && conv.groupName.trim()) {
    return conv.groupName.trim();
  }
  if (conv.pushName && typeof conv.pushName === 'string' && conv.pushName.trim()) {
    const p = conv.pushName.trim();
    if (p !== 'null' && p !== 'undefined' && p.toLowerCase() !== 'customer') {
      return p;
    }
  }
  const saved = lead?.data?.name || conv.savedName || conv.customerName;
  if (saved && typeof saved === 'string' && saved.trim()) {
    const s = saved.trim();
    if (s !== 'null' && s !== 'undefined' && s.toLowerCase() !== 'customer') {
      return s;
    }
  }
  if (conv.verifiedPhone) return conv.verifiedPhone;
  if (conv.isVerifiedPhone && conv.phone) return conv.phone;
  if (conv.phone && conv.phone.startsWith('+') && !conv.phone.includes('@lid')) {
    return conv.phone;
  }
  return 'Unresolved Contact';
}

