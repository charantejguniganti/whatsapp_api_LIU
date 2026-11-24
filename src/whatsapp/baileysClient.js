/**
 * Baileys WhatsApp Web Client Manager
 *
 * Connects to WhatsApp Web using Multi-Device Protocol.
 * Emits QR code as base64 data URL for scanning in the admin dashboard.
 * Intercepts incoming messages, executes Liv AI, handles Mam human takeover,
 * and records transcripts to Neon PostgreSQL.
 */
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { getStore } from '../store/index.js';
import { usePostgresAuthState } from './baileysAuth.js';
import { processMessage } from '../ai/agent.js';
import { createLeadService } from '../leads/service.js';
import {
  createConversationService,
  classifyMessage,
  buildEnquirySummary,
  MESSAGE_CLASS,
  isChatTombstoned,
} from '../conversations/service.js';
import { createQuestionnaireManager } from '../questionnaire/stateManager.js';
import * as pushService from '../push/pushService.js';
import {
  resolveSenderIdentity,
  handleContactsSync,
  saveLidPnMapping,
  isPnUser,
  isLidUser,
  extractVerifiedPhoneNumber,
} from './identityResolver.js';
import logger from '../logger.js';
import config from '../config/index.js';

let sock = null;
let currentQr = null; // data URL of QR code
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'qr_ready'
let connectedPhone = null;
let isStarting = false;

// Pairing code state
let currentPairingCode = null;
let pairingCodeExpiresAt = null;
let pairingPhoneNumber = null;

export function getBaileysStatus() {
  // If pairing code expired, clear it
  if (pairingCodeExpiresAt && Date.now() > pairingCodeExpiresAt) {
    currentPairingCode = null;
    pairingCodeExpiresAt = null;
    pairingPhoneNumber = null;
  }

  return {
    status: connectionStatus,
    qr: currentQr,
    phone: connectedPhone,
    pairingCode: currentPairingCode,
    pairingCodeExpiresAt: pairingCodeExpiresAt ? new Date(pairingCodeExpiresAt).toISOString() : null,
    pairingPhoneNumber: pairingPhoneNumber,
  };
}

/**
 * Request a Baileys Pairing Code for phone number linking.
 * Formats phone number and queries active socket for 8-character pairing code.
 * Reuses existing connection or starts socket if disconnected.
 *
 * @param {string} phoneNumber - Full phone number with country code (e.g. "+91 91540 18249")
 * @returns {Promise<{ pairingCode: string, expiresAt: string, phone: string }>}
 */
export async function requestPairingCode(phoneNumber) {
  if (!phoneNumber) {
    throw new Error('Phone number is required for pairing code authentication');
  }

  // Sanitize phone: keep only digits
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15) {
    throw new Error('Please enter a valid phone number with country code (e.g. 919154018249)');
  }

  // If already connected, do not request pairing code
  if (sock && connectionStatus === 'connected') {
    throw new Error(`WhatsApp is already connected to ${connectedPhone || 'another phone'}`);
  }

  // Ensure socket is running and ready for pairing code
  if (!sock || connectionStatus === 'disconnected') {
    await initBaileys(true);
  }

  // Wait a short moment for socket to initialize event listeners if just starting
  let attempts = 0;
  while ((!sock || !sock.requestPairingCode) && attempts < 20) {
    await new Promise((r) => setTimeout(r, 250));
    attempts++;
  }

  if (!sock || typeof sock.requestPairingCode !== 'function') {
    throw new Error('Baileys socket is not ready to generate a pairing code. Please try again.');
  }

  try {
    logger.info({ phone: cleanPhone }, 'Requesting Baileys pairing code...');
    const code = await sock.requestPairingCode(cleanPhone);
    currentPairingCode = code;
    // Pairing codes typically expire in 2-3 minutes
    pairingCodeExpiresAt = Date.now() + 180 * 1000;
    pairingPhoneNumber = cleanPhone;
    logger.info({ code, phone: cleanPhone }, '✅ Baileys pairing code generated successfully');

    return {
      pairingCode: code,
      expiresAt: new Date(pairingCodeExpiresAt).toISOString(),
      phone: cleanPhone,
    };
  } catch (err) {
    logger.error({ err, phone: cleanPhone }, 'Failed to request Baileys pairing code');
    throw new Error(`Failed to generate pairing code: ${err.message || 'WhatsApp error'}`);
  }
}

