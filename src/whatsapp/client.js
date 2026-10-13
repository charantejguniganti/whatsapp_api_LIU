/**
 * WhatsApp Cloud API outbound client.
 *
 * Sends messages through Meta's WhatsApp Cloud API.
 * Falls back to the mock adapter when USE_MOCK_WHATSAPP is true
 * (or when credentials are absent) — NO real messages are sent.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
import config from '../config/index.js';
import logger from '../logger.js';

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v19.0';

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function mockSend(to, payload) {
  logger.info(
    { mock: true, to, type: payload.type },
    '[MOCK] WhatsApp message would be sent'
  );
  return { messageId: `mock_${Date.now()}`, status: 'sent_mock' };
}

// ---------------------------------------------------------------------------
// Real API client
// ---------------------------------------------------------------------------

/**
 * Send a raw message payload via WhatsApp Cloud API.
 *
 * @param {string} to      - Recipient phone in E.164 (no +)
 * @param {Object} payload - Message payload (text, template, etc.)
 * @returns {Promise<{messageId: string, status: string}>}
 */
async function sendMessage(to, payload) {
  if (config.USE_MOCK_WHATSAPP) {
    return mockSend(to, payload);
  }

  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    logger.error('WhatsApp credentials not configured');
    throw new Error('WhatsApp credentials not configured');
  }

  const url = `${WHATSAPP_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...payload,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    logger.error(
      { status: response.status, to },
      'WhatsApp API error'
    );
    throw new Error(`WhatsApp API error: ${response.status} ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  const messageId = data?.messages?.[0]?.id ?? 'unknown';

  logger.info({ to, messageId }, 'WhatsApp message sent');
  return { messageId, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a text message.
 *
 * @param {string} to       - Recipient phone number
 * @param {string} text     - Message body
 * @param {boolean} [preview=false] - Enable link preview
 */
export async function sendTextMessage(to, text, preview = false) {
  return sendMessage(to, {
    type: 'text',
    text: {
      body: text,
      preview_url: preview,
    },
  });
}

/**
 * Send a template message (for messages outside the 24-hour window).
 *
 * @param {string} to           - Recipient phone number
 * @param {string} templateName - Approved template name
 * @param {string} languageCode - Template language (e.g., 'en_US')
 * @param {Array}  components   - Template components
 */
export async function sendTemplateMessage(to, templateName, languageCode = 'en_US', components = []) {
  return sendMessage(to, {
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  });
}

/**
 * Check if a timestamp is within Meta's 24-hour customer service window.
 * Outside this window, only approved templates can be sent.
 *
 * @param {number} lastCustomerMessageTimestamp - Unix timestamp of last inbound message
 * @returns {boolean}
 */
export function isWithin24HourWindow(lastCustomerMessageTimestamp) {
  const windowMs = 24 * 60 * 60 * 1000;
  return Date.now() - lastCustomerMessageTimestamp * 1000 < windowMs;
}
