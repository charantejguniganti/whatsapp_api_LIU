/**
 * Push Notification Storage
 * Manages Web Push subscriptions, notification settings, and event deduplication.
 * Uses the configured storage backend (Postgres in production, Memory in tests).
 */
import { getStore } from '../store/index.js';
import logger from '../logger.js';

const SUBS_KEY = 'push:subscriptions';
const SETTINGS_KEY = 'push:settings';
const EVENT_PREFIX = 'push:event:';
const LOG_KEY = 'push:events_log';

/**
 * Get all saved subscriptions.
 * @returns {Promise<Array<Object>>}
 */
export async function getAllSubscriptions() {
  const store = await getStore();
  const subs = (await store.get(SUBS_KEY)) || [];
  return Array.isArray(subs) ? subs : [];
}

/**
 * Save or update a Web Push subscription.
 * @param {Object} subscription - Web Push subscription object ({ endpoint, keys })
 * @param {Object} [options]
 * @returns {Promise<boolean>}
 */
export async function saveSubscription(subscription, options = {}) {
  if (!subscription || !subscription.endpoint) {
    throw new Error('Invalid subscription: missing endpoint');
  }

  const store = await getStore();
  const subs = await getAllSubscriptions();
  const existingIdx = subs.findIndex((s) => s.endpoint === subscription.endpoint);

  const subRecord = {
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    enabled: options.enabled ?? true,
    consultantOnly: options.consultantOnly ?? true,
    userAgent: options.userAgent || '',
    updatedAt: new Date().toISOString(),
    createdAt: existingIdx >= 0 ? subs[existingIdx].createdAt : new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    subs[existingIdx] = subRecord;
  } else {
    subs.push(subRecord);
  }

  await store.set(SUBS_KEY, subs);
  logger.info({ endpoint: subscription.endpoint.slice(-20) }, 'Push subscription saved');
  return true;
}

/**
 * Remove a Web Push subscription by its endpoint URL.
 * @param {string} endpoint
 * @returns {Promise<boolean>}
 */
export async function removeSubscription(endpoint) {
  if (!endpoint) return false;
  const store = await getStore();
  const subs = await getAllSubscriptions();
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  await store.set(SUBS_KEY, filtered);
  logger.info({ endpoint: endpoint.slice(-20) }, 'Push subscription removed');
  return true;
}

/**
 * Get push notification settings.
 * @returns {Promise<{ enabled: boolean, consultantOnly: boolean }>}
 */
export async function getSettings() {
  const store = await getStore();
  const settings = await store.get(SETTINGS_KEY);
  if (!settings) {
    return { enabled: true, consultantOnly: true };
  }
  return {
    enabled: settings.enabled ?? true,
    consultantOnly: settings.consultantOnly ?? true,
  };
}

/**
 * Update push notification settings.
 * @param {Object} newSettings
 * @returns {Promise<Object>}
 */
export async function updateSettings(newSettings) {
  const store = await getStore();
  const current = await getSettings();
  const updated = {
    enabled: newSettings.enabled ?? current.enabled,
    consultantOnly: newSettings.consultantOnly ?? current.consultantOnly,
    updatedAt: new Date().toISOString(),
  };
  await store.set(SETTINGS_KEY, updated);
  return updated;
}

/**
 * Check if a notification event with this ID has already been delivered.
 * Used to avoid duplicate notifications for the same request.
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
export async function hasNotificationBeenSent(eventId) {
  if (!eventId) return false;
  const store = await getStore();
  const record = await store.get(`${EVENT_PREFIX}${eventId}`);
  return Boolean(record);
}

/**
 * Record a delivered or attempted notification event.
 * @param {Object} event
 * @returns {Promise<void>}
 */
export async function recordNotificationEvent(event) {
  if (!event || !event.eventId) return;
  const store = await getStore();
  const eventRecord = {
    eventId: event.eventId,
    phone: event.phone,
    customerName: event.customerName,
    type: event.type || 'CONSULTANT_REQUEST',
    status: event.status || 'SENT',
    sentCount: event.sentCount ?? 0,
    timestamp: event.timestamp || new Date().toISOString(),
    payload: event.payload,
  };

  // Store individual event for deduplication lookup
  await store.set(`${EVENT_PREFIX}${event.eventId}`, eventRecord);

  // Maintain recent event log (capped at 50)
  const log = (await store.get(LOG_KEY)) || [];
  const updatedLog = [eventRecord, ...(Array.isArray(log) ? log : [])].slice(0, 50);
  await store.set(LOG_KEY, updatedLog);
}
