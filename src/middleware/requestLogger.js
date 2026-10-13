/**
 * Pino HTTP request logger middleware.
 */
import logger from '../logger.js';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
}
