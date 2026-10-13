/**
 * AI Agent — orchestrates the full response pipeline.
 *
 * Pipeline:
 * 1. Check for human handover request
 * 2. Check for lead collection state
 * 3. Generate AI response using LIU knowledge base
 * 4. Return structured result
 */
import { generateReply } from './openai.js';
import { getSystemPrompt, wantsHumanHandover } from '../knowledge/liu.js';
import logger from '../logger.js';

/**
 * @typedef {Object} AgentResult
 * @property {string}  reply         - The text to send back to the customer
 * @property {boolean} handover      - True if human agent should take over
 * @property {boolean} leadCollected - True if a complete lead was captured this turn
 */

/**
 * Process an inbound customer message and produce a reply.
 *
 * @param {Object} params
 * @param {string}   params.from          - Customer's WhatsApp number (E.164)
 * @param {string}   params.message       - The customer's message text
 * @param {Array}    params.history       - Prior conversation messages [{role, content}]
 * @param {Object}   [params.leadState]   - Current partial lead data
 * @returns {Promise<AgentResult>}
 */
export async function processMessage({ from, message, history = [], leadState = null }) {
  logger.info({ from, messageLength: message.length }, 'Processing customer message');

  // 1. Human handover check
  if (wantsHumanHandover(message)) {
    logger.info({ from }, 'Human handover triggered');
    return {
      reply:
        '🙌 No problem! I\'m flagging your conversation for one of our team members right now. ' +
        'Someone will reach out to you shortly. In the meantime, feel free to email us at hello@liveitup.in.',
      handover: true,
      leadCollected: false,
    };
  }

  // 2. Generate AI response
  let reply;
  try {
    reply = await generateReply(getSystemPrompt(), history, message);
  } catch (err) {
    logger.error({ err, from }, 'AI generation failed');
    reply =
      "I'm sorry, I'm having a little trouble right now. 😔 Please try again in a moment, " +
      'or reach out to our team directly at hello@liveitup.in.';
  }

  return {
    reply,
    handover: false,
    leadCollected: false,
  };
}
