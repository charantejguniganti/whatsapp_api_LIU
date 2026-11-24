import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import * as pushStore from '../../src/push/pushStore.js';
import * as pushService from '../../src/push/pushService.js';
import { createQuestionnaireManager } from '../../src/questionnaire/stateManager.js';
import { createSessionRepository } from '../../src/questionnaire/sessionRepository.js';
import { getStore, resetStore } from '../../src/store/index.js';
import config from '../../src/config/index.js';

describe('LIU Consultant Mobile Push Notifications', () => {
  let app;
  let store;

  beforeEach(async () => {
    resetStore();
    store = await getStore();
    app = createApp();
  });

  describe('1. Push API Endpoints', () => {
    it('GET /api/push/vapid-public-key returns the public key without leaking private key', async () => {
      const res = await request(app).get('/api/push/vapid-public-key');
      expect(res.status).toBe(200);
      expect(res.body.publicKey).toBeDefined();
      expect(res.body.publicKey).toBe(config.VAPID_PUBLIC_KEY);
      expect(res.body.privateKey).toBeUndefined();
      expect(res.text).not.toContain(config.VAPID_PRIVATE_KEY);
    });

    it('POST /api/push/subscribe saves subscription and POST /api/push/unsubscribe removes it', async () => {
      const dummySub = {
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/test-endpoint-123',
        keys: {
          p256dh: 'BC9XYZ...',
          auth: 'authSecret123'
        }
      };

      const subRes = await request(app)
        .post('/api/push/subscribe')
        .send({ subscription: dummySub, options: { consultantOnly: true } });

      expect(subRes.status).toBe(200);
      expect(subRes.body.success).toBe(true);

      const activeSubs = await pushStore.getAllSubscriptions();
      expect(activeSubs.length).toBe(1);
      expect(activeSubs[0].endpoint).toBe(dummySub.endpoint);

      // Unsubscribe
      const unsubRes = await request(app)
        .post('/api/push/unsubscribe')
        .send({ endpoint: dummySub.endpoint });

      expect(unsubRes.status).toBe(200);
      expect(unsubRes.body.success).toBe(true);

      const remainingSubs = await pushStore.getAllSubscriptions();
      expect(remainingSubs.length).toBe(0);
    });

    it('GET /api/push/settings and POST /api/push/settings update preferences', async () => {
      const getRes = await request(app).get('/api/push/settings');
      expect(getRes.status).toBe(200);
      expect(getRes.body.settings.enabled).toBe(true);

      const updateRes = await request(app)
        .post('/api/push/settings')
        .send({ enabled: true, consultantOnly: false });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.settings.consultantOnly).toBe(false);
    });

    it('POST /api/push/test executes without crashing when no subscribers exist', async () => {
      const res = await request(app).post('/api/push/test');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sent).toBe(0);
    });
  });

  describe('2. Consultant Handoff Notification Triggers & Deduplication', () => {
    it('Customer says "Yes" to consultant handoff question -> flags isConsultantRequest: true', async () => {
      const manager = createQuestionnaireManager(store);
      const repo = createSessionRepository(store);
      const phone = '919876543210';

      // 1. Setup session in COMPLETED state (questionnaire finished, final handoff question sent)
      await repo.saveSession(phone, {
        whatsappNumber: phone,
        status: 'COMPLETED',
        quizState: 'ANALYSING',
        answers: {},
        otherResponses: {},
        createdAt: new Date().toISOString(),
      });

      // 2. Customer replies with an affirmative answer
      const result = await manager.processMessage(phone, 'Yes, please connect me with a consultant');

      expect(result).toBeDefined();
      expect(result.isConsultantRequest).toBe(true);
      expect(result.consultantRequested).toBe(true);
      expect(result.reply).toContain('Our team will contact you soon');

      // Check session marked as consultantRequested in repository
      const updatedSession = await repo.getSession(phone);
      expect(updatedSession.consultantRequested).toBe(true);
      expect(updatedSession.consultantRequestedAt).toBeDefined();
    });

    it('Customer says "Yes" to an unrelated question during active quiz -> NO consultant notification flag', async () => {
      const manager = createQuestionnaireManager(store);
      const repo = createSessionRepository(store);
      const phone = '919876543211';

      // Active quiz session at Question 1
      await repo.saveSession(phone, {
        whatsappNumber: phone,
        status: 'IN_PROGRESS',
        quizState: 'AWAITING_Q1',
        answers: {},
        otherResponses: {},
        createdAt: new Date().toISOString(),
      });

      // Customer sends "Yes" (not the consultant handoff question)
      const result = await manager.processMessage(phone, 'Yes');

      expect(result?.isConsultantRequest).toBeFalsy();
    });

    it('Customer says "No" or unrelated text after questionnaire -> NO consultant notification flag', async () => {
      const manager = createQuestionnaireManager(store);
      const repo = createSessionRepository(store);
      const phone = '919876543212';

      await repo.saveSession(phone, {
        whatsappNumber: phone,
        status: 'COMPLETED',
        quizState: 'ANALYSING',
        answers: {},
        otherResponses: {},
        createdAt: new Date().toISOString(),
      });

      const result = await manager.processMessage(phone, 'No, thank you, I will think about it');

      expect(result).toBeNull();
      const updatedSession = await repo.getSession(phone);
      expect(updatedSession.consultantRequested).toBeFalsy();
    });

    it('Customer sends repeated affirmative messages -> deduplicated, does NOT trigger duplicate', async () => {
      const manager = createQuestionnaireManager(store);
      const repo = createSessionRepository(store);
      const phone = '919876543213';

      await repo.saveSession(phone, {
        whatsappNumber: phone,
        status: 'COMPLETED',
        quizState: 'ANALYSING',
        answers: {},
        otherResponses: {},
        createdAt: new Date().toISOString(),
      });

      // First affirmative message
      const firstResult = await manager.processMessage(phone, 'Yes, connect me');
      expect(firstResult.isConsultantRequest).toBe(true);

      // Second affirmative message from same user
      const secondResult = await manager.processMessage(phone, 'Yes please');
      expect(secondResult.isConsultantRequest).toBe(false);
      expect(secondResult.consultantRequested).toBe(true);
    });

    it('notifyConsultantRequest correctly records event and creates correct notification payload', async () => {
      const phone = '919876543214';
      const name = 'Karan Patel';

      const notifyRes = await pushService.notifyConsultantRequest({
        phone,
        name,
        message: 'Yes, I would like someone to contact me',
        timestamp: new Date().toISOString()
      });

      expect(notifyRes.triggered).toBe(true);
      expect(notifyRes.eventId).toBeDefined();

      const eventRecord = await store.get(`push:event:${notifyRes.eventId}`);
      expect(eventRecord).toBeDefined();
      expect(eventRecord.payload.title).toBe('🔔 New LIU Consultant Request');
      expect(eventRecord.payload.body).toContain(name);
      expect(eventRecord.payload.body).toContain('wants to speak with an LIU consultant');
      expect(eventRecord.payload.data.phone).toBe(phone);
      expect(eventRecord.payload.data.url).toContain(phone);

      // Attempt duplicate call immediately
      const dupRes = await pushService.notifyConsultantRequest({
        phone,
        name,
        message: 'Yes please',
        timestamp: new Date().toISOString()
      });

      expect(dupRes.duplicate).toBe(true);
      expect(dupRes.triggered).toBe(false);
    });
  });

  describe('3. Dashboard UI Settings & Modal Integration', () => {
    it('GET / serves Dashboard UI containing Push Notification Modal and Controls', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('settings-modal');
      expect(res.text).toContain('toggle-push-enabled');
      expect(res.text).toContain('toggle-consultant-alerts');
      expect(res.text).toContain('btn-test-push');
      expect(res.text).toContain('openSettingsModal');
      expect(res.text).toContain('urlB64ToUint8Array');
      expect(res.text).toContain('subscribeToPushNotifications');
      expect(res.text).toContain('SELECT_CONVERSATION');
    });
  });
});
