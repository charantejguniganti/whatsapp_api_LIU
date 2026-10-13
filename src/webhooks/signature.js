/**
 * Meta WhatsApp webhook signature verifier.
 *
 * Meta signs POST webhook payloads with HMAC-SHA256 using the app secret.
 * The signature is sent in the X-Hub-Signature-256 header as:
 *   sha256=<hex_digest>
 *
 * Reference: https://developers.facebook.com/docs/messenger-platform/webhooks#validate-payloads
 */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 *
 * @param {string} rawBody      - The raw request body as a string (must be captured before JSON parsing)
 * @param {string} signature    - The value of the X-Hub-Signature-256 header
 * @param {string} appSecret    - The Meta app secret
 * @returns {boolean}
 */
export function verifySignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return false;

  const expected = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!expected) return false;

  const digest = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  try {
    return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    // Buffer lengths differ — invalid signature
    return false;
  }
}
