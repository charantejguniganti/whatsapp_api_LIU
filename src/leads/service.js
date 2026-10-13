/**
 * Lead capture service.
 *
 * Manages the multi-turn conversation flow for collecting a lead.
 * State is persisted in the store under the key `lead:<phone>`.
 */
import { LeadSchema } from './schema.js';
import logger from '../logger.js';

/**
 * Lead conversation states
 */
export const LEAD_STATE = {
  IDLE: 'IDLE',
  AWAITING_NAME: 'AWAITING_NAME',
  AWAITING_INTEREST: 'AWAITING_INTEREST',
  AWAITING_CONTACT_TIME: 'AWAITING_CONTACT_TIME',
  AWAITING_CONSENT: 'AWAITING_CONSENT',
  COMPLETE: 'COMPLETE',
};

/**
 * @param {import('../store/interface.js').IStore} store
 */
export function createLeadService(store) {
  /**
   * Get the current lead state for a phone number.
   * @param {string} phone
   * @returns {Promise<Object|null>}
   */
  async function getLeadState(phone) {
    return store.get(`lead:${phone}`);
  }

  /**
   * Save / update lead state.
   * @param {string} phone
   * @param {Object} state
   */
  async function saveLeadState(phone, state) {
    await store.set(`lead:${phone}`, state);
  }

  /**
   * Check if a message looks like agreement/consent.
   * @param {string} text
   * @returns {boolean}
   */
  function isConsent(text) {
    const lower = text.toLowerCase().trim();
    return ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'of course', 'please', 'go ahead'].some(
      (w) => lower.startsWith(w)
    );
  }

  /**
   * Start the lead collection flow.
   * @param {string} phone
   * @returns {Promise<string>} First question to ask
   */
  async function startLeadCollection(phone) {
    await saveLeadState(phone, {
      phone,
      state: LEAD_STATE.AWAITING_NAME,
      data: {},
    });
    return "May I take your details so our team can follow up? 😊\n\nFirst, could you share your *name*?";
  }

  /**
   * Process the next message in the lead collection flow.
   *
   * @param {string} phone
   * @param {string} message
   * @returns {Promise<{reply: string, complete: boolean, lead: Object|null}>}
   */
  async function processLeadMessage(phone, message) {
    const current = await getLeadState(phone);

    if (!current || current.state === LEAD_STATE.IDLE || current.state === LEAD_STATE.COMPLETE) {
      return { reply: null, complete: false, lead: null };
    }

    const { state, data } = current;

    if (state === LEAD_STATE.AWAITING_NAME) {
      data.name = message.trim();
      await saveLeadState(phone, { phone, state: LEAD_STATE.AWAITING_INTEREST, data });
      return {
        reply: `Great to meet you, *${data.name}*! 🎉\n\nWhat type of event or service are you interested in?`,
        complete: false,
        lead: null,
      };
    }

    if (state === LEAD_STATE.AWAITING_INTEREST) {
      data.interest = message.trim();
      await saveLeadState(phone, { phone, state: LEAD_STATE.AWAITING_CONTACT_TIME, data });
      return {
        reply: `Wonderful! And when would be a good time for our team to contact you?\n_(e.g., weekday mornings, after 6 PM, anytime)_`,
        complete: false,
        lead: null,
      };
    }

    if (state === LEAD_STATE.AWAITING_CONTACT_TIME) {
      data.preferredContactTime = message.trim();
      await saveLeadState(phone, { phone, state: LEAD_STATE.AWAITING_CONSENT, data });
      return {
        reply:
          `Perfect! Just to confirm — may I share your details with the Live It Up team so they can reach out to you? _(Yes / No)_`,
        complete: false,
        lead: null,
      };
    }

    if (state === LEAD_STATE.AWAITING_CONSENT) {
      if (!isConsent(message)) {
        await saveLeadState(phone, { phone, state: LEAD_STATE.COMPLETE, data });
        return {
          reply:
            "No problem at all! 😊 Feel free to reach out whenever you're ready. We're always here at hello@liveitup.in.",
          complete: false,
          lead: null,
        };
      }

      data.consentGiven = true;
      data.capturedAt = new Date().toISOString();
      data.source = 'whatsapp';

      const parseResult = LeadSchema.safeParse({ ...data, phone });
      if (!parseResult.success) {
        logger.warn({ errors: parseResult.error.flatten(), phone }, 'Lead validation failed');
        await saveLeadState(phone, { phone, state: LEAD_STATE.COMPLETE, data });
        return {
          reply: 'Thank you! Our team will be in touch soon. 🙌',
          complete: true,
          lead: null,
        };
      }

      const lead = parseResult.data;
      await saveLeadState(phone, { phone, state: LEAD_STATE.COMPLETE, data: lead });

      logger.info({ phone, interest: lead.interest }, 'Lead captured');

      // Persist the completed lead
      await store.set(`completedLead:${phone}:${Date.now()}`, lead);

      return {
        reply:
          `Thank you, *${lead.name}*! 🌟 Our team will reach out at your preferred time regarding *${lead.interest}*. ` +
          `We're excited to work with you! Meanwhile, feel free to ask me anything else. 😊`,
        complete: true,
        lead,
      };
    }

    return { reply: null, complete: false, lead: null };
  }

  /**
   * Check if the customer is currently in an active lead flow.
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async function isInLeadFlow(phone) {
    const current = await getLeadState(phone);
    return (
      current !== null &&
      current.state !== LEAD_STATE.IDLE &&
      current.state !== LEAD_STATE.COMPLETE
    );
  }

  return {
    startLeadCollection,
    processLeadMessage,
    isInLeadFlow,
    getLeadState,
  };
}
