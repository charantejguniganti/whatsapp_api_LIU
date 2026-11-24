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
import chatsRouter from './routes/chats.js';
import pushRouter from './routes/push.js';
import crmRouter from './routes/crm.js';

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
  app.use('/api/chats', chatsRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/crm', crmRouter);

  // Serve PWA Manifest & Service Worker with root scope permissions
  app.get(['/manifest.json', '/manifest.webmanifest'], (_req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(__dirname, 'dashboard', 'manifest.json'));
  });

  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'dashboard', 'sw.js'));
  });

  // Serve PWA Icons & Static Dashboard Assets
  app.use('/icons', express.static(path.join(__dirname, 'dashboard', 'icons')));
  app.get(['/dashboard', '/dashboard/index.html'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
  });
  app.use('/dashboard', express.static(path.join(__dirname, 'dashboard'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  // Root URL launches the Dashboard app shell
  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
  });


  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
