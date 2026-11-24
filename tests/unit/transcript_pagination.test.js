/**
 * Tests for Transcript Pagination & History Loading Logic
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { resetStore, getStore } from '../../src/store/index.js';
import config from '../../src/config/index.js';

describe('Transcript Pagination & History API', () => {
  let app;
  let token;
  let store;
  const testPhone = '+919999988888';

  beforeEach(async () => {
    resetStore();
    store = await getStore();
    token = jwt.sign(
      { sub: 'tonishapawar', role: 'admin' },
      config.JWT_SECRET || 'test-jwt-secret-for-liu-concierge-testing-minimum-32-chars'
    );
    app = createApp();

    // Populate conversation with 35 messages
    const sampleHistory = [];
    for (let i = 1; i <= 35; i++) {
      sampleHistory.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Message number ${i}`,
        timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      });
    }

    await store.set(`conv:${testPhone}`, {
      phone: testPhone,
      updatedAt: new Date().toISOString(),
    });
    await store.set(`history:${testPhone}`, sampleHistory);
  });

  it('returns full history and totalMessages when no limit is specified (backward compatibility)', async () => {
    const res = await request(app)
      .get(`/admin/leads/${encodeURIComponent(testPhone)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(35);
    expect(res.body.totalMessages).toBe(35);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.history[0].content).toBe('Message number 1');
    expect(res.body.history[34].content).toBe('Message number 35');
  });

  it('returns newest messages when limit=10 and offset=0 with hasMore=true', async () => {
    const res = await request(app)
      .get(`/admin/leads/${encodeURIComponent(testPhone)}?limit=10&offset=0`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(10);
    expect(res.body.totalMessages).toBe(35);
    expect(res.body.hasMore).toBe(true);
    // Chronological newest 10 messages: 26 through 35
    expect(res.body.history[0].content).toBe('Message number 26');
    expect(res.body.history[9].content).toBe('Message number 35');
  });

  it('returns older batch when offset=10 and limit=10', async () => {
    const res = await request(app)
      .get(`/admin/leads/${encodeURIComponent(testPhone)}?limit=10&offset=10`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(10);
    expect(res.body.totalMessages).toBe(35);
    expect(res.body.hasMore).toBe(true);
    // Messages 16 through 25
    expect(res.body.history[0].content).toBe('Message number 16');
    expect(res.body.history[9].content).toBe('Message number 25');
  });

  it('returns oldest remaining messages with hasMore=false when offset covers all earlier history', async () => {
    const res = await request(app)
      .get(`/admin/leads/${encodeURIComponent(testPhone)}?limit=10&offset=30`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Only 5 messages remain at the beginning (1 through 5)
    expect(res.body.history).toHaveLength(5);
    expect(res.body.totalMessages).toBe(35);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.history[0].content).toBe('Message number 1');
    expect(res.body.history[4].content).toBe('Message number 5');
  });

  it('handles empty conversation history safely', async () => {
    const emptyPhone = '+919999900000';
    const res = await request(app)
      .get(`/admin/leads/${encodeURIComponent(emptyPhone)}?limit=20&offset=0`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
    expect(res.body.totalMessages).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });
});
