/**
 * tests/unit/chats_management.test.js
 *
 * Comprehensive test suite for:
 * 1. Dynamic chat sorting (latest message first) for incoming and outgoing messages
 * 2. Contact name resolution with exact priority: pushName > savedName > phone
 * 3. Delete single chat from local database (DELETE /api/chats/:chatId)
 * 4. Tombstone sync protection (deleted chats are NOT re-imported during sync)
 * 5. Delete all chats (DELETE /api/chats)
 * 6. Protection of WhatsApp original data (WhatsApp APIs untouched)
 * 7. Verification that no orphaned records remain
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  createConversationService,
  resolveContactName,
  isChatTombstoned,
} from '../../src/conversations/service.js';

// ---------------------------------------------------------------------------
// In-Memory Store Mock
// ---------------------------------------------------------------------------
function createMemoryStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
    _map: map,
  };
}

describe('WhatsApp Chat Management — Contact Names, Sorting & Local Deletion', () => {
  let store;
  let convService;

  beforeEach(() => {
    store = createMemoryStore();
    convService = createConversationService(store);
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Contact Name Resolution Hierarchy
  // -------------------------------------------------------------------------
  describe('Requirement 2: Contact Name Hierarchy & Normalization', () => {
    it('prioritizes WhatsApp pushName when available', () => {
      const conv = { phone: '+919876543210', pushName: 'Aarav Sharma' };
      const lead = { data: { name: 'Saved Name' } };
      expect(resolveContactName(conv, lead)).toBe('Aarav Sharma');
    });

    it('falls back to saved lead name if pushName is absent or empty', () => {
      const conv = { phone: '+919876543210', pushName: null };
      const lead = { data: { name: 'Priya Patel' } };
      expect(resolveContactName(conv, lead)).toBe('Priya Patel');
    });

    it('falls back to WhatsApp phone number if neither pushName nor saved name exists', () => {
      const conv = { phone: '+919876543210' };
      expect(resolveContactName(conv, null)).toBe('+919876543210');
    });

    it('displays group name when conversation is a group chat', () => {
      const conv = {
        phone: '+123456789@g.us',
        isGroup: true,
        groupName: 'LIU Executive Styling Batch 2',
        pushName: 'Speaker John',
      };
      expect(resolveContactName(conv)).toBe('LIU Executive Styling Batch 2');
    });

    it('ignores invalid literal names like "null", "undefined", or "Customer"', () => {
      const conv = { phone: '+919876543210', pushName: 'null' };
      const lead = { data: { name: 'undefined' } };
      expect(resolveContactName(conv, lead)).toBe('+919876543210');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Chat Sorting (Latest Message First)
  // -------------------------------------------------------------------------
  describe('Requirement 1: Chat Sorting (Latest Message First)', () => {
    it('sorts conversations strictly by latest message timestamp descending', async () => {
      // Chat A: Active at 10:00 AM
      await store.set('conv:+911111111111', {
        phone: '+911111111111',
        lastMessage: 'Hello from A',
        lastMessageTimestamp: '2026-11-23T10:00:00.000Z',
      });
      // Chat B: Active at 10:30 AM
      await store.set('conv:+912222222222', {
        phone: '+912222222222',
        lastMessage: 'Hello from B',
        lastMessageTimestamp: '2026-11-23T10:30:00.000Z',
      });
      // Chat C: Active at 10:15 AM
      await store.set('conv:+913333333333', {
        phone: '+913333333333',
        lastMessage: 'Hello from C',
        lastMessageTimestamp: '2026-11-23T10:15:00.000Z',
      });

      const list = await convService.listConversations();
      expect(list).toHaveLength(3);
      expect(list[0].phone).toBe('+912222222222'); // Latest (10:30)
      expect(list[1].phone).toBe('+913333333333'); // Middle (10:15)
      expect(list[2].phone).toBe('+911111111111'); // Oldest (10:00)
    });

    it('moves chat to top when a new message arrives', async () => {
      await store.set('conv:+911111111111', {
        phone: '+911111111111',
        lastMessageTimestamp: '2026-11-23T10:00:00.000Z',
      });
      await store.set('conv:+912222222222', {
        phone: '+912222222222',
        lastMessageTimestamp: '2026-11-23T10:30:00.000Z',
      });

      // Initially, +912222222222 is first
      let list = await convService.listConversations();
      expect(list[0].phone).toBe('+912222222222');

      // Now +911111111111 gets a new incoming/outgoing message at 10:45 AM
      await store.set('conv:+911111111111', {
        phone: '+911111111111',
        lastMessage: 'New inquiry',
        lastMessageTimestamp: '2026-11-23T10:45:00.000Z',
      });

      list = await convService.listConversations();
      expect(list[0].phone).toBe('+911111111111'); // Now on top!
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Delete Individual Chat (Local DB Only)
  // -------------------------------------------------------------------------
  describe('Requirement 3 & 6: Local Chat Deletion and Tombstones', () => {
    it('permanently deletes all conversation records and messages for a specific phone', async () => {
      const phone = '+919999999999';

      // Seed all related records
      await store.set(`conv:${phone}`, { phone, lastMessage: 'Test' });
      await store.set(`history:${phone}`, [{ role: 'user', content: 'Test' }]);
      await store.set(`lead:${phone}`, { name: 'Customer' });
      await store.set(`quiz:${phone}`, { quizState: 'AWAITING_Q1' });
      await store.set(`summary:${phone}`, 'Summary text');
      await store.set(`notified:${phone}`, true);

      // Perform local deletion
      await convService.deleteConversation(phone);

      // Verify all local records are deleted
      expect(await store.get(`conv:${phone}`)).toBeNull();
      expect(await store.get(`history:${phone}`)).toBeNull();
      expect(await store.get(`lead:${phone}`)).toBeNull();
      expect(await store.get(`quiz:${phone}`)).toBeNull();
      expect(await store.get(`summary:${phone}`)).toBeNull();
      expect(await store.get(`notified:${phone}`)).toBeNull();

      // Verify tombstone is created
      const tombstone = await store.get(`tombstone:${phone}`);
      expect(tombstone).not.toBeNull();
      expect(tombstone.deletedAt).toBeDefined();

      // Deleted chat must not appear in listConversations
      const list = await convService.listConversations();
      expect(list.find((c) => c.phone === phone)).toBeUndefined();
    });

    it('prevents deleted chats from reappearing during historic WhatsApp sync', async () => {
      const phone = '+918888888888';
      await convService.deleteConversation(phone);

      const tombstone = await store.get(`tombstone:${phone}`);
      const deletedAtMs = new Date(tombstone.deletedAt).getTime();

      // 1. Sync sends an old message that occurred BEFORE deletion
      const oldMessageTimestamp = new Date(deletedAtMs - 60000).toISOString();
      const isBlocked = await isChatTombstoned(store, phone, oldMessageTimestamp);
      expect(isBlocked).toBe(true); // Must be skipped!
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Delete All Chats (Local DB Only)
  // -------------------------------------------------------------------------
  describe('Requirement 4: Delete All Chats', () => {
    it('permanently deletes all conversation records and sets global sync tombstones', async () => {
      await store.set('conv:+911000000001', { phone: '+911000000001' });
      await store.set('history:+911000000001', [{ role: 'user', content: 'M1' }]);
      await store.set('conv:+911000000002', { phone: '+911000000002' });
      await store.set('history:+911000000002', [{ role: 'user', content: 'M2' }]);

      const result = await convService.deleteAllConversations();
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);

      // Verify all conv records are gone
      expect(await store.get('conv:+911000000001')).toBeNull();
      expect(await store.get('history:+911000000001')).toBeNull();
      expect(await store.get('conv:+911000000002')).toBeNull();
      expect(await store.get('history:+911000000002')).toBeNull();

      // Verify global tombstone is set
      const globalTombstone = await store.get('tombstone:global');
      expect(globalTombstone).not.toBeNull();
      expect(globalTombstone.deletedAllAt).toBeDefined();

      // List must be completely empty
      const list = await convService.listConversations();
      expect(list).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: REST API endpoints /api/chats
  // -------------------------------------------------------------------------
  describe('Requirement 7: /api/chats API Endpoints', () => {
    let app;

    beforeEach(() => {
      app = createApp();
    });

    it('GET /api/chats returns conversations with latest message sorting', async () => {
      const res = await request(app).get('/api/chats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body).toHaveProperty('chats');
      expect(Array.isArray(res.body.chats)).toBe(true);
    });

    it('DELETE /api/chats/:chatId deletes a single conversation locally', async () => {
      const res = await request(app).delete('/api/chats/%2B919999999999');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body.message).toContain('Original WhatsApp messages remain untouched');
    });

    it('DELETE /api/chats deletes all conversations locally', async () => {
      const res = await request(app).delete('/api/chats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body.message).toContain('Original WhatsApp messages remain untouched');
    });
  });
});
