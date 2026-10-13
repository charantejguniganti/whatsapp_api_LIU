/**
 * WhatsApp webhook payload parser.
 *
 * Extracts structured data from Meta's webhook payload format.
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

/**
 * @typedef {Object} ParsedMessage
 * @property {string}  from        - Sender's phone number (E.164 without +)
 * @property {string}  messageId   - Unique message ID for deduplication
 * @property {string}  text        - Message text content
 * @property {string}  type        - Message type (text, image, etc.)
 * @property {number}  timestamp   - Unix timestamp
 * @property {string}  phoneNumberId - The WhatsApp Business phone number ID
 */

/**
 * Parse a raw Meta webhook body and extract text messages.
 *
 * @param {Object} body - Parsed JSON webhook body
 * @returns {ParsedMessage[]}
 */
export function parseWebhookMessages(body) {
  const messages = [];

  if (body?.object !== 'whatsapp_business_account') {
    return messages;
  }

  const entries = body?.entry ?? [];

  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      if (change?.field !== 'messages') continue;

      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? '';
      const incomingMessages = value?.messages ?? [];

      for (const msg of incomingMessages) {
        if (msg?.type !== 'text') {
          // For now, we only handle text messages
          continue;
        }

        messages.push({
          from: msg.from,
          messageId: msg.id,
          text: msg?.text?.body ?? '',
          type: msg.type,
          timestamp: parseInt(msg.timestamp, 10),
          phoneNumberId,
        });
      }
    }
  }

  return messages;
}

/**
 * Check if a webhook body is a valid WhatsApp Business Account event.
 * @param {Object} body
 * @returns {boolean}
 */
export function isValidWebhookBody(body) {
  return body?.object === 'whatsapp_business_account' && Array.isArray(body?.entry);
}