export async function initBaileys(forceRestart = false) {
  if (isStarting && !forceRestart) return;
  if (sock && connectionStatus === 'connected' && !forceRestart) return;

  // If force restart requested and socket exists, cleanly close previous socket
  if (forceRestart && sock) {
    try {
      currentQr = null;
      currentPairingCode = null;
      pairingCodeExpiresAt = null;
      pairingPhoneNumber = null;
      sock.end?.();
    } catch (e) {
      // ignore
    }
    sock = null;
  }

  isStarting = true;
  connectionStatus = 'connecting';
  currentQr = null;

  try {
    const store = await getStore();
    const { state, saveCreds, clearAuth } = await usePostgresAuthState(store);
    const { version } = await fetchLatestBaileysVersion();

    logger.info({ version }, 'Starting Baileys WhatsApp client...');

    const createSocket = typeof makeWASocket === 'function' ? makeWASocket : makeWASocket.default;
    sock = createSocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: logger.child({ module: 'baileys' }, { level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQr = await QRCode.toDataURL(qr);
          connectionStatus = 'qr_ready';
          logger.info('WhatsApp QR Code generated for dashboard scanning');
        } catch (err) {
          logger.error({ err }, 'Failed to render QR Code');
        }
      }

      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed');

        connectionStatus = 'disconnected';
        currentQr = null;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.info('WhatsApp account logged out. Clearing saved credentials.');
          await clearAuth();
        }

        if (shouldReconnect) {
          setTimeout(() => initBaileys(true), 5000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQr = null;
        currentPairingCode = null;
        pairingCodeExpiresAt = null;
        pairingPhoneNumber = null;
        connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : null;
        logger.info({ phone: connectedPhone }, '✅ WhatsApp Web linked successfully!');
      }
    });

    // ── Contacts sync events (contacts.upsert, contacts.update, messaging-history.set) ──
    sock.ev.on('contacts.upsert', async (contacts) => {
      try {
        await handleContactsSync(store, sock, contacts);
      } catch (err) {
        logger.debug({ err }, 'Error handling contacts.upsert');
      }
    });

    sock.ev.on('contacts.update', async (updates) => {
      try {
        await handleContactsSync(store, sock, updates);
      } catch (err) {
        logger.debug({ err }, 'Error handling contacts.update');
      }
    });

    sock.ev.on('messaging-history.set', async ({ contacts }) => {
      try {
        if (contacts) await handleContactsSync(store, sock, contacts);
      } catch (err) {
        logger.debug({ err }, 'Error handling messaging-history.set');
      }
    });

    // ── Incoming messages ──
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        // Skip messages sent from ourselves unless testing
        if (msg.key.fromMe) continue;

        // Skip status broadcasts (only customer chats and group chats)
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) continue;

        // Resolve identity using verified Baileys mechanisms (LID to PN mapping)
        const identity = await resolveSenderIdentity(sock, msg, store);
        if (identity.isBroadcast) continue;

        const customerPhone = identity.phone;
        const msgTimestamp = msg.messageTimestamp
          ? (typeof msg.messageTimestamp === 'number'
              ? (msg.messageTimestamp > 1e11 ? new Date(msg.messageTimestamp).toISOString() : new Date(msg.messageTimestamp * 1000).toISOString())
              : new Date(msg.messageTimestamp).toISOString())
          : new Date().toISOString();

        // Check if chat is tombstoned (deleted locally from this application's database)
        // Check both customerPhone and lid to ensure no re-import of deleted chats
        const isTombstoned =
          (await isChatTombstoned(store, customerPhone, msgTimestamp)) ||
          (identity.lid && (await isChatTombstoned(store, identity.lid, msgTimestamp)));

        if (isTombstoned) {
          logger.info({ customerPhone, lid: identity.lid }, 'Skipping message for locally deleted chat (tombstoned)');
          continue;
        }

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '';

        if (!text || text.trim().length === 0) continue;

        logger.info(
          {
            from: customerPhone,
            verifiedPhone: identity.verifiedPhone,
            isVerified: identity.isVerifiedPhone,
            lid: identity.lid,
            text,
            pushName: identity.pushName,
          },
          'Inbound message received via linked WhatsApp'
        );

        try {
          await handleInboundBaileysMessage(sock, identity.replyJid, customerPhone, text, store, {
            ...identity,
            msgTimestamp,
          });
        } catch (err) {
          logger.error({ err, customerPhone }, 'Error processing Baileys inbound message');
        }
      }
    });
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Baileys');
    connectionStatus = 'disconnected';
  } finally {
    isStarting = false;
  }
}

