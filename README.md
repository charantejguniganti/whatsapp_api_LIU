# LIU WhatsApp AI Assistant & Concierge Dashboard

AI-powered WhatsApp assistant for **Live It Up (LIU)** using Meta's WhatsApp Cloud API and OpenAI.

> ⚠️ Meta Business verification is currently pending. This application is fully functional in local development mode using mock adapters — no real WhatsApp credentials are required to get started.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Local Development & Testing](#local-development--testing)
- [Running Tests](#running-tests)
- [Meta / WhatsApp Setup](#meta--whatsapp-setup)
- [Deployment](#deployment)
- [Security Notes](#security-notes)
- [Storage & Future Database Migration](#storage--future-database-migration)

---

## Features

- 🤖 **AI-powered responses** using OpenAI GPT-4o-mini, grounded strictly in the LIU knowledge base
- 📞 **Human handover** — automatically escalates when requested or when AI can't help
- 🧲 **Lead capture** — multi-turn conversational flow collecting name, interest, and preferred contact time with explicit consent
- 🔏 **Webhook signature verification** — HMAC-SHA256 validation of all inbound Meta events
- 🔁 **Deduplication** — ignores duplicate webhook events (24-hour window)
- 🧪 **Simulation endpoint** — test conversations locally via HTTP without any WhatsApp credentials
- 🛡️ **Mock adapters** — auto-activates when real credentials are absent; never sends real messages in tests
- 📋 **Structured logging** with Pino (redacts sensitive fields)
- ✅ **Health check** endpoint for uptime monitoring

---

## Architecture

```
src/
├── app.js                  # Express app factory (imported in tests)
├── server.js               # HTTP server entry point
├── config/index.js         # Zod-validated environment config
├── logger.js               # Pino logger singleton
├── webhooks/
│   ├── router.js           # GET verification + POST message handler
│   ├── signature.js        # HMAC-SHA256 Meta signature verifier
│   └── parser.js           # Webhook payload parser
├── whatsapp/
│   └── client.js           # Outbound WhatsApp Cloud API client (with mock)
├── ai/
│   ├── agent.js            # AI response orchestrator
│   └── openai.js           # OpenAI SDK wrapper (with mock)
├── knowledge/
│   └── liu.js              # LIU knowledge base + system prompt
├── leads/
│   ├── service.js          # Multi-turn lead capture state machine
│   └── schema.js           # Zod lead validation schemas
├── store/
│   ├── interface.js        # IStore interface (JSDoc)
│   ├── memory.js           # In-memory implementation (dev/test)
│   └── index.js            # Store factory
├── routes/
│   ├── health.js           # GET /health
│   └── simulate.js         # POST /simulate (local dev only)
└── middleware/
    ├── requestLogger.js    # Pino HTTP request logger
    └── errorHandler.js     # Global Express error handler

tests/
├── setup.js                # Forces mock mode for all tests
├── unit/
│   ├── signature.test.js
│   ├── agent.test.js
│   └── leads.test.js
└── integration/
    ├── webhook.test.js
    └── simulate.test.js
```

---

## Prerequisites

- Node.js **18+** (uses native `fetch`)
- npm 9+

---

## Installation

```bash
# 1. Clone / copy the project
cd "WHATSAPP CHAT API"

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env
# Edit .env with your values (see Configuration below)
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env`:

| Variable | Description | Required |
|---|---|---|
| `NODE_ENV` | `development` / `production` / `test` | No (default: `development`) |
| `PORT` | HTTP server port | No (default: `3000`) |
| `LOG_LEVEL` | Pino log level | No (default: `info`) |
| `LOG_PRETTY` | `true` for colorized logs | No |
| `WHATSAPP_TOKEN` | Meta system user access token | For real WhatsApp |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID | For real WhatsApp |
| `WHATSAPP_VERIFY_TOKEN` | Self-chosen webhook verify token | For real WhatsApp |
| `META_APP_SECRET` | Meta app secret for signature verification | For real WhatsApp |
| `OPENAI_API_KEY` | OpenAI API key | For real AI |
| `OPENAI_MODEL` | Model name | No (default: `gpt-4o-mini`) |
| `USE_MOCK_AI` | Force mock AI (`true`/`false`/blank=auto) | No |
| `USE_MOCK_WHATSAPP` | Force mock WhatsApp (`true`/`false`/blank=auto) | No |

> **Auto-detection**: When `OPENAI_API_KEY` / `WHATSAPP_TOKEN` are blank or set to placeholder values, mock adapters activate automatically. Set `USE_MOCK_AI=false` to force real adapters.

---

## Local Development & Testing

### Start the development server

```bash
npm run dev
```

The server starts at `http://localhost:3000`.

### Test a conversation via the simulate endpoint

```bash
# Send a message
curl -X POST http://localhost:3000/simulate \
  -H "Content-Type: application/json" \
  -d '{"from": "+919876543210", "message": "Tell me about corporate events"}'

# Response
{
  "from": "+919876543210",
  "reply": "We love corporate events! ...",
  "handover": false,
  "leadCollected": false,
  "mock": true,
  "flow": "ai"
}
```

### Check service health

```bash
curl http://localhost:3000/health
```

### Clear conversation history

```bash
curl -X POST http://localhost:3000/simulate \
  -H "Content-Type: application/json" \
  -d '{"from": "+919876543210", "message": "Hello", "clearHistory": true}'
```

---

## Running Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage report
npm run test:coverage
```

All tests run in mock mode — **no real API calls are made**.

---

## Meta / WhatsApp Setup

> Complete these steps once Meta Business verification is approved.

### 1. Create a Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com) → Create App → Business type
2. Add the **WhatsApp** product
3. Note your **App Secret** from App Settings > Basic → set as `META_APP_SECRET`

### 2. Configure a Phone Number

1. In WhatsApp > API Setup, add or link a phone number
2. Note the **Phone Number ID** → set as `WHATSAPP_PHONE_NUMBER_ID`
3. Generate a **Permanent Access Token** via a System User → set as `WHATSAPP_TOKEN`

### 3. Set Up the Webhook

1. In WhatsApp > Configuration > Webhooks, click **Edit**
2. **Callback URL**: `https://your-domain.com/webhook`
3. **Verify Token**: must match `WHATSAPP_VERIFY_TOKEN` in `.env`
4. Subscribe to the **messages** field
5. Click **Verify and Save** — the GET verification challenge will be handled automatically

### 4. Test with Real WhatsApp

After verification, set real credentials in `.env` and restart:

```bash
npm start
```

---

## Deployment

### Environment Variables

Set all variables from `.env.example` in your hosting provider's secrets/environment panel.
**Never deploy a `.env` file.**

### Process Manager (PM2)

```bash
npm install -g pm2
pm2 start src/server.js --name liu-whatsapp
pm2 save
pm2 startup
```

### Docker (minimal example)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

### Reverse Proxy (nginx)

Meta requires HTTPS for webhooks. Use Caddy or nginx with a valid TLS certificate.
During development, use [ngrok](https://ngrok.com) to expose localhost:

```bash
ngrok http 3000
# Use the https URL as your webhook callback URL
```

---

## Security Notes

- All secrets live in environment variables — never in code or logs
- Webhook payloads are HMAC-SHA256 verified before processing
- Message content is **not** logged (Pino redaction configured)
- The `/simulate` endpoint is blocked in `NODE_ENV=production`
- No real WhatsApp messages are sent during automated tests
- `.env` is listed in `.gitignore`

---

## Storage & Future Database Migration

The app currently uses an **in-memory store** (`src/store/memory.js`).

**Limitations:**
- Data is lost on process restart
- Not suitable for multi-instance / load-balanced deployments
- No persistence or backups

**Migrating to PostgreSQL or Redis:**
1. Create a new file `src/store/postgres.js` (or `redis.js`) implementing the `IStore` interface:
   - `get(key)`, `set(key, value, ttlMs?)`, `delete(key)`, `keys(prefix)`
2. Update `src/store/index.js` to detect `DATABASE_URL` or `REDIS_URL` and return the new implementation
3. No other files need to change

---

## License

UNLICENSED — proprietary to Live It Up (LIU). All rights reserved.
>>>>>>> e0a786e (feat: complete production-ready LIU WhatsApp AI assistant and concierge dashboard with Neon PostgreSQL integration)
