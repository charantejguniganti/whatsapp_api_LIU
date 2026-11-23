import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPnUser,
  isLidUser,
  isGroupJid,
  isBroadcastJid,
  extractVerifiedPhoneNumber,
  resolveSenderIdentity,
  saveLidPnMapping,
  resolveLidToPhone,
} from '../../src/whatsapp/identityResolver.js';
import { createMemoryStore } from '../../src/store/memory.js';
import { createConversationService, resolveContactName } from '../../src/conversations/service.js';

describe('Baileys WhatsApp Contact Identification & LID Resolution', () => {
  let store;

  beforeEach(() => {
    store = createMemoryStore();
  });

  describe('Identifier Type Classification', () => {
    it('correctly identifies @s.whatsapp.net as phone-number user', () => {
      expect(isPnUser('916305566800@s.whatsapp.net')).toBe(true);
      expect(isPnUser('108225156407425@lid')).toBe(false);
      expect(isPnUser('12345-67890@g.us')).toBe(false);
      expect(isPnUser('status@broadcast')).toBe(false);
    });

    it('correctly identifies @lid as Linked Identity', () => {
      expect(isLidUser('108225156407425@lid')).toBe(true);
      expect(isLidUser('916305566800@s.whatsapp.net')).toBe(false);
    });

    it('correctly identifies @g.us as group chat', () => {
      expect(isGroupJid('12345-67890@g.us')).toBe(true);
      expect(isGroupJid('916305566800@s.whatsapp.net')).toBe(false);
    });

    it('correctly identifies broadcasts', () => {
      expect(isBroadcastJid('status@broadcast')).toBe(true);
      expect(isBroadcastJid('newsletter@broadcast')).toBe(true);
      expect(isBroadcastJid('916305566800@s.whatsapp.net')).toBe(false);
    });
  });

  describe('Phone Number Extraction & Safeguards', () => {
    it('extracts E.164 phone number from @s.whatsapp.net JID', () => {
      expect(extractVerifiedPhoneNumber('916305566800@s.whatsapp.net')).toBe('+916305566800');
      expect(extractVerifiedPhoneNumber('916305566800:1@s.whatsapp.net')).toBe('+916305566800');
    });

    it('NEVER extracts arbitrary digits from an @lid as a phone number', () => {
      // Must return null, NOT +108225156407425 or +1232432724
      expect(extractVerifiedPhoneNumber('108225156407425@lid')).toBeNull();
      expect(extractVerifiedPhoneNumber('1232432724@lid')).toBeNull();
    });

    it('returns null for groups and broadcast JIDs', () => {
      expect(extractVerifiedPhoneNumber('12345-67890@g.us')).toBeNull();
      expect(extractVerifiedPhoneNumber('status@broadcast')).toBeNull();
    });
  });

  describe('LID to Phone Number Resolution Mechanisms', () => {
    it('resolves LID via message remoteJidAlt', async () => {
      const socket = {};
      const msg = {
        key: {
          remoteJid: '108225156407425@lid',
          remoteJidAlt: '916305566800@s.whatsapp.net',
        },
        pushName: 'Charan Tej',
      };

      const identity = await resolveSenderIdentity(socket, msg, store);
      expect(identity.isVerifiedPhone).toBe(true);
      expect(identity.verifiedPhone).toBe('+916305566800');
      expect(identity.phone).toBe('+916305566800');
      expect(identity.lid).toBe('108225156407425@lid');
      expect(identity.replyJid).toBe('108225156407425@lid');
      expect(identity.pushName).toBe('Charan Tej');

      // Check that mapping was cached
      const cached = await resolveLidToPhone(socket, store, '108225156407425@lid');
      expect(cached).toBe('+916305566800');
    });

    it('resolves LID via socket.signalRepository.lidMapping.getPNForLID', async () => {
      const socket = {
        signalRepository: {
          lidMapping: {
            getPNForLID: async (lid) => {
              if (lid === '108225156407425@lid') return '916305566800@s.whatsapp.net';
              return null;
            },
            storeLIDPNMappings: async () => {},
          },
        },
      };

      const msg = {
        key: {
          remoteJid: '108225156407425@lid',
        },
        pushName: 'Charan Tej',
      };

      const identity = await resolveSenderIdentity(socket, msg, store);
      expect(identity.isVerifiedPhone).toBe(true);
      expect(identity.verifiedPhone).toBe('+916305566800');
      expect(identity.phone).toBe('+916305566800');
    });

    it('handles unresolvable LID safely without fabricating phone number', async () => {
      const socket = {};
      const msg = {
        key: {
          remoteJid: '9999999999999@lid',
        },
        pushName: 'Anonymous User',
      };

      const identity = await resolveSenderIdentity(socket, msg, store);
      expect(identity.isVerifiedPhone).toBe(false);
      expect(identity.verifiedPhone).toBeNull();
      // Stable internal ID is the LID itself, NOT a fabricated +9999999999999 phone number
      expect(identity.phone).toBe('9999999999999@lid');
      expect(identity.pushName).toBe('Anonymous User');
    });

    it('resolves group message participant and preserves group chat ID', async () => {
      const socket = {};
      const msg = {
        key: {
          remoteJid: '12036302456789@g.us',
          participant: '916305566800@s.whatsapp.net',
        },
        pushName: 'Group Member',
      };

      const identity = await resolveSenderIdentity(socket, msg, store);
      expect(identity.isGroup).toBe(true);
      expect(identity.groupJid).toBe('12036302456789@g.us');
      expect(identity.phone).toBe('12036302456789@g.us'); // Group chat ID
      expect(identity.verifiedPhone).toBe('+916305566800');
      expect(identity.replyJid).toBe('12036302456789@g.us');
    });
  });

  describe('Contact Name Resolution Priority', () => {
    it('prioritizes pushName over phone number', () => {
      const conv = {
        phone: '+916305566800',
        pushName: 'Charan Tej',
        isVerifiedPhone: true,
      };
      expect(resolveContactName(conv)).toBe('Charan Tej');
    });

    it('falls back to saved lead name if pushName is missing', () => {
      const conv = {
        phone: '+916305566800',
        savedName: 'Charan (Saved)',
        isVerifiedPhone: true,
      };
      expect(resolveContactName(conv)).toBe('Charan (Saved)');
    });

    it('falls back to verified phone if no name exists', () => {
      const conv = {
        phone: '+916305566800',
        verifiedPhone: '+916305566800',
        isVerifiedPhone: true,
      };
      expect(resolveContactName(conv)).toBe('+916305566800');
    });

    it('returns "Unresolved Contact" for unverified LID contacts without push name', () => {
      const conv = {
        phone: '108225156407425@lid',
        lid: '108225156407425@lid',
        isVerifiedPhone: false,
      };
      expect(resolveContactName(conv)).toBe('Unresolved Contact');
    });

    it('displays groupName for group chats', () => {
      const conv = {
        phone: '12036302456789@g.us',
        isGroup: true,
        groupName: 'LIU VIP Clients',
      };
      expect(resolveContactName(conv)).toBe('LIU VIP Clients');
    });
  });

  describe('Live Dashboard Enquiries & Status Tracking', () => {
    it('computes accurate enquiry statuses and stats across conversations', async () => {
      const convService = createConversationService(store);

      // Conv 1: New Enquiry (user message, quiz Q1)
      await store.set('conv:+919876543210', {
        phone: '+919876543210',
        lastMessageRole: 'user',
        updatedAt: new Date().toISOString(),
      });
      await store.set('quiz:+919876543210', {
        status: 'IN_PROGRESS',
        quizState: 'AWAITING_Q1',
      });

      // Conv 2: In Progress (human takeover)
      await store.set('conv:+919876543211', {
        phone: '+919876543211',
        state: 'HUMAN_TAKEOVER',
        lastMessageRole: 'user',
        updatedAt: new Date().toISOString(),
      });

      // Conv 3: Waiting for Customer (assistant replied)
      await store.set('conv:+919876543212', {
        phone: '+919876543212',
        state: 'AI_ACTIVE',
        lastMessageRole: 'assistant',
        updatedAt: new Date().toISOString(),
      });

      // Conv 4: Closed (quiz completed)
      await store.set('conv:+919876543213', {
        phone: '+919876543213',
        state: 'AI_ACTIVE',
        lastMessageRole: 'assistant',
        updatedAt: new Date().toISOString(),
      });
      await store.set('quiz:+919876543213', {
        status: 'COMPLETED',
        quizState: 'COMPLETED',
      });

      const convs = await convService.listConversations();
      expect(convs).toHaveLength(4);

      const newEnquiries = convs.filter((c) => c.status === 'New').length;
      const inProgress = convs.filter((c) => c.status === 'In Progress').length;
      const waiting = convs.filter((c) => c.status === 'Waiting for Customer').length;
      const closed = convs.filter((c) => c.status === 'Closed').length;

      expect(newEnquiries).toBe(1);
      expect(inProgress).toBe(1);
      expect(waiting).toBe(1);
      expect(closed).toBe(1);
    });
  });
});