async function saveConversationRecord(store, customerPhone, meta, update) {
  const existingConv = (await store.get(`conv:${customerPhone}`)) ?? { phone: customerPhone };

  // Deduplication check: If an unverified LID was stored previously, and we now resolved it to verifiedPhone
  if (meta.lid && customerPhone !== meta.lid) {
    try {
      const oldLidConv = await store.get(`conv:${meta.lid}`);
      if (oldLidConv) {
        const oldHistory = (await store.get(`history:${meta.lid}`)) ?? [];
        if (oldHistory.length > 0) {
          const currentHistory = (await store.get(`history:${customerPhone}`)) ?? [];
          const combined = [...oldHistory, ...currentHistory].slice(-20);
          await store.set(`history:${customerPhone}`, combined);
        }
        await store.delete(`conv:${meta.lid}`);
        await store.delete(`history:${meta.lid}`);
      }
    } catch (e) {}
  }

  const updatedRecord = {
    ...existingConv,
    phone: customerPhone,
    jid: meta.remoteJid || meta.jid || existingConv.jid || null,
    replyJid: meta.replyJid || existingConv.replyJid || null,
    senderJid: meta.senderJid || existingConv.senderJid || null,
    lid: meta.lid || existingConv.lid || null,
    verifiedPhone: meta.verifiedPhone || existingConv.verifiedPhone || null,
    isVerifiedPhone: meta.isVerifiedPhone ?? existingConv.isVerifiedPhone ?? false,
    pushName: meta.pushName || existingConv.pushName || null,
    savedName: meta.savedName || existingConv.savedName || null,
    isGroup: meta.isGroup || existingConv.isGroup || false,
    groupName: meta.groupName || existingConv.groupName || null,
    ...update,
  };

  await store.set(`conv:${customerPhone}`, updatedRecord);
  return updatedRecord;
}

