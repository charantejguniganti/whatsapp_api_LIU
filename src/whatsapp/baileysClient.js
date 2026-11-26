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
import * as appointmentsService from '../crm/appointmentsService.js';
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

export function isAppointmentBookingIntent(text = '') {
  const lower = text.trim().toLowerCase();
  const appointmentWord = /(ap+o[a-z]*ment|appoint[a-z]*|consult[a-z]*|slot[s]?|session[s]?)/i;
  const bookingWord = /(book|booking|schedule|reserve|set up|fix|want|need|like|interested in|request|looking for|take)/i;
  return (
    (bookingWord.test(lower) && appointmentWord.test(lower)) ||
    /\b(available slots|consultation timings|available timings|timing|timings|when are you open|free slots?|slot available|available times)\b/i.test(lower) ||
    /^(book|appointment|consultation|schedule|book slot|book session|timings?|slots?)[\s!.,]*$/i.test(lower) ||
    appointmentWord.test(lower)
  );
}

export function isRescheduleAccepted(text = '') {
  const lower = text.trim().toLowerCase();
  return (
    /^(1|yes|yeah|yep|sure|ok|okay|perfect|good|fine|confirmed|confirm|works|great|approved|agreed|agree)[\s!.,]*$/i.test(lower) ||
    /\b(works for me|good for me|date is good|time is good|sounds good|that works|perfect for me|i am good|i'm good|fine with me|see you then|confirm slot|confirmed)\b/i.test(lower)
  );
}

async function handleInboundBaileysMessage(socket, remoteJid, customerPhone, text, store, meta = {}) {
  const { pushName = null, msgTimestamp = new Date().toISOString(), isGroup = false, groupName = null } = meta;
  const leadService = createLeadService(store);
  const convService = createConversationService(store);
  const quizManager = createQuestionnaireManager(store);
  const historyKey = `history:${customerPhone}`;
  const history = (await store.get(historyKey)) ?? [];

  // ── 1. APPOINTMENT BOOKING INTENT (HIGHEST PRIORITY) ──────────────────────
  // When a customer requests an appointment or asks for timings, immediately log
  // a PENDING appointment enquiry on the dashboard and return the timing options.
  if (isAppointmentBookingIntent(text)) {
    try {
      const customerName = pushName || (await convService.getCustomerName(customerPhone)) || customerPhone;
      const existingConv = (await store.get(`conv:${customerPhone}`)) ?? {};
      const serviceInterest = existingConv.interest || 'Personal Consultation';

      let apt = null;
      try {
        apt = await appointmentsService.createAppointment({
          customerPhone,
          customerName,
          serviceName: serviceInterest,
          isCustomerEnquiry: true,
          status: appointmentsService.APPOINTMENT_STATUS.PENDING,
          notes: `Customer WhatsApp Request: "${text}"`,
          skipWhatsAppAck: true,
        });
      } catch (e) {
        logger.warn({ err: e, phone: customerPhone }, 'Appointment booking enquiry already exists or conflict handled');
      }

      const reply =
        `Thank you for reaching out to Live It Up! 🌟\n\n` +
        `We have received your appointment request (*Status: Pending Confirmation*).\n\n` +
        `Our consultation slots are available:\n` +
        `• 🌅 Morning Slots: 10:00 AM – 1:00 PM\n` +
        `• ☀️ Afternoon Slots: 2:00 PM – 5:00 PM\n` +
        `• 🌆 Evening Slots: 5:00 PM – 8:00 PM\n\n` +
        `Please reply with:\n` +
        `1. Your preferred Date & Time (e.g. Tomorrow at 11:00 AM or Saturday at 3:00 PM)\n` +
        `2. Service of interest (Personal Styling, Image Consulting, Grooming, or Communication)\n\n` +
        `Our team will review your slot on the dashboard and confirm your booking right away! ✨`;

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
        status: 'Consultant Requested',
        appointmentId: apt ? apt.id : existingConv.appointmentId,
        updatedAt: replyTime,
      });

      await pushService.notifyConsultantRequest({
        customerPhone,
        customerName,
        messageText: `📅 New Appointment Request: "${text}"`,
        timestamp: msgTimestamp,
      }).catch(() => {});

      return;
    } catch (err) {
      logger.error({ err, customerPhone }, 'Error handling appointment booking intent in Baileys');
    }
  }

  // ── 2. RESCHEDULE NEGOTIATION RESPONSE (OPTION 1 vs OPTION 2) ───────────
  // If the consultant proposed a rescheduled date/time, customer can:
  // Option 1: Confirm proposed date & time ("1", "yes", "good for me", "works")
  // Option 2: Suggest an alternative date & time ("2", "tomorrow 4pm", etc.)
  try {
    const aptIndex = (await store.get('appointments:index')) || [];
    let reschedApt = null;
    let reschedAptId = null;
    for (const aptId of aptIndex) {
      const a = await store.get(`appointment:${aptId}`);
      if (!a || a.isArchived) continue;
      const aPhone = (a.phone || a.customerPhone || '').replace(/\D/g, '');
      const cPhone = customerPhone.replace(/\D/g, '');
      if (aPhone === cPhone || aPhone.endsWith(cPhone) || cPhone.endsWith(aPhone)) {
        if (a.status === appointmentsService.APPOINTMENT_STATUS.RESCHEDULED) {
          reschedApt = a;
          reschedAptId = aptId;
          break;
        }
      }
    }

    if (reschedApt) {
      if (isRescheduleAccepted(text)) {
        // Option 1: Customer accepts the proposed rescheduled slot
        await appointmentsService.confirmAppointment(reschedApt.id, {
          confirmedBy: 'Customer (via WhatsApp)',
          notes: `Customer accepted proposed slot (${reschedApt.date} at ${reschedApt.time}) via WhatsApp: "${text}"`,
        });

        const reply =
          `🎉 Wonderful! Your consultation appointment has been *CONFIRMED*.\n\n` +
          `🗓 *Date:* ${reschedApt.date}\n` +
          `⏰ *Time:* ${reschedApt.time}\n` +
          `👤 *Consultant:* ${reschedApt.consultantName || 'Mam'}\n` +
          `✨ *Service:* ${reschedApt.service || 'Personal Consultation'}\n\n` +
          `We look forward to welcoming you! Feel free to reach out anytime if you need anything before your session. ✨\n\n` +
          `Team Live It Up`;

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
          status: 'In Progress',
          appointmentId: reschedApt.id,
          updatedAt: replyTime,
        });

        return;
      } else {
        // Option 2: Customer proposes an alternative date or time
        reschedApt.notes = reschedApt.notes
          ? `${reschedApt.notes}\nCustomer requested alternative: "${text}"`
          : `Customer requested alternative: "${text}"`;
        reschedApt.updatedAt = new Date().toISOString();
        const auditEntry = {
          action: 'CUSTOMER_COUNTER_PROPOSAL',
          status: appointmentsService.APPOINTMENT_STATUS.RESCHEDULED,
          timestamp: new Date().toISOString(),
          by: customerPhone,
          notes: `Customer proposed alternative timing: "${text}"`,
        };
        reschedApt.history = (reschedApt.history || []).concat([auditEntry]);
        reschedApt.auditHistory = (reschedApt.auditHistory || reschedApt.history || []).concat([auditEntry]);
        await store.set(`appointment:${reschedAptId}`, reschedApt);

        const reply =
          `Thank you for letting us know! 📝\n\n` +
          `We have received your requested alternative timing:\n` +
          `*\"${text}\"*\n\n` +
          `Our team is reviewing the consultant's schedule and will propose an updated time slot shortly. We will coordinate until we find the perfect date and time for you! 🤝✨\n\n` +
          `Team Live It Up`;

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
          status: 'Consultant Requested',
          appointmentId: reschedApt.id,
          updatedAt: replyTime,
        });

        await pushService.notifyConsultantRequest({
          customerPhone,
          customerName: reschedApt.customerName || customerPhone,
          messageText: `🔄 Appointment Reschedule Request from Customer: "${text}"`,
          timestamp: msgTimestamp,
        }).catch(() => {});

        return;
      }
    }
  } catch (err) {
    logger.warn({ err, customerPhone }, 'Error in customer reschedule response handling');
  }

  // ── 3. FOLLOW-UP TO PENDING APPOINTMENT ENQUIRY ────────────────────────────
  // If customer already has a PENDING appointment enquiry and sends their slot/preference
  try {
    const aptIndex = (await store.get('appointments:index')) || [];
    let pendingApt = null;
    let pendingAptId = null;
    for (const aptId of aptIndex) {
      const a = await store.get(`appointment:${aptId}`);
      if (
        a &&
        !a.isArchived &&
        (a.phone === customerPhone || a.customerPhone === customerPhone) &&
        a.status === appointmentsService.APPOINTMENT_STATUS.PENDING
      ) {
        pendingApt = a;
        pendingAptId = aptId;
        break;
      }
    }

    if (pendingApt) {
      const lower = text.toLowerCase();
      const hasSlotPreference =
        /\b(tomorrow|today|morning|afternoon|evening|am|pm|\d{1,2}[:.]\d{2}|\d{1,2}\s*(am|pm)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|styling|grooming|image|communication|personal)\b/i.test(
          lower
        );

      if (hasSlotPreference) {
        pendingApt.notes = pendingApt.notes ? `${pendingApt.notes} | Preferred slot: "${text}"` : `Preferred slot: "${text}"`;
        pendingApt.updatedAt = new Date().toISOString();
        await store.set(`appointment:${pendingAptId}`, pendingApt);

        const reply =
          `Thank you! We have updated your consultation request with your preferred timing:\n` +
          `*"${text}"*\n\n` +
          `Our team has your request on the dashboard and will confirm your slot shortly on WhatsApp! ✨`;

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
          status: 'Consultant Requested',
          appointmentId: pendingApt.id,
          updatedAt: replyTime,
        });

        return;
      }
    }
  } catch (err) {
    logger.warn({ err, customerPhone }, 'Error in pending appointment follow-up');
  }

  // Check if human has claimed this conversation
  const isAi = await convService.isAiActive(customerPhone);

  if (!isAi) {
    logger.info({ customerPhone }, 'Human takeover active; AI skipped');
    // Save to history so Mam sees customer message in the dashboard transcript
    const updatedHistory = [...history, { role: 'user', content: text, timestamp: msgTimestamp }].slice(-20);
    await store.set(historyKey, updatedHistory);

    // If customer has a pending appointment, update notes with customer's latest reply
    try {
      const aptIndex = (await store.get('appointments:index')) || [];
      for (const aptId of aptIndex) {
        const a = await store.get(`appointment:${aptId}`);
        if (a && !a.isArchived && (a.phone === customerPhone || a.customerPhone === customerPhone) && a.status === appointmentsService.APPOINTMENT_STATUS.PENDING) {
          a.notes = a.notes ? `${a.notes} | Preferred slot: "${text}"` : `Preferred slot: "${text}"`;
          a.updatedAt = new Date().toISOString();
          await store.set(`appointment:${aptId}`, a);
          break;
        }
      }
    } catch (e) {}

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

        // Automatically create a pending appointment enquiry if customer completed quiz and requested consultant
        try {
          const session = await (await getStore()).get(`quiz:${customerPhone}`);
          const quizService = session?.answers?.q1 || session?.analysis?.primaryRecommendation?.title || 'Personal Consultation';
          await appointmentsService.createAppointment({
            customerPhone,
            customerName,
            serviceName: quizService,
            isCustomerEnquiry: true,
            status: appointmentsService.APPOINTMENT_STATUS.PENDING,
            notes: `Customer completed questionnaire and requested consultation (${text})`,
          });
        } catch (e) {
          logger.warn({ err: e, phone: customerPhone }, 'Quiz appointment auto-creation skipped or duplicate');
        }
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
