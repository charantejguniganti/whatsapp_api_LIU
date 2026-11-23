/**
 * src/whatsapp/identityResolver.js
 *
 * WhatsApp Contact Identity & LID Resolver for Baileys
 *
 * Distinguishes:
 *  - @s.whatsapp.net : Phone-number-based user JID (verified phone number)
 *  - @lid            : Linked Identity identifier (privacy / multi-device ID, NOT a phone number)
 *  - @g.us           : Group chat JID
 *  - @broadcast      : Broadcast / status JID
 *
 * Rules:
 *  1. NEVER extract arbitrary digits from a LID and display as a phone number.
 *  2. Resolve LID to actual phone number using verified Baileys mechanisms:
 *     - remoteJidAlt / participantAlt
 *     - sock.signalRepository.lidMapping.getPNForLID(lid)
 *     - contacts.upsert / contacts.update / messaging-history.set
 *     - Local persistent store mappings
 *  3. Maintain separate fields: jid, lid, verifiedPhone, pushName, savedName.
 *  4. Do not create duplicate contacts when a JID and LID refer to the same person.
 */
import logger from '../logger.js';

/**
 * Check if JID is a phone-number based WhatsApp user.
 * @param {string} jid
 * @returns {boolean}
 */
export function isPnUser(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

/**
 * Check if JID is a Linked Identity identifier (LID).
 * @param {string} jid
 * @returns {boolean}
 */
export function isLidUser(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

/**
 * Check if JID is a group chat.
 * @param {string} jid
 * @returns {boolean}
 */
export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * Check if JID is a broadcast channel.
 * @param {string} jid
 * @returns {boolean}
 */
export function isBroadcastJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@broadcast') || jid === 'status@broadcast');
}

/**
 * Extract verified E.164 phone number ONLY from phone-number-based JID (@s.whatsapp.net).
 * Returns null for LIDs, groups, or non-user JIDs.
 * NEVER call this on @lid.
 * @param {string} jid
 * @returns {string|null} E.164 formatted string e.g. "+916305566800" or null
 */
export function extractVerifiedPhoneNumber(jid) {
  if (!isPnUser(jid)) return null;
  const raw = jid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
  if (!raw || raw.length < 5) return null;
  return '+' + raw;
}

/**
 * Store bidirectional mapping between LID and verified phone number.
 * @param {import('../store/interface.js').IStore} store
 * @param {object} [socket] Baileys socket
 * @param {string} lid
 * @param {string} phone E.164 format e.g. "+916305566800"
 * @param {string} [pnJid] e.g. "916305566800@s.whatsapp.net"
 */
export async function saveLidPnMapping(store, socket, lid, phone, pnJid) {
  if (!lid || !phone) return;
  const cleanLid = lid.includes('@') ? lid : `${lid}@lid`;
  const cleanPn = phone.startsWith('+') ? phone : `+${phone}`;
  const cleanPnJid = pnJid || `${cleanPn.replace('+', '')}@s.whatsapp.net`;

  try {
    if (store) {
      await Promise.all([
        store.set(`lid_to_pn:${cleanLid}`, cleanPn),
        store.set(`pn_to_lid:${cleanPn}`, cleanLid),
      ]);
    }

    // Also populate Baileys' native signalRepository.lidMapping if supported
    if (socket?.signalRepository?.lidMapping?.storeLIDPNMappings) {
      await socket.signalRepository.lidMapping.storeLIDPNMappings([
        { lid: cleanLid, pn: cleanPnJid },
      ]);
    }
  } catch (err) {
    logger.debug({ err, lid, phone }, 'Failed to store LID-PN mapping');
  }
}

/**
 * Look up verified phone number for an LID.
 * Checks Baileys signalRepository, persistent store, and contacts cache.
 * @param {object} socket Baileys socket
 * @param {import('../store/interface.js').IStore} store
 * @param {string} lid
 * @returns {Promise<string|null>} E.164 phone or null
 */
export async function resolveLidToPhone(socket, store, lid) {
  if (!lid) return null;
  const cleanLid = lid.includes('@') ? lid : `${lid}@lid`;

  // 1. Check local persistent store cache
  if (store) {
    try {
      const cached = await store.get(`lid_to_pn:${cleanLid}`);
      if (cached && typeof cached === 'string' && cached.startsWith('+')) {
        return cached;
      }
    } catch (e) {}
  }

  // 2. Query Baileys native signalRepository.lidMapping
  if (socket?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pnJid = await socket.signalRepository.lidMapping.getPNForLID(cleanLid);
      if (pnJid && isPnUser(pnJid)) {
        const phone = extractVerifiedPhoneNumber(pnJid);
        if (phone) {
          if (store) await saveLidPnMapping(store, socket, cleanLid, phone, pnJid);
          return phone;
        }
      }
    } catch (err) {
      logger.debug({ err, lid }, 'Baileys lidMapping.getPNForLID lookup returned error');
    }
  }

  // 3. Check contacts store cache
  if (store) {
    try {
      const contact = await store.get(`contact:${cleanLid}`);
      if (contact?.phone && contact.phone.startsWith('+')) {
        return contact.phone;
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Handle incoming Baileys contact sync events:
 * contacts.upsert, contacts.update, messaging-history.set
 * @param {import('../store/interface.js').IStore} store
 * @param {object} socket
 * @param {Array<object>} contacts
 */
export async function handleContactsSync(store, socket, contacts = []) {
  if (!Array.isArray(contacts) || contacts.length === 0 || !store) return;

  for (const c of contacts) {
    if (!c || !c.id) continue;
    const jid = c.id;
    const lid = c.lid || (isLidUser(jid) ? jid : null);
    let verifiedPhone = null;

    if (isPnUser(jid)) {
      verifiedPhone = extractVerifiedPhoneNumber(jid);
    }

    // If contact record provides both PN and LID, link them
    if (lid && verifiedPhone) {
      await saveLidPnMapping(store, socket, lid, verifiedPhone, jid);
    }

    const contactMeta = {
      id: jid,
      lid: lid || null,
      phone: verifiedPhone || null,
      name: c.name || c.verifiedName || null,
      pushName: c.notify || null,
      updatedAt: new Date().toISOString(),
    };

    // Cache metadata by JID and LID
    await store.set(`contact:${jid}`, contactMeta);
    if (lid && lid !== jid) {
      await store.set(`contact:${lid}`, contactMeta);
    }
    if (verifiedPhone) {
      await store.set(`contact:${verifiedPhone}`, contactMeta);
    }
  }
}

/**
 * Resolves full sender identity from a Baileys message.
 *
 * Inspects:
 *  - remoteJid, remoteJidAlt
 *  - participant, participantAlt (for groups)
 *  - pushName
 *  - sock.signalRepository.lidMapping
 *
 * @param {object} socket Baileys socket
 * @param {object} msg Baileys WAMessage
 * @param {import('../store/interface.js').IStore} store
 * @returns {Promise<object>} Resolved identity structure
 */
export async function resolveSenderIdentity(socket, msg, store) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || isBroadcastJid(remoteJid)) {
    return { isBroadcast: true };
  }

  const isGroup = isGroupJid(remoteJid);
  const remoteJidAlt = msg.key?.remoteJidAlt;

  // In groups, participant is the sender; in 1-on-1, remoteJid is the sender
  let senderJid = isGroup ? (msg.key?.participant || msg.participant) : remoteJid;
  let senderAlt = isGroup ? (msg.participantAlt || msg.key?.participantAlt) : remoteJidAlt;

  let verifiedPhone = null;
  let lid = null;
  let isVerifiedPhone = false;

  // Case 1: Sender is a verified phone number JID (@s.whatsapp.net)
  if (isPnUser(senderJid)) {
    verifiedPhone = extractVerifiedPhoneNumber(senderJid);
    isVerifiedPhone = true;

    if (senderAlt && isLidUser(senderAlt)) {
      lid = senderAlt;
      await saveLidPnMapping(store, socket, lid, verifiedPhone, senderJid);
    }
  }
  // Case 2: Sender is a Linked Identity (@lid)
  else if (isLidUser(senderJid)) {
    lid = senderJid;

    // Check alternative JID first
    if (senderAlt && isPnUser(senderAlt)) {
      verifiedPhone = extractVerifiedPhoneNumber(senderAlt);
      if (verifiedPhone) {
        isVerifiedPhone = true;
        await saveLidPnMapping(store, socket, lid, verifiedPhone, senderAlt);
      }
    }

    // Try resolving via Baileys lidMapping or local store
    if (!verifiedPhone) {
      const resolved = await resolveLidToPhone(socket, store, lid);
      if (resolved) {
        verifiedPhone = resolved;
        isVerifiedPhone = true;
      }
    }
  }

  // Fallback: If 1-on-1 chat and remoteJidAlt has verified phone
  if (!verifiedPhone && remoteJidAlt && isPnUser(remoteJidAlt)) {
    verifiedPhone = extractVerifiedPhoneNumber(remoteJidAlt);
    if (verifiedPhone) {
      isVerifiedPhone = true;
      if (lid) await saveLidPnMapping(store, socket, lid, verifiedPhone, remoteJidAlt);
    }
  }

  // Stable internal contact ID:
  // - If verified phone exists, use verified phone (+916305566800)
  // - For unverified LID, use the raw LID (e.g. 108225156407425@lid), NEVER fake digits with '+'!
  // - For groups, use group JID as the chat conversation ID
  const stableContactId = isGroup
    ? remoteJid
    : (verifiedPhone || senderJid);

  // Check saved contact metadata
  let savedName = null;
  if (store) {
    try {
      const contactRecord = (await store.get(`contact:${stableContactId}`))
        || (lid ? await store.get(`contact:${lid}`) : null);
      if (contactRecord?.name) savedName = contactRecord.name;
    } catch (e) {}
  }

  const pushName = msg.pushName || null;

  return {
    isBroadcast: false,
    isGroup,
    groupJid: isGroup ? remoteJid : null,
    remoteJid,
    replyJid: remoteJid, // Always reply to remoteJid for correct WhatsApp routing
    senderJid,
    lid: lid || null,
    verifiedPhone: verifiedPhone || null,
    isVerifiedPhone,
    phone: stableContactId, // Stable primary key
    pushName,
    savedName,
  };
}