async function handleInboundBaileysMessage(socket, remoteJid, customerPhone, text, store, meta = {}) {
  const { pushName = null, msgTimestamp = new Date().toISOString(), isGroup = false, groupName = null } = meta;
  const leadService = createLeadService(store);
  const convService = createConversationService(store);
  const quizManager = createQuestionnaireManager(store);

  // Check if human has claimed this conversation
  const isAi = await convService.isAiActive(customerPhone);
  const historyKey = `history:${customerPhone}`;
  const history = (await store.get(historyKey)) ?? [];

  if (!isAi) {
    logger.info({ customerPhone }, 'Human takeover active; AI skipped');
    // Save to history so Mam sees customer message in the dashboard transcript
    const updatedHistory = [...history, { role: 'user', content: text, timestamp: msgTimestamp }].slice(-20);
    await store.set(historyKey, updatedHistory);

    await saveConversationRecord(store, customerPhone, meta, {
      lastMessage: text,
      lastMessageTimestamp: msgTimestamp,
      lastMessageRole: 'user',
      updatedAt: msgTimestamp,
    });
    return;
  }

  // ── Questionnaire flow (highest priority after human-takeover check) ────
  const quizResult = await quizManager.processMessage(customerPhone, text);
  if (quizResult !== null) {
    // Send questionnaire replies (supports multi-message sequence with 2-second delay)
    const outgoingMessages = quizResult.messages && quizResult.messages.length > 0
      ? quizResult.messages
      : [quizResult.reply];

    for (let i = 0; i < outgoingMessages.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await socket.sendMessage(remoteJid, { text: outgoingMessages[i] });
    }

    const replyTimestamp = new Date().toISOString();
    // Record in conversation history with explicit timestamps
    const updatedHistory = [
      ...history,
      { role: 'user', content: text, timestamp: msgTimestamp },
      { role: 'assistant', content: quizResult.reply, timestamp: replyTimestamp },
    ].slice(-20);
    await store.set(historyKey, updatedHistory);

    // Update conversation record for dashboard (sorted by lastMessageTimestamp)
    await saveConversationRecord(store, customerPhone, meta, {
      lastMessage: text,
      lastMessageTimestamp: replyTimestamp,
      lastMessageRole: 'assistant',
      updatedAt: replyTimestamp,
    });

    // If quiz just completed or human handover requested, notify admin
    if ((quizResult.quizDone || quizResult.handover) && config.ADMIN_WHATSAPP_NUMBER) {
      const alreadyNotified = await convService.hasBeenNotified(customerPhone);
      if (!alreadyNotified) {
        const customerName = pushName || (await convService.getCustomerName(customerPhone));
        const summary = buildEnquirySummary({
          customerPhone,
          customerName,
          interest: 'Completed LIU Questionnaire',
          recentMessages: [text],
          aiRecommendation: quizResult.handover
            ? 'Customer requested human agent'
            : 'Questionnaire complete — personalised recommendation sent',
        });
        const adminJid = config.ADMIN_WHATSAPP_NUMBER.replace('+', '') + '@s.whatsapp.net';
        await socket.sendMessage(adminJid, { text: summary });
        await convService.markNotified(customerPhone);
      }
    }

    if (quizResult.handover) {
      await convService.claimConversation(customerPhone, 'quiz-human-request');
    }

    if (quizResult.isConsultantRequest) {
      try {
        const customerName = pushName || (await convService.getCustomerName(customerPhone)) || customerPhone;
        await pushService.notifyConsultantRequest({
          customerPhone,
          customerName,
          messageText: text,
          timestamp: msgTimestamp,
        });
      } catch (err) {
        logger.error({ err, phone: customerPhone }, 'Failed to send consultant push notification in Baileys');
      }
    }

    return; // questionnaire handled this message
  }

  // Classify message
  const classification = classifyMessage(text);

  // Lead collection flow
  if (await leadService.isInLeadFlow(customerPhone)) {
    const { reply, complete, lead } = await leadService.processLeadMessage(customerPhone, text);
    if (reply) {
      await socket.sendMessage(remoteJid, { text: reply });
      const replyTime = new Date().toISOString();
      const updatedHistory = [
        ...history,
        { role: 'user', content: text, timestamp: msgTimestamp },
        { role: 'assistant', content: reply, timestamp: replyTime },
      ].slice(-20);
      await store.set(historyKey, updatedHistory);

      await saveConversationRecord(store, customerPhone, meta, {
        lastMessage: text,
        lastMessageTimestamp: replyTime,
        lastMessageRole: 'assistant',
        updatedAt: replyTime,
      });

      if (complete && lead && config.ADMIN_WHATSAPP_NUMBER) {
        const alreadyNotified = await convService.hasBeenNotified(customerPhone);
        if (!alreadyNotified) {
          const summary = buildEnquirySummary({
            customerPhone,
            customerName: pushName || lead.name,
            interest: lead.interest || 'Not specified',
            recentMessages: [text],
            aiRecommendation: 'Lead details captured via flow',
          });
          const adminJid = config.ADMIN_WHATSAPP_NUMBER.replace('+', '') + '@s.whatsapp.net';
          await socket.sendMessage(adminJid, { text: summary });
          await convService.markNotified(customerPhone);
        }
      }
      return;
    }
  }

  // AI assistant response (Liv)
  const result = await processMessage({
    from: customerPhone,
    message: text,
    history,
  });

  const replyTimestamp = new Date().toISOString();
  // Save history with timestamps
  const updatedHistory = [
    ...history,
    { role: 'user', content: text, timestamp: msgTimestamp },
    { role: 'assistant', content: result.reply, timestamp: replyTimestamp },
  ].slice(-20);
  await store.set(historyKey, updatedHistory);

  // Send reply directly back to WhatsApp customer
  await socket.sendMessage(remoteJid, { text: result.reply });

  // Update conversation record for dashboard (latest message timestamp first)
  await saveConversationRecord(store, customerPhone, meta, {
    lastMessage: text,
    lastMessageTimestamp: replyTimestamp,
    lastMessageRole: 'assistant',
    updatedAt: replyTimestamp,
  });

  // If customer asked for human or enquiry is qualified, notify admin
  if (
    (result.handover || classification === MESSAGE_CLASS.QUALIFIED) &&
    config.ADMIN_WHATSAPP_NUMBER
  ) {
    const alreadyNotified = await convService.hasBeenNotified(customerPhone);
    const customerName = pushName || (await convService.getCustomerName(customerPhone));
    const summary = buildEnquirySummary({
      customerPhone,
      customerName,
      interest:
        classification === MESSAGE_CLASS.QUALIFIED
          ? 'Qualified Service/Booking Enquiry'
          : 'Requested Human Handover',
      recentMessages: updatedHistory.filter((m) => m.role === 'user').map((m) => m.content),
      aiRecommendation: result.handover ? 'Customer requested a person' : 'High intent booking',
    });

    await store.set(`summary:${customerPhone}`, summary);
    await saveConversationRecord(store, customerPhone, meta, {
      summary,
      lastMessageTimestamp: replyTimestamp,
      lastMessageRole: 'assistant',
      updatedAt: replyTimestamp,
    });

    if (!alreadyNotified) {
      const adminJid = config.ADMIN_WHATSAPP_NUMBER.replace('+', '') + '@s.whatsapp.net';
      await socket.sendMessage(adminJid, { text: summary });
      await convService.markNotified(customerPhone);
    }
  }
}

/** Send message directly via Baileys */
export async function sendBaileysMessage(phone, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp Web is not connected');
  }

  const store = await getStore();
  let targetJid = null;

  // 1. Check if conversation has a stored replyJid (handles LIDs and groups properly)
  try {
    const conv = await store.get(`conv:${phone}`);
    if (conv?.replyJid) {
      targetJid = conv.replyJid;
    }
  } catch (err) {}

  // 2. If no replyJid, format based on JID vs standard phone number
  if (!targetJid) {
    if (phone.includes('@')) {
      targetJid = phone;
    } else {
      const clean = phone.replace(/[\s+]/g, '');
      targetJid = `${clean}@s.whatsapp.net`;
    }
  }

  const result = await sock.sendMessage(targetJid, { text });

  // Update conversation lastMessageTimestamp in local store
  try {
    const now = new Date().toISOString();
    const existing = (await store.get(`conv:${phone}`)) ?? { phone };
    await store.set(`conv:${phone}`, {
      ...existing,
      lastMessage: text,
      lastMessageTimestamp: now,
      lastMessageRole: 'assistant',
      updatedAt: now,
    });
  } catch (err) {
    // Non-fatal
  }

  return result;
}
