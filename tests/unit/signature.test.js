/**
 * Unit tests: webhook signature verifier
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifySignature } from '../../src/webhooks/signature.js';

const SECRET = 'test_secret_key';

function makeSignature(body, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  it('returns true for a valid signature', () => {
    const body = JSON.stringify({ test: 'payload' });
    const sig = makeSignature(body);
    expect(verifySignature(body, sig, SECRET)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const body = JSON.stringify({ test: 'payload' });
    const sig = makeSignature(body);
    expect(verifySignature('tampered body', sig, SECRET)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const body = JSON.stringify({ test: 'payload' });
    const sig = makeSignature(body, 'wrong_secret');
    expect(verifySignature(body, sig, SECRET)).toBe(false);
  });

  it('returns false when signature is empty', () => {
    const body = '{}';
    expect(verifySignature(body, '', SECRET)).toBe(false);
  });

  it('returns false when appSecret is empty', () => {
    const body = '{}';
    const sig = makeSignature(body);
    expect(verifySignature(body, sig, '')).toBe(false);
  });

  it('handles sha256= prefix correctly', () => {
    const body = '{"hello":"world"}';
    const sig = makeSignature(body);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifySignature(body, sig, SECRET)).toBe(true);
  });

  it('returns false for mismatched hex lengths', () => {
    expect(verifySignature('body', 'sha256=abc', SECRET)).toBe(false);
  });
});
