# TaxOne voice assistant — frontend

React (Vite) UI: **WebSocket** chat with streamed tokens, optional **Web Speech** mic + TTS.

## Run

1. Start the backend (`backend/`): `npm run dev` (port **3001** by default).
2. Copy `.env.example` → `.env` and adjust if needed.
3. Here: `npm install` then `npm run dev` (Vite default **5173**).

Open http://localhost:5173

If you set `CHAT_API_KEY` in the backend, set the same value as `VITE_CHAT_API_KEY` in `frontend/.env`.

## Build

```bash
npm run build
npm run preview
```
