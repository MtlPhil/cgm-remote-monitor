'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

// ==================================================================
// NIGHTSCOUT PLUGIN: Webhook Notifier (Improved)
// ==================================================================
// Sends an HTTP POST webhook to a local server whenever a NEW SGV
// (glucose) value is available in Nightscout.
//
// Configuration via environment variables:
//   WEBHOOK_HOST     (required, e.g., 192.168.10.5 or localhost)
//   WEBHOOK_PORT     (default: 3000)
//   WEBHOOK_PATH     (default: /nightscout)
//   WEBHOOK_PROTOCOL (default: https, can be http)
//
// Example:
//   WEBHOOK_HOST=192.168.10.5
//   WEBHOOK_PORT=33333
//   WEBHOOK_PATH=/nightscout
//   WEBHOOK_PROTOCOL=https
//
// Features:
// - At-least-once delivery: lastSentMills updated only after confirmed success
// - Explicit startup handling: distinguishes between startup and runtime
// - Protocol configurable: supports both http and https
// - Flexible success codes: accepts 200, 202, 204 as success
// ==================================================================

module.exports = function webhookPlugin(env) {
  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  const WEBHOOK_HOST = process.env.WEBHOOK_HOST;
  const WEBHOOK_PORT = process.env.WEBHOOK_PORT || '3000';
  const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/nightscout';
  const WEBHOOK_PROTOCOL = process.env.WEBHOOK_PROTOCOL || 'https';

  // Valid HTTP success response codes
  const SUCCESS_CODES = [200, 202, 204];
  const WEBHOOK_TIMEOUT_MS = 5000;

  // Track the last successfully sent SGV timestamp (only updated on success)
  let lastSentMills = null;

  // Track if this is the first initialization (startup)
  let isStartup = true;

  // Queue for failed sends to support retry logic
  let failedSendQueue = [];

  // ------------------------------------------------------------------
  // Build webhook URL dynamically
  // ------------------------------------------------------------------
  function buildWebhookUrl() {
    if (!WEBHOOK_HOST) {
      throw new Error('[Webhook] WEBHOOK_HOST environment variable is required');
    }
    return `${WEBHOOK_PROTOCOL}://${WEBHOOK_HOST}:${WEBHOOK_PORT}${WEBHOOK_PATH}`;
  }

  // ------------------------------------------------------------------
  // Send HTTP POST JSON webhook with at-least-once semantics
  // ------------------------------------------------------------------
  function sendWebhook(payload) {
    const webhookUrl = buildWebhookUrl();
    const parsed = url.parse(webhookUrl);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const body = JSON.stringify(payload);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'POST',
      timeout: WEBHOOK_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    return new Promise((resolve, reject) => {
      const req = protocol.request(options, (res) => {
        let responseBody = '';

        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          // Check if response status code is in the success list
          if (SUCCESS_CODES.includes(res.statusCode)) {
            console.log(`[Webhook] Successfully sent SGV (${payload.mills}). Status: ${res.statusCode}`);
            resolve({ success: true, statusCode: res.statusCode });
          } else {
            reject(new Error(`Non-success status code: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Webhook] Request failed:', err.message);
        reject(err);
      });

      req.on('timeout', () => {
        console.error('[Webhook] Request timed out after', WEBHOOK_TIMEOUT_MS, 'ms');
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  // ------------------------------------------------------------------
  // Process failed sends queue (retry logic)
  // ------------------------------------------------------------------
  function processPendingQueue() {
    if (failedSendQueue.length === 0) return;

    const payload = failedSendQueue[0];

    sendWebhook(payload)
      .then((result) => {
        // Success: update lastSentMills and remove from queue
        lastSentMills = payload.mills;
        failedSendQueue.shift();
        console.log('[Webhook] Retry successful for SGV', payload.mills);
      })
      .catch((err) => {
        // Still failing; leave in queue for next attempt
        console.warn('[Webhook] Retry failed, will retry later:', err.message);
      });
  }

  // ------------------------------------------------------------------
  // Check for new notifications and send webhook if needed
  // ------------------------------------------------------------------
  function checkNotifications(sbx) {
    if (!sbx) return;

    // First, try to process any pending retries from the queue
    processPendingQueue();

    // Stable, server-side accessors for SGV and timestamp (ms)
    const mgdl = typeof sbx.lastSGVMgdl === 'function' ? sbx.lastSGVMgdl() : null;
    const mills = typeof sbx.lastSGVMills === 'function' ? sbx.lastSGVMills() : null;

    // If we don't have a valid SGV yet, do nothing
    if (!mgdl || !mills) return;

    // On startup: send webhook for existing SGV (this is expected behavior)
    // After startup: only send for new SGVs (different timestamp)
    if (!isStartup && lastSentMills === mills) {
      // Already sent this SGV, skip
      return;
    }

    // Build payload
    const payload = {
      source: 'nightscout',
      mgdl,
      mills,
      iso: new Date(mills).toISOString()
    };

    // Attempt to send
    sendWebhook(payload)
      .then((result) => {
        // Success: update lastSentMills only after confirmed delivery
        lastSentMills = mills;
        isStartup = false;
      })
      .catch((err) => {
        // Failure: add to queue for retry, do NOT update lastSentMills
        failedSendQueue.push(payload);
        console.warn('[Webhook] Send failed; queued for retry:', err.message);
      });
  }

  // ------------------------------------------------------------------
  // Plugin metadata and initialization
  // ------------------------------------------------------------------
  return {
    name: 'webhook',
    label: 'Webhook Notifier',
    pluginType: 'notification',

    // Called once when plugin initializes
    init: function () {
      try {
        const webhookUrl = buildWebhookUrl();
        console.log('[Webhook] Initialized. Target URL:', webhookUrl);
        console.log('[Webhook] Accepted success codes: 200, 202, 204');
        console.log('[Webhook] At-least-once delivery enabled with retry queue');
      } catch (err) {
        console.error('[Webhook] Initialization failed:', err.message);
      }
    },

    // Called periodically by Nightscout
    checkNotifications
  };
};
