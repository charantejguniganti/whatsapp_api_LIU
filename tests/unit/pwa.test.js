import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PWA & Mobile App Integration', () => {
  const app = createApp();

  it('GET /manifest.json returns valid web app manifest with standalone display', async () => {
    const res = await request(app).get('/manifest.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');

    const manifest = JSON.parse(res.text);
    expect(manifest.name).toContain('LIU');
    expect(manifest.short_name).toBe('LIU Concierge');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
    expect(manifest.theme_color).toBe('#6B4938');
    expect(manifest.background_color).toBe('#FDFBF8');

    // Verify icons
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
    const icon192 = manifest.icons.find(i => i.sizes === '192x192' && i.purpose === 'any');
    const icon512 = manifest.icons.find(i => i.sizes === '512x512' && i.purpose === 'any');
    const iconMaskable = manifest.icons.find(i => i.purpose === 'maskable');

    expect(icon192).toBeDefined();
    expect(icon512).toBeDefined();
    expect(iconMaskable).toBeDefined();
  });

  it('GET /sw.js serves Service Worker with Service-Worker-Allowed header set to root', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['service-worker-allowed']).toBe('/');
    expect(res.text).toContain('CACHE_NAME');
    expect(res.text).toContain('STATIC_ASSETS');
    expect(res.text).toContain('fetch');
  });

  it('GET / serves Dashboard UI app shell with PWA manifest link and iOS meta tags', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<link rel="manifest" href="/manifest.json" />');
    expect(res.text).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(res.text).toContain('pwa-splash-screen');
    expect(res.text).toContain('btn-install-pwa');
    expect(res.text).toContain('ios-install-modal');
    expect(res.text).toContain('offline-banner');
  });

  it('GET /icons/icon-192.png and /icons/icon-512.png exist and are accessible', async () => {
    const res192 = await request(app).get('/icons/icon-192.png');
    expect(res192.status).toBe(200);
    expect(res192.headers['content-type']).toBe('image/png');
    expect(res192.body.length).toBeGreaterThan(0);

    const res512 = await request(app).get('/icons/icon-512.png');
    expect(res512.status).toBe(200);
    expect(res512.headers['content-type']).toBe('image/png');
    expect(res512.body.length).toBeGreaterThan(0);
  });
});
