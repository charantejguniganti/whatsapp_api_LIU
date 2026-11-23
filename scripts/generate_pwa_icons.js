import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconsDir = path.join(__dirname, '..', 'src', 'dashboard', 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function createPNG(width, height, getPixel) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createChunk('IHDR', ihdr);

  // Scanlines with 0 filter byte
  const scanlineLength = 1 + width * 4;
  const rawData = Buffer.alloc(height * scanlineLength);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData[rowOffset] = 0; // Filter type None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = crc32(body);

  const chunk = Buffer.alloc(4 + 4 + len + 4);
  chunk.writeUInt32BE(len, 0);
  typeBuf.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc, 8 + len);
  return chunk;
}

// Helper color utilities
function parseHex(hex) {
  hex = hex.replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16)
  ];
}

const BG_COLOR = parseHex('6B4938'); // Primary terracotta
const GOLD_COLOR = parseHex('E5A869'); // Warm gold accent
const WHITE_COLOR = [255, 255, 255];
const GREEN_DOT = parseHex('2E7D32'); // WhatsApp green badge

function renderIconPixel(x, y, w, h, isMaskable = false) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy);

  // Background
  if (!isMaskable) {
    // Squircle / rounded rectangle for standalone icon
    const cornerRadius = w * 0.22;
    const qx = Math.max(Math.abs(x - cx) - (cx - cornerRadius), 0);
    const qy = Math.max(Math.abs(y - cy) - (cy - cornerRadius), 0);
    const distCorner = Math.sqrt(qx * qx + qy * qy);
    if (distCorner > cornerRadius) {
      return [0, 0, 0, 0]; // Transparent outside squircle
    }
  }

  // Base terracotta gradient (slightly lighter at top left)
  const grad = 1 - (y / h) * 0.15 + (x / w) * 0.08;
  let bgR = Math.min(255, Math.floor(BG_COLOR[0] * grad));
  let bgG = Math.min(255, Math.floor(BG_COLOR[1] * grad));
  let bgB = Math.min(255, Math.floor(BG_COLOR[2] * grad));

  // Outer gold ring
  const ringRadius = isMaskable ? w * 0.36 : w * 0.40;
  const ringThickness = w * 0.02;
  if (Math.abs(r - ringRadius) < ringThickness) {
    const alpha = Math.max(0, 1 - Math.abs(r - ringRadius) / ringThickness);
    return [
      Math.floor(GOLD_COLOR[0] * alpha + bgR * (1 - alpha)),
      Math.floor(GOLD_COLOR[1] * alpha + bgG * (1 - alpha)),
      Math.floor(GOLD_COLOR[2] * alpha + bgB * (1 - alpha)),
      255
    ];
  }

  // Draw Lettering 'LIU' in center
  // Scale normalized coordinates (-1 to 1)
  const scale = isMaskable ? 0.8 : 1.0;
  const nx = (x - cx) / (w * 0.38 * scale);
  const ny = (y - cy) / (h * 0.38 * scale);

  let isText = false;

  // L glyph (nx between -0.85 and -0.35, ny between -0.45 and 0.45)
  if (nx >= -0.75 && nx <= -0.55 && ny >= -0.45 && ny <= 0.45) isText = true; // L vertical
  if (nx >= -0.75 && nx <= -0.25 && ny >= 0.28 && ny <= 0.45) isText = true; // L horizontal

  // I glyph (nx between -0.12 and 0.12, ny between -0.45 and 0.45)
  if (nx >= -0.09 && nx <= 0.09 && ny >= -0.45 && ny <= 0.45) isText = true; // I stem
  if (nx >= -0.18 && nx <= 0.18 && ny >= -0.45 && ny <= -0.32) isText = true; // I top bar
  if (nx >= -0.18 && nx <= 0.18 && ny >= 0.32 && ny <= 0.45) isText = true; // I bottom bar

  // U glyph (nx between 0.25 and 0.75, ny between -0.45 and 0.45)
  if (nx >= 0.25 && nx <= 0.43 && ny >= -0.45 && ny <= 0.30) isText = true; // U left stem
  if (nx >= 0.57 && nx <= 0.75 && ny >= -0.45 && ny <= 0.30) isText = true; // U right stem
  // U bottom curve
  if (nx >= 0.25 && nx <= 0.75 && ny >= 0.25 && ny <= 0.45) {
    const udx = (nx - 0.50) / 0.25;
    const udy = (ny - 0.25) / 0.20;
    if (udx * udx + udy * udy <= 1.0) isText = true;
  }

  if (isText) {
    return [WHITE_COLOR[0], WHITE_COLOR[1], WHITE_COLOR[2], 255];
  }

  // Small gold accent dot above 'I'
  const dotDx = nx;
  const dotDy = ny - (-0.62);
  if (dotDx * dotDx + dotDy * dotDy < 0.007) {
    return [GOLD_COLOR[0], GOLD_COLOR[1], GOLD_COLOR[2], 255];
  }

  // WhatsApp active indicator badge at bottom right
  const badgeCx = cx + (isMaskable ? w * 0.25 : w * 0.28);
  const badgeCy = cy + (isMaskable ? h * 0.25 : h * 0.28);
  const badgeR = w * 0.09;
  const bdx = x - badgeCx;
  const bdy = y - badgeCy;
  const bDist = Math.sqrt(bdx * bdx + bdy * bdy);

  if (bDist < badgeR + w * 0.015) {
    if (bDist >= badgeR) {
      // White border around badge
      return [255, 255, 255, 255];
    }
    // WhatsApp green center
    return [GREEN_DOT[0], GREEN_DOT[1], GREEN_DOT[2], 255];
  }

  return [bgR, bgG, bgB, 255];
}

