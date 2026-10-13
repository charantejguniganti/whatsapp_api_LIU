/**
 * Integration tests: /simulate endpoint
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetStore } from '../../src/store/index.js';

describe('POST /simulate', () => {
  let app;

  beforeEach(() => {
    app = createApp();
    resetStore();
  });

  it('returns a reply for a valid message', async () => {
    const res = await request(app).post('/simulate').send({
      from: '+919000000001',
      message: 'Hello, tell me about LIU',
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reply');
    expect(typeof res.body.reply).toBe('string');
    expect(res.body.reply.length).toBeGreaterThan(0);
    expect(res.body.mock).toBe(true);
  });

  it('returns handover=true when customer asks for a human', async () => {
    const res = await request(app).post('/simulate').send({
      from: '+919000000002',
      message: 'I want to speak to a real person',
    });

    expect(res.status).toBe(200);
    expect(res.body.handover).toBe(true);
  });

  it('returns 400 for missing message', async () => {
    const res = await request(app).post('/simulate').send({
      from: '+919000000003',
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 for empty message', async () => {
    const res = await request(app).post('/simulate').send({
      from: '+919000000004',
      message: '',
    });

    expect(res.status).toBe(400);
  });

  it('handles pricing questions via mock AI', async () => {
    const res = await request(app).post('/simulate').send({
      from: '+919000000005',
      message: 'How much does a corporate event cost?',
    });

    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/price|cost|quote|budget|₹|custom/i);
  });

  it('clears history when clearHistory=true', async () => {
    const from = '+919000000006';

    // First message to build history
    await request(app).post('/simulate').send({ from, message: 'Hello' });

    // Second message clearing history
    const res = await request(app).post('/simulate').send({
      from,
      message: 'Start fresh',
      clearHistory: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBeTruthy();
  });

  it('uses default from number when not provided', async () => {
    const res = await request(app).post('/simulate').send({
      message: 'Hi there',
    });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe('+910000000000');
  });
});
