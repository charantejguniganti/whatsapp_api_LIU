/**
 * Health check route.
 * GET /health
 */
import { Router } from 'express';
import config from '../config/index.js';

const router = Router();

router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'liu-whatsapp-ai-assistant',
    environment: config.NODE_ENV,
    timestamp: new Date().toISOString(),
    mocks: {
      ai: config.USE_MOCK_AI,
      whatsapp: config.USE_MOCK_WHATSAPP,
    },
  });
});

export default router;