console.log('Generating PWA icons...');

const icons = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-192.png', size: 192, maskable: true },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: false },
  { name: 'favicon.png', size: 64, maskable: false }
];

for (const icon of icons) {
  const buf = createPNG(icon.size, icon.size, (x, y, w, h) => renderIconPixel(x, y, w, h, icon.maskable));
  const outPath = path.join(iconsDir, icon.name);
  fs.writeFileSync(outPath, buf);
  console.log(`✓ Created ${icon.name} (${icon.size}x${icon.size})`);
}

// Generate SVG vector icon
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="terragrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7B5441" />
      <stop offset="100%" stop-color="#5E3F2F" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#terragrad)" />
  <circle cx="256" cy="256" r="200" fill="none" stroke="#E5A869" stroke-width="8" opacity="0.85" />
  
  <!-- LIU Text -->
  <g fill="#FFFFFF" font-family="'Cormorant Garamond', 'Playfair Display', serif" font-weight="700">
    <!-- L -->
    <path d="M 140 180 L 175 180 L 175 305 L 225 305 L 225 332 L 140 332 Z" />
    <!-- I -->
    <path d="M 235 180 L 277 180 L 277 202 L 266 202 L 266 310 L 277 310 L 277 332 L 235 332 L 235 310 L 246 310 L 246 202 L 235 202 Z" />
    <!-- U -->
    <path d="M 295 180 L 330 180 L 330 280 C 330 305 342 315 356 315 C 370 315 382 305 382 280 L 382 180 L 417 180 L 417 280 C 417 325 390 336 356 336 C 322 336 295 325 295 280 Z" />
  </g>

  <!-- Gold Accent Leaf / Dot -->
  <circle cx="256" cy="148" r="10" fill="#E5A869" />

  <!-- Live It Up Subtitle -->
  <text x="256" y="375" text-anchor="middle" fill="#E5A869" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="600" letter-spacing="7">LIVE IT UP</text>
  
  <!-- WhatsApp Active Indicator Badge -->
  <circle cx="395" cy="395" r="42" fill="#FFFFFF" />
  <circle cx="395" cy="395" r="36" fill="#2E7D32" />
  <path d="M 382 390 C 382 383 388 377 395 377 C 402 377 408 383 408 390 C 408 397 401 405 395 407 C 392 408 387 409 385 411 L 386 405 C 383 401 382 395 382 390 Z" fill="#FFFFFF" />
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent, 'utf8');
console.log('✓ Created icon.svg');
