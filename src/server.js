/**
 * HTTP server entry point.
 * Starts the Express server and handles graceful shutdown.
 */
import 'dotenv/config';
import { createApp } from './app.js';
import config from './config/index.js';
import logger from './logger.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      mockAI: config.USE_MOCK_AI,
      mockWhatsApp: config.USE_MOCK_WHATSAPP,
    },
    '🚀 LIU WhatsApp AI Assistant started'
  );
  logger.info(`   Health:   http://localhost:${config.PORT}/health`);
  logger.info(`   Simulate: http://localhost:${config.PORT}/simulate`);
  logger.info(`   Webhook:  http://localhost:${config.PORT}/webhook`);

  // Start Baileys WhatsApp client in background
  import('./whatsapp/baileysClient.js').then(({ initBaileys }) => {
    initBaileys().catch(err => logger.error({ err }, 'Failed to start Baileys in background'));
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced exit after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

export default server;
