/**
 * Express application factory.
 * Separate from server.js so it can be imported in tests without starting the HTTP server.
 */
import express from 'express';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import healthRouter from './routes/health.js';
import simulateRouter from './routes/simulate.js';
import webhookRouter from './webhooks/router.js';
import adminRouter from './admin/router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  // ---------------------------------------------------------------------------
  // Body parsing — capture rawBody for signature verification
  // ---------------------------------------------------------------------------
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------
  app.use(requestLogger);

  // ---------------------------------------------------------------------------
  // Routes & Dashboard
  // ---------------------------------------------------------------------------
  app.use('/health', healthRouter);
  app.use('/simulate', simulateRouter);
  app.use('/webhook', webhookRouter);
  app.use('/admin', adminRouter);

  // Serve Dashboard UI
  app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));


  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
