/**
 * Web Push Notification Service
 * Sends native mobile push notifications to installed PWAs using Web Push API and VAPID.
 */
import webpush from 'web-push';
import config from '../config/index.js';
import logger from '../logger.js';
import * as pushStore from './pushStore.js';

// Initialise VAPID details with configured keys
if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      config.VAPID_SUBJECT,
      config.VAPID_PUBLIC_KEY,
      config.VAPID_PRIVATE_KEY
    );
    logger.info('VAPID details configured for Web Push');
  } catch (err) {
    logger.error({ err }, 'Failed to set VAPID details');
  }
}

/**
 * Dispatch a push notification to all matching subscriptions.
 * Handles stale/unsubscribed endpoints (410/404) by purging them from the store.
 *
 * @param {Object} payload - Notification data payload
 * @param {Object} [filter] - { consultantOnly: boolean }
 * @returns {Promise<{ total: number, sent: number, failed: number }>}
 */
export async function sendPushNotification(payload, filter = {}) {
  const settings = await pushStore.getSettings();
  if (!settings.enabled) {
    logger.info('Push notifications are globally disabled in settings. Skipping.');
    return { total: 0, sent: 0, failed: 0, disabled: true };
  }

  const subscriptions = await pushStore.getAllSubscriptions();
  if (subscriptions.length === 0) {
    logger.info('No push subscriptions registered.');
    return { total: 0, sent: 0, failed: 0 };
  }

  const targetSubs = subscriptions.filter((sub) => {
    if (!sub.enabled) return false;
    if (filter.isConsultantRequest && sub.consultantOnly === false) return false;
    return true;
  });

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);

  let sent = 0;
  let failed = 0;

  for (const sub of targetSubs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        payloadString,
        {
          TTL: 60 * 60 * 24, // 24 hours TTL for offline devices
          urgency: 'high',
        }
      );
      sent++;
    } catch (err) {
      failed++;
      const statusCode = err.statusCode || err.status;
      if (statusCode === 410 || statusCode === 404) {
        // Expired or unsubscribed device endpoint -> purge
        logger.info({ endpoint: sub.endpoint.slice(-20), statusCode }, 'Purging expired push subscription');
        await pushStore.removeSubscription(sub.endpoint);
      } else {
        logger.warn({ err: err.message, statusCode, endpoint: sub.endpoint.slice(-20) }, 'Failed to deliver push notification');
      }
    }
  }

  logger.info({ total: targetSubs.length, sent, failed }, 'Push notification dispatch completed');
  return { total: targetSubs.length, sent, failed };
}

/**
 * Trigger an automatic push notification specifically when a customer requests an LIU consultant.
 * Includes event deduplication to ensure the administrator is not spammed.
 *
 * @param {Object} params
 * @param {string} params.customerPhone - Customer's WhatsApp phone number
 * @param {string} [params.customerName]  - Customer's name or push name
 * @param {string} [params.messageText]   - The customer's message (e.g. "Yes, please")
 * @param {string|number} [params.timestamp]
 * @returns {Promise<{ triggered: boolean, duplicate: boolean, sentCount?: number }>}
 */
export async function notifyConsultantRequest({
  customerPhone,
  phone,
  customerName = '',
  name = '',
  messageText,
  message,
  timestamp = null,
}) {
  const targetPhone = customerPhone || phone;
  const targetName = customerName || name || '';
  const targetMessage = messageText || message || 'Yes';

  if (!targetPhone) {
    return { triggered: false, duplicate: false, reason: 'missing_phone' };
  }

  // Canonical clean identifier
  const cleanPhone = String(targetPhone).trim();
  const displayName = targetName && targetName !== cleanPhone ? targetName : cleanPhone;
  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Generate unique deduplication event ID per request occurrence
  // Uses a 1-hour window per customer to avoid duplicate alerts for repeated confirmations
  const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
  const eventId = `consultant_req_${cleanPhone}_${hourBucket}`;

  // Check if already notified for this request event
  const alreadySent = await pushStore.hasNotificationBeenSent(eventId);
  if (alreadySent) {
    logger.info({ cleanPhone, eventId }, 'Consultant push notification already sent for this event. Skipping duplicate.');
    return { triggered: false, duplicate: true, eventId };
  }

  const payload = {
    title: '🔔 New LIU Consultant Request',
    body: `${displayName} wants to speak with an LIU consultant.`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: `consultant-req-${cleanPhone}`,
    timestamp: Date.now(),
    data: {
      url: `/?phone=${encodeURIComponent(cleanPhone)}`,
      phone: cleanPhone,
      customerName: displayName,
      messagePreview: messageText,
      time: timeStr,
      type: 'CONSULTANT_REQUEST',
      eventId,
    },
    actions: [
      { action: 'open', title: 'Open Chat' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  const dispatchResult = await sendPushNotification(payload, { isConsultantRequest: true });

  await pushStore.recordNotificationEvent({
    eventId,
    phone: cleanPhone,
    customerName: displayName,
    type: 'CONSULTANT_REQUEST',
    status: dispatchResult.sent > 0 ? 'SENT' : (dispatchResult.total === 0 ? 'NO_DEVICES' : 'FAILED'),
    sentCount: dispatchResult.sent,
    timestamp: new Date().toISOString(),
    payload,
  });

  return {
    triggered: true,
    duplicate: false,
    eventId,
    sentCount: dispatchResult.sent,
    totalDevices: dispatchResult.total,
  };
}

/**
 * Send a test notification to verify Web Push delivery.
 * @returns {Promise<Object>}
 */
export async function sendTestNotification() {
  const payload = {
    title: '🔔 LIU Test Push Notification',
    body: 'Push notifications are successfully configured and working on this device!',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'liu-test-notification',
    timestamp: Date.now(),
    data: {
      type: 'TEST_NOTIFICATION',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  };

  return sendPushNotification(payload);
}
