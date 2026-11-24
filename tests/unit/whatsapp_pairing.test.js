/**
 * Unit & Integration Tests for Baileys WhatsApp Connection:
 * 1. QR Code authentication status & rendering
 * 2. Pairing Code generation endpoint (/admin/whatsapp/pairing-code)
 * 3. Phone validation & formatting
 * 4. Error handling and expiry
 * 5. Dashboard modal markup verification
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import * as baileysClient from '../../src/whatsapp/baileysClient.js';
import config from '../../src/config/index.js';

describe('Baileys WhatsApp Authentication (QR & Pairing Code)', () => {
  let app;
  let adminToken;

  beforeEach(() => {
    app = createApp();
    adminToken = jwt.sign(
      { sub: 'tonishapawar', role: 'admin' },
      config.JWT_SECRET || 'test-jwt-secret-for-liu-concierge-testing-minimum-32-chars'
    );
  });

  describe('1. GET /admin/whatsapp/status', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/admin/whatsapp/status');
      expect(res.status).toBe(401);
    });

    it('returns connection status, qr code, and pairing code details when authenticated', async () => {
      const res = await request(app)
        .get('/admin/whatsapp/status')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('qr');
      expect(res.body).toHaveProperty('phone');
      expect(res.body).toHaveProperty('pairingCode');
    });
  });

  describe('2. POST /admin/whatsapp/pairing-code', () => {
    it('requires authentication', async () => {
      const res = await request(app)
        .post('/admin/whatsapp/pairing-code')
        .send({ phone: '919154018249' });

      expect(res.status).toBe(401);
    });

    it('rejects missing phone number', async () => {
      const res = await request(app)
        .post('/admin/whatsapp/pairing-code')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Phone number is required');
    });

    it('rejects invalid or too-short phone number', async () => {
      const res = await request(app)
        .post('/admin/whatsapp/pairing-code')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ phone: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('valid phone number');
    });

    it('successfully generates an 8-character pairing code when socket provides requestPairingCode', async () => {
      // Mock requestPairingCode
      const spy = vi.spyOn(baileysClient, 'requestPairingCode').mockResolvedValueOnce({
        pairingCode: 'ABC12XYZ',
        expiresAt: new Date(Date.now() + 180000).toISOString(),
        phone: '919154018249',
      });

      const res = await request(app)
        .post('/admin/whatsapp/pairing-code')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ phone: '+91 91540 18249' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.pairingCode).toBe('ABC12XYZ');
      expect(res.body.phone).toBe('919154018249');
      expect(res.body.expiresAt).toBeDefined();

      spy.mockRestore();
    });
  });

  describe('3. Dashboard WhatsApp Linking Modal UI', () => {
    it('contains both Phone Pairing Code and QR Scan connection methods in index.html', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);

      // Verify modal elements
      expect(res.text).toContain('id="whatsapp-modal"');
      expect(res.text).toContain('tab-btn-wa-phone');
      expect(res.text).toContain('tab-btn-wa-qr');
      expect(res.text).toContain('wa-pairing-phone-input');
      expect(res.text).toContain('btn-request-pairing-code');
      expect(res.text).toContain('wa-pairing-code-box');
      expect(res.text).toContain('wa-pairing-code-text');
      expect(res.text).toContain('Link with phone number instead');
      expect(res.text).toContain('id="wa-qr-img"');
    });
  });
});
