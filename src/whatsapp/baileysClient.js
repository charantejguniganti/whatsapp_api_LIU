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
} from '../conversations/service.js';
import logger from '../logger.js';
import config from '../config/index.js';

let sock = null;
let currentQr = null; // data URL of QR code
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'qr_ready'
let connectedPhone = null;
let isStarting = false;

export function getBaileysStatus() {
  return {
    status: connectionStatus,
    qr: currentQr,
    phone: connectedPhone,
  };
}

export async function initBaileys(forceRestart = false) {
  if (isStarting && !forceRestart) return;
  if (sock && connectionStatus === 'connected' && !forceRestart) return;

  isStarting = true;
  connectionStatus = 'connecting';
  currentQr = null;

  try {
    const store = await getStore();
    const { state, saveCreds, clearAuth } = await usePostgresAuthState(store);
    const { version } = await fetchLatestBaileysVersion();

    logger.info({ version }, 'Starting Baileys WhatsApp client...');

    sock = makeWASocket.default({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: logger.child({ module: 'baileys' }, { level: 'silent' }),
      browser: ['LIU Concierge Assistant', 'Chrome', '1.0.0'],
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
        connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : null;
        logger.info({ phone: connectedPhone }, '✅ WhatsApp Web linked successfully!');
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        // Skip messages sent from ourselves unless testing
        if (msg.key.fromMe) continue;

        // Skip status broadcasts or group chats (only 1-on-1 customer chats)
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

        const customerPhone = '+' + remoteJid.replace('@s.whatsapp.net', '');
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '';

        if (!text || text.trim().length === 0) continue;

        logger.info({ from: customerPhone, text }, 'Inbound message received via linked WhatsApp');

        try {
          await handleInboundBaileysMessage(sock, remoteJid, customerPhone, text, store);
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

async function handleInboundBaileysMessage(socket, remoteJid, customerPhone, text, store) {
  const leadService = createLeadService(store);
  const convService = createConversationService(store);

  // Check if human has claimed this conversation
  const isAi = await convService.isAiActive(customerPhone);
  const historyKey = `history:${customerPhone}`;
  const history = (await store.get(historyKey)) ?? [];

  if (!isAi) {
    logger.info({ customerPhone }, 'Human takeover active; AI skipped');
    // Save to history so Mam sees customer message in the dashboard transcript
    await store.set(historyKey, [...history, { role: 'user', content: text }].slice(-20));
    return;
  }

  // Classify message
  const classification = classifyMessage(text);

  // Lead collection flow
  if (await leadService.isInLeadFlow(customerPhone)) {
    const { reply, complete, lead } = await leadService.processLeadMessage(customerPhone, text);
    if (reply) {
      await socket.sendMessage(remoteJid, { text: reply });
      if (complete && lead && config.ADMIN_WHATSAPP_NUMBER) {
        const alreadyNotified = await convService.hasBeenNotified(customerPhone);
        if (!alreadyNotified) {
          const summary = buildEnquirySummary({
            customerPhone,
            customerName: lead.name,
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

  // Save history
  const updatedHistory = [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: result.reply },
  ].slice(-20);
  await store.set(historyKey, updatedHistory);

  // Send reply directly back to WhatsApp customer
  await socket.sendMessage(remoteJid, { text: result.reply });

  // Update conversation record for dashboard
  const existingConv = (await store.get(`conv:${customerPhone}`)) ?? { phone: customerPhone };
  await store.set(`conv:${customerPhone}`, {
    ...existingConv,
    phone: customerPhone,
    updatedAt: new Date().toISOString(),
  });

  // If customer asked for human or enquiry is qualified, notify admin
  if (
    (result.handover || classification === MESSAGE_CLASS.QUALIFIED) &&
    config.ADMIN_WHATSAPP_NUMBER
  ) {
    const alreadyNotified = await convService.hasBeenNotified(customerPhone);
    const customerName = await convService.getCustomerName(customerPhone);
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
    const updated = (await store.get(`conv:${customerPhone}`)) ?? { phone: customerPhone };
    await store.set(`conv:${customerPhone}`, {
      ...updated,
      summary,
      updatedAt: new Date().toISOString(),
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
  const cleanPhone = phone.replace(/[\s+\-()]/g, '');
  const jid = `${cleanPhone}@s.whatsapp.net`;
  return await sock.sendMessage(jid, { text });
}
