/**
 * Push Notification Routes
 * Handles subscription registration, preferences, and test notifications.
 */
import { Router } from 'express';
import config from '../config/index.js';
import * as pushStore from '../push/pushStore.js';
import * as pushService from '../push/pushService.js';
import logger from '../logger.js';

const router = Router();

/**
 * GET /api/push/vapid-public-key
 * Returns the VAPID public key needed by frontend PushManager to subscribe.
 * NEVER exposes the private key.
 */
router.get('/vapid-public-key', (_req, res) => {
  return res.json({
    publicKey: config.VAPID_PUBLIC_KEY,
  });
});

/**
 * POST /api/push/subscribe
 * Register or update a device's Web Push subscription.
 */
router.post('/subscribe', async (req, res) => {
  try {
    const { subscription, options } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription or endpoint' });
    }

    await pushStore.saveSubscription(subscription, {
      ...options,
      userAgent: req.headers['user-agent'] || '',
    });

    return res.json({ success: true, message: 'Push subscription saved' });
  } catch (err) {
    logger.error({ err }, 'Error saving push subscription');
    return res.status(500).json({ error: 'Failed to save subscription' });
  }
});

/**
 * POST /api/push/unsubscribe
 * Remove an existing push subscription.
 */
router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }

    await pushStore.removeSubscription(endpoint);
    return res.json({ success: true, message: 'Unsubscribed successfully' });
  } catch (err) {
    logger.error({ err }, 'Error unsubscribing');
    return res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

/**
 * GET /api/push/settings
 * Fetch current push notification settings.
 */
router.get('/settings', async (_req, res) => {
  try {
    const settings = await pushStore.getSettings();
    return res.json({ settings });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch push settings' });
  }
});

/**
 * POST /api/push/settings
 * Update notification preferences.
 */
router.post('/settings', async (req, res) => {
  try {
    const { enabled, consultantOnly } = req.body;
    const updated = await pushStore.updateSettings({ enabled, consultantOnly });
    return res.json({ success: true, settings: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update push settings' });
  }
});

/**
 * POST /api/push/test
 * Dispatch a test push notification to all subscribed devices.
 */
router.post('/test', async (_req, res) => {
  try {
    const result = await pushService.sendTestNotification();
    return res.json({
      success: true,
      message: 'Test notification triggered',
      sent: result.sent,
      failed: result.failed,
      result,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to trigger test notification');
    return res.status(500).json({ error: 'Failed to send test push notification' });
  }
});

export default router;
