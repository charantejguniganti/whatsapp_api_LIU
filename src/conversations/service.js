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

  // ── Lead listing for dashboard ───────────────────────────────────────────

  /**
   * Return a summary list of all known conversations (for admin dashboard).
   * @returns {Promise<Array>}
   */
  async function listConversations() {
    const keys = await store.keys('conv:');
    const results = [];
    for (const key of keys) {
      const conv = await store.get(key);
      if (conv) results.push(conv);
    }
    return results.sort((a, b) =>
      (b.notifiedAt ?? b.claimedAt ?? '').localeCompare(a.notifiedAt ?? a.claimedAt ?? '')
    );
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
    listConversations,
  };
}
