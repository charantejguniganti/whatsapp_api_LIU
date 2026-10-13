/**
 * Admin Authentication
 *
 * Username + bcrypt-hashed password stored in environment variables.
 * Issues a signed JWT on successful login. The JWT is verified on every
 * protected admin API request via the `requireAuth` middleware.
 *
 * Setup:
 *   1. Generate a hash for your password:
 *      node -e "import('bcryptjs').then(m=>m.default.hash('yourPassword',12).then(console.log))"
 *   2. Set ADMIN_USERNAME and ADMIN_PASSWORD_HASH in .env
 *   3. Set a strong random JWT_SECRET in .env
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import logger from '../logger.js';

/**
 * Verify credentials and return a signed JWT.
 * @param {string} username
 * @param {string} password   - Plain-text password from the login form
 * @returns {Promise<string|null>} JWT token or null if invalid
 */
export async function login(username, password) {
  let authorized = false;

  if (config.ADMIN_PASSWORD_HASH) {
    const usernameMatch = username === config.ADMIN_USERNAME;
    const passwordMatch = await bcrypt.compare(password, config.ADMIN_PASSWORD_HASH);
    authorized = usernameMatch && passwordMatch;
  } else {
    // Development default: admin / admin123 or admin / admin
    if (username === (config.ADMIN_USERNAME || 'admin') && (password === 'admin123' || password === 'admin')) {
      authorized = true;
    }
  }

  if (!authorized) {
    logger.warn({ username }, 'Failed admin login attempt');
    return null;
  }

  const token = jwt.sign(
    { sub: username, role: 'admin' },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRY }
  );

  logger.info({ username }, 'Admin login successful');
  return token;
}

/**
 * Express middleware — verifies the Authorization: Bearer <token> header.
 * Returns 401 if missing or invalid.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  // Also accept token from cookie (for dashboard page requests)
  const cookieToken = req.cookies?.admin_token;
  const activeToken = token || cookieToken;

  if (!activeToken) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  try {
    const payload = jwt.verify(activeToken, config.JWT_SECRET);
    req.admin = payload;
    next();
  } catch (err) {
    logger.debug({ err: err.message }, 'JWT verification failed');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Hash a plain-text password. Used by the setup CLI.
 * @param {string} password
 * @returns {Promise<string>} bcrypt hash
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}
