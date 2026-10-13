/**
 * Global test setup.
 * Ensures tests run in mock mode — no real API calls.
 */
process.env.NODE_ENV = 'test';
process.env.WHATSAPP_VERIFY_TOKEN = 'test_verify_token';
process.env.META_APP_SECRET = 'test_app_secret_32chars_padded!!!';
process.env.USE_MOCK_AI = 'true';
process.env.USE_MOCK_WHATSAPP = 'true';
process.env.LOG_LEVEL = 'silent';
