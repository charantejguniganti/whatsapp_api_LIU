/**
 * Integration tests: WhatsApp webhook endpoint
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import { createApp } from '../../src/app.js';
import { resetStore } from '../../src/store/index.js';

const APP_SECRET = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

function signBody(body, secret = APP_SECRET) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

/** Build a minimal Meta webhook payload for a text message */
function buildWebhookPayload(from, text, messageId = 'wamid.test123') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry_id',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone_id_123' },
              messages: [
                {
                  from,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('GET /webhook — verification', () => {
  let app;

  beforeEach(() => {
    app = createApp();
    resetStore();
  });

  it('responds with challenge for valid verify token', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'test_challenge_string',
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe('test_challenge_string');
  });

  it('returns 403 for wrong verify token', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong_token',
      'hub.challenge': 'challenge',
    });

    expect(res.status).toBe(403);
  });

  it('returns 403 for wrong mode', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'challenge',
    });

    expect(res.status).toBe(403);
  });
});

describe('POST /webhook — message handling', () => {
  let app;

  beforeEach(() => {
    app = createApp();
    resetStore();
  });

  it('returns 200 for a valid signed message', async () => {
    const payload = buildWebhookPayload('+919876543210', 'Hello LIU!', 'msg_001');
    const bodyStr = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(bodyStr))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 401 for invalid signature when secret is set', async () => {
    const payload = buildWebhookPayload('+919876543210', 'Hello', 'msg_002');

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=invalid_signature')
      .send(payload);

    expect(res.status).toBe(401);
  });

  it('returns 200 for non-message events (status updates)', async () => {
    const statusPayload = { object: 'whatsapp_business_account', entry: [] };
    const bodyStr = JSON.stringify(statusPayload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(bodyStr))
      .send(statusPayload);

    expect(res.status).toBe(200);
  });

  it('handles duplicate message IDs gracefully (deduplication)', async () => {
    const payload = buildWebhookPayload('+919876543211', 'Duplicate test', 'msg_dedup_001');
    const bodyStr = JSON.stringify(payload);

    // First request
    const res1 = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(bodyStr))
      .send(payload);

    // Second request with same message ID
    const res2 = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(bodyStr))
      .send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
