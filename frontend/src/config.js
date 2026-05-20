/** Backend origin (HTTP). WebSocket uses same host with ws/wss. */
const backend = new URL(
  import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001',
)

export const apiOrigin = backend.origin

/** Same secret as backend `CHAT_API_KEY` when you enable it (optional). */
export const chatApiKey = (import.meta.env.VITE_CHAT_API_KEY ?? '').trim()

/** If true, use browser speechSynthesis when Sarvam TTS fails or errors. */
export const voiceBrowserFallback =
  import.meta.env.VITE_VOICE_BROWSER_TTS_FALLBACK === 'true'

export function buildWsChatUrl() {
  const wsProto = backend.protocol === 'https:' ? 'wss:' : 'ws:'
  const u = new URL('/ws/chat', `${wsProto}//${backend.host}`)
  if (chatApiKey) u.searchParams.set('apiKey', chatApiKey)
  return u.href
}

export function voiceHeaders() {
  const h = {}
  if (chatApiKey) h['X-API-Key'] = chatApiKey
  return h
}
