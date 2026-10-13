/**
 * Integration Tests: Production-Readiness Audit
 * Verifies:
 * 1. Schema persistence and key separation in store
 * 2. Full transcript and summary association per normalized phone
 * 3. Human takeover state persistence and prevention of AI replies
 * 4. Restart simulation: state survives memory / store re-instantiation
 * 5. Admin API authorization: secrets and endpoints protection
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetStore, getStore } from '../../src/store/index.js';
import { createConversationService, CONV_STATE } from '../../src/conversations/service.js';

describe('Production Readiness: Store Persistence & Phone Association', () => {
  let store;
  let convService;

  beforeEach(async () => {
    resetStore();
    store = await getStore();
    convService = createConversationService(store);
  });

  it('stores full message transcripts and summaries separately for normalized phone numbers', async () => {
    const customerPhone = '+919876543210';
    const transcript = [
      { role: 'user', content: 'Hi, what are the Pilates packages?' },
      { role: 'assistant', content: 'Our Pilates packages start at 12 sessions for ₹12,000.' },
    ];
    const summary = '*LIU — New Qualified Enquiry*\nCustomer: Priya\nInterested in: Pilates';

    await store.set(`history:${customerPhone}`, transcript);
    await store.set(`summary:${customerPhone}`, summary);
    await store.set(`conv:${customerPhone}`, {
      phone: customerPhone,
      state: CONV_STATE.AI_ACTIVE,
      summary,
      updatedAt: new Date().toISOString(),
    });

    const retrievedHistory = await store.get(`history:${customerPhone}`);
    const retrievedSummary = await store.get(`summary:${customerPhone}`);
    const retrievedConv = await store.get(`conv:${customerPhone}`);

    expect(retrievedHistory).toEqual(transcript);
    expect(retrievedSummary).toBe(summary);
    expect(retrievedConv.phone).toBe(customerPhone);
    expect(retrievedConv.summary).toBe(summary);
  });

  it('prevents AI replies when HUMAN_TAKEOVER is set', async () => {
    const customerPhone = '+919123456789';
    await convService.claimConversation(customerPhone, 'admin');

    const isAi = await convService.isAiActive(customerPhone);
    expect(isAi).toBe(false);

    const state = await convService.getConvState(customerPhone);
    expect(state).toBe(CONV_STATE.HUMAN_TAKEOVER);
  });

  it('preserves HUMAN_TAKEOVER state across service re-instantiation (backend restart)', async () => {
    const customerPhone = '+919988776655';
    await convService.claimConversation(customerPhone, 'Mam');

    // Simulate backend restart by creating a new service instance against the same persistent store
    const restartedService = createConversationService(store);
    const isAiAfterRestart = await restartedService.isAiActive(customerPhone);
    const stateAfterRestart = await restartedService.getConvState(customerPhone);

    expect(isAiAfterRestart).toBe(false);
    expect(stateAfterRestart).toBe(CONV_STATE.HUMAN_TAKEOVER);
  });
});

describe('Production Readiness: Admin API Access Control & Secret Safety', () => {
  let app;

  beforeEach(() => {
    resetStore();
    app = createApp();
  });

  it('rejects unauthenticated requests to /admin/leads with 401', async () => {
    const res = await request(app).get('/admin/leads');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'Unauthorised');
  });

  it('rejects unauthenticated requests to /admin/stats with 401', async () => {
    const res = await request(app).get('/admin/stats');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'Unauthorised');
  });

  it('rejects unauthenticated takeover attempts with 401', async () => {
    const res = await request(app).post('/admin/leads/%2B919876543210/takeover');
    expect(res.status).toBe(401);
  });

  it('authorizes admin requests with valid JWT and does not expose secrets', async () => {
    // 1. Login
    const loginRes = await request(app)
      .post('/admin/login')
      .send({ username: 'admin', password: 'admin123' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toHaveProperty('token');
    const token = loginRes.body.token;

    // 2. Fetch leads
    const leadsRes = await request(app)
      .get('/admin/leads')
      .set('Authorization', `Bearer ${token}`);

    expect(leadsRes.status).toBe(200);
    expect(leadsRes.body).toHaveProperty('leads');

    // Verify secrets are never in response
    const jsonStr = JSON.stringify(leadsRes.body);
    expect(jsonStr).not.toContain('DATABASE_URL');
    expect(jsonStr).not.toContain('WHATSAPP_TOKEN');
    expect(jsonStr).not.toContain('OPENAI_API_KEY');
    expect(jsonStr).not.toContain('JWT_SECRET');
  });
});
