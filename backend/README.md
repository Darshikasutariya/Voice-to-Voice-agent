# Voice agent backend

## Setup

- Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
- Run Chroma (e.g. `npm run chroma:up`) and ingest: `npm run ingest`.

## Scripts

| Command | Purpose |
|--------|---------|
| `npm run dev` | HTTP + WebSocket with nodemon |
| `npm start` | HTTP + WebSocket |
| `npm run ingest` | Crawl, chunk, embed into Chroma |
| `npm run query -- "…"` | Vector search only (no LLM) |

## HTTP

`POST /api/chat` — JSON body:

- `question` (string, required)
- `history` (optional): array of `{ "role": "user" | "assistant", "content": "…" }` (server keeps the last **8** items)

Response: `{ "answer": "…", "sources": [{ "title", "url" }] }`

Optional auth: if `CHAT_API_KEY` is set in `.env`, send the same value as:

- Header `X-API-Key: <key>`, or  
- Header `Authorization: Bearer <key>`

Errors use `error` and optional `code` (e.g. `no_openai_key`, `chat_failed`, `invalid_api_key`, `rate_limited`).

**Rate limit (HTTP):** per IP, default 30 requests per 60s on `/api/chat` — tune with `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`.

Example:

```bash
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_CHAT_KEY" \
  -d "{\"question\":\"How do I sync with Tally?\"}"
```

## WebSocket

Connect to `ws://localhost:3001/ws/chat` (adjust host/port from `.env`). In production, terminate TLS at a reverse proxy and use `wss://`.

If `CHAT_API_KEY` is set, pass the key either as:

- Query: `ws://localhost:3001/ws/chat?apiKey=YOUR_CHAT_KEY`, and/or  
- Field on each message: `"apiKey": "YOUR_CHAT_KEY"`

**Client → server** (text frame, JSON):

```json
{
  "question": "Can you elaborate?",
  "history": [
    { "role": "user", "content": "How do I sync with Tally?" },
    { "role": "assistant", "content": "You can sync from …" }
  ]
}
```

`history` is optional; facts still come only from retrieved help docs.

When `CHAT_API_KEY` is enabled, you can also send:

```json
{ "question": "How do I …", "apiKey": "YOUR_CHAT_KEY" }
```

(or put `apiKey` in the WebSocket URL query instead of the body.)

**Server → client** (text frames, JSON):

- `{ "type": "token", "text": "…" }` — streamed answer pieces (may be many)
- `{ "type": "done", "sources": [ … ] }` — end of reply
- `{ "type": "error", "code": "…", "message": "…" }` — includes `invalid_api_key`, `rate_limited`, `invalid_json`, `question_required`, `busy`, `message_too_large`, `no_openai_key`, `chat_failed`

**Rate limit (WebSocket):** default 20 messages per IP per 60s — `WS_RATE_LIMIT_WINDOW_MS` / `WS_RATE_LIMIT_MAX`.

Only one question is processed per connection at a time; if a second arrives while streaming, you get `busy`.

## Voice HTTP (STT + TTS)

For a **support “call”** flow the frontend records short clips, transcribes them, sends the text over `/ws/chat`, and plays agent replies via Sarvam TTS.

**`POST /api/voice/transcribe`** — multipart form:

- Field **`audio`** (required): audio file (e.g. `webm` from the browser `MediaRecorder`; max **8 MB**).
- Same auth as chat when **`CHAT_API_KEY`** is set: header `X-API-Key` or `Authorization: Bearer`.

Response: `{ "text": "…" }`.

STT provider is chosen with **`VOICE_STT_PROVIDER`**: **`deepgram`** (default) or **`sarvam`**. Set **`DEEPGRAM_API_KEY`** and/or **`SARVAM_API_KEY`** in `.env` accordingly.

**`POST /api/voice/tts`** — JSON body:

- **`text`** (string, required).

Returns **`audio/wav`** bytes (Sarvam). Same optional auth as chat.

**Rate limit:** default **45** requests per IP per minute for both voice routes — override with **`VOICE_RATE_LIMIT_MAX`**.

If Sarvam rejects WebM from the client, try a different recorder mime type or convert to WAV on the server; Deepgram’s prerecorded API is often more forgiving for varied containers.

## Production notes

- Put **HTTPS / WSS** in front of this process (Caddy, nginx, cloud load balancer); keep Node on HTTP internally.
- Behind a proxy, set **`TRUST_PROXY=1`** so the rate limiter sees the real client IP (`X-Forwarded-For`).
- **Increase** proxy **read/send timeouts** if streams are long.

## Env reference

See `.env.example` for `CHAT_API_KEY`, rate limits, `TRUST_PROXY`, and **voice** variables (`DEEPGRAM_API_KEY`, `SARVAM_API_KEY`, `VOICE_STT_PROVIDER`, etc.).
