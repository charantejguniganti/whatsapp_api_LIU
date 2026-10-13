/**
 * Global Express error handler.
 * Must be registered last (4-argument middleware).
 */
import logger from '../logger.js';

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  logger.error({ err, method: req.method, url: req.url }, 'Unhandled error');

  // Never expose internal error details in production
  const isDev = process.env.NODE_ENV !== 'production';

  res.status(err.status ?? 500).json({
    error: 'Internal server error',
    ...(isDev ? { message: err.message, stack: err.stack } : {}),
  });
}
