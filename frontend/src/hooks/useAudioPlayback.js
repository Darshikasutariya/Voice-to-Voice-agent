import { useCallback, useRef } from 'react'
import { apiOrigin, voiceHeaders } from '../config'

function logTime(msg) {
  const d = new Date()
  const ts = `${d.toLocaleTimeString('en-IN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  console.log(`[${ts}] ${msg}`)
}

function base64ToArrayBuffer(b64) {
  const binStr = atob(b64)
  const bytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i)
  return bytes.buffer
}

/** Detect language from character set for browser TTS fallback */
function detectLanguage(text) {
  if (!text) return 'en'
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu'
  if (/[\u0900-\u097F]/.test(text)) return 'hi'
  return 'en'
}

/**
 * Audio playback hook. Handles three modes:
 *  1. Streaming chunked audio (preferred) — AudioContext queue with ordered playback
 *  2. HTTP TTS (fallback) — if no streaming chunks arrived
 *  3. Browser SpeechSynthesis (fallback) — if HTTP TTS also fails
 *
 * Public API:
 *  - ensureAudioContext()        — call inside user gesture (startCall)
 *  - closeAudioContext()         — call on endCall
 *  - enqueueChunk(b64, chunkId, replyId)
 *  - markStreamDone(replyId)
 *  - playFullText(text, replyId) — HTTP fallback
 *  - stopAll()                   — stop everything, increment epoch
 *  - onSpeakingStart(cb)         — register callback (phase change)
 *  - onAllAudioDone(cb)          — register callback (phase change)
 *  - audioCtxRef                 — exposed for AudioContext access
 *  - speakingStartRef            — for VAD refractory period
 *  - activeReplyIdRef            — currently active reply id
 *  - replyEpochRef               — monotonic counter, bumped on stopAll
 *  - playbackEpochRef            — bumped on every new playback start
 */
export function useAudioPlayback() {
  // Streaming queue refs
  const audioCtxRef = useRef(null)
  const audioNodesRef = useRef([])
  const nextAudioTimeRef = useRef(0)
  const ttsStreamDoneRef = useRef(false)
  const pendingChunksRef = useRef(0)
  const ttsChunksCountRef = useRef(0)
  const playQueueRef = useRef({
    nextPlayId: 0,
    decodedChunks: new Map(),
    isPlaying: false,
  })

  // HTTP fallback refs
  const playRef = useRef(null)
  const playUrlRef = useRef(null)

  // Reply / epoch refs (stale-message invalidation)
  const replyEpochRef = useRef(0)
  const activeReplyIdRef = useRef(0)
  const playbackEpochRef = useRef(0)
  const speakingStartRef = useRef(0)
  const queryStartTimeRef = useRef(0)

  // Metrics flags
  const firstTokenLoggedRef = useRef(false)
  const firstAudioChunkLoggedRef = useRef(false)
  const firstAudioPlayLoggedRef = useRef(false)

  // Phase change callbacks (set by caller)
  const onSpeakingStartRef = useRef(null)
  const onAllAudioDoneRef = useRef(null)

  // ── Public: register phase callbacks ────────────────────────────────────
  const onSpeakingStart = useCallback((cb) => { onSpeakingStartRef.current = cb }, [])
  const onAllAudioDone = useCallback((cb) => { onAllAudioDoneRef.current = cb }, [])

  // ── AudioContext lifecycle ──────────────────────────────────────────────
  const ensureAudioContext = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
      nextAudioTimeRef.current = 0
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch((err) => {
        logTime(`[Audio] Failed to resume AudioContext: ${err.message}`)
      })
    }
  }, [])

  const closeAudioContext = useCallback(() => {
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => { })
      audioCtxRef.current = null
    }
  }, [])

  // ── Stop everything in flight (called on interrupt / barge-in / end) ────
  const stopAll = useCallback(() => {
    logTime(`[Audio] stopAll — epoch→${replyEpochRef.current + 1}`)
    replyEpochRef.current += 1
    playbackEpochRef.current += 1
    speakingStartRef.current = 0
    window.speechSynthesis?.cancel()

    // HTTP fallback cleanup
    if (playRef.current) {
      playRef.current.pause()
      playRef.current.currentTime = 0
      playRef.current = null
    }
    if (playUrlRef.current) {
      URL.revokeObjectURL(playUrlRef.current)
      playUrlRef.current = null
    }

    // Streamed audio cleanup
    audioNodesRef.current.forEach((src) => {
      try { src.stop() } catch { }
      try { src.disconnect() } catch { }
    })
    audioNodesRef.current = []
    nextAudioTimeRef.current = 0
    ttsStreamDoneRef.current = false
    pendingChunksRef.current = 0
    ttsChunksCountRef.current = 0
    playQueueRef.current = {
      nextPlayId: 0,
      decodedChunks: new Map(),
      isPlaying: false,
    }
  }, [])

  // ── Check if all audio chunks have played ───────────────────────────────
  const checkAudioPlaybackDone = useCallback((replyId) => {
    if (replyId !== activeReplyIdRef.current) return
    if (!ttsStreamDoneRef.current) return
    if (pendingChunksRef.current > 0) return
    logTime(`[AudioQueue] ✅ All chunks played.`)
    onAllAudioDoneRef.current?.()
  }, [])

  // ── Schedule decoded chunks in order ────────────────────────────────────
  const triggerPlayback = useCallback((replyId) => {
    if (replyId !== activeReplyIdRef.current) return
    const ctx = audioCtxRef.current
    if (!ctx || ctx.state === 'closed') return

    const q = playQueueRef.current
    while (q.decodedChunks.has(q.nextPlayId)) {
      const chunkId = q.nextPlayId
      const buffer = q.decodedChunks.get(chunkId)
      q.nextPlayId++

      if (buffer === null) {
        logTime(`[AudioQueue] Skipping failed chunk #${chunkId}`)
        pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1)
        checkAudioPlaybackDone(replyId)
        continue
      }

      const isFirstChunk = nextAudioTimeRef.current === 0
      const now = ctx.currentTime
      const startAt = Math.max(nextAudioTimeRef.current, now + 0.04)
      nextAudioTimeRef.current = startAt + buffer.duration

      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      audioNodesRef.current.push(src)
      src.start(startAt)
      logTime(`[AudioQueue] ▶ Chunk #${chunkId} scheduled @ +${(startAt - now).toFixed(3)}s, dur=${buffer.duration.toFixed(2)}s`)

      if (isFirstChunk) {
        if (!firstAudioPlayLoggedRef.current && queryStartTimeRef.current > 0) {
          firstAudioPlayLoggedRef.current = true
          const lat = Date.now() - queryStartTimeRef.current
          console.log(`[Metrics] 🔊 First Audio Play Latency: ${lat}ms`)
        }
        speakingStartRef.current = 0
        onSpeakingStartRef.current?.()

        // Set refractory timestamp exactly when audio starts emitting
        const msUntilPlay = Math.max(0, (startAt - now) * 1000)
        setTimeout(() => {
          if (replyId === activeReplyIdRef.current) {
            speakingStartRef.current = Date.now()
            logTime(`[AudioQueue] Refractory window started.`)
          }
        }, msUntilPlay)
      }

      src.onended = () => {
        audioNodesRef.current = audioNodesRef.current.filter((n) => n !== src)
        pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1)
        logTime(`[AudioQueue] Chunk #${chunkId} ended. pending=${pendingChunksRef.current}`)
        checkAudioPlaybackDone(replyId)
      }
    }
  }, [checkAudioPlaybackDone])

  // ── Enqueue one TTS chunk (decode + schedule) ───────────────────────────
  const enqueueChunk = useCallback((base64, chunkId, replyId) => {
    if (replyId !== activeReplyIdRef.current) return

    ensureAudioContext()
    const ctx = audioCtxRef.current

    if (!firstAudioChunkLoggedRef.current && queryStartTimeRef.current > 0) {
      firstAudioChunkLoggedRef.current = true
      const lat = Date.now() - queryStartTimeRef.current
      console.log(`[Metrics] 📤 Audio Send Latency (first TTS chunk received): ${lat}ms`)
    }

    ttsChunksCountRef.current++
    pendingChunksRef.current++

    if (base64 === null) {
      playQueueRef.current.decodedChunks.set(chunkId, null)
      triggerPlayback(replyId)
      return
    }

    let ab
    try {
      ab = base64ToArrayBuffer(base64)
    } catch (err) {
      logTime(`[AudioQueue] ❌ Base64 decode failed #${chunkId}: ${err.message || err}`)
      playQueueRef.current.decodedChunks.set(chunkId, null)
      triggerPlayback(replyId)
      return
    }

    ctx.decodeAudioData(ab)
      .then((audioBuffer) => {
        if (replyId !== activeReplyIdRef.current) return
        playQueueRef.current.decodedChunks.set(chunkId, audioBuffer)
        triggerPlayback(replyId)
      })
      .catch((err) => {
        logTime(`[AudioQueue] ❌ AudioContext decode failed #${chunkId}: ${err.message || err}`)
        if (replyId === activeReplyIdRef.current) {
          playQueueRef.current.decodedChunks.set(chunkId, null)
          triggerPlayback(replyId)
        }
      })
  }, [ensureAudioContext, triggerPlayback])

  // ── tts_done signal — mark streaming done ───────────────────────────────
  const markStreamDone = useCallback((replyId) => {
    if (replyId !== activeReplyIdRef.current) return
    logTime(`[AudioQueue] tts_done signal. pending=${pendingChunksRef.current}`)
    ttsStreamDoneRef.current = true
    checkAudioPlaybackDone(replyId)
  }, [checkAudioPlaybackDone])

  // ── Returns the number of TTS chunks received this reply ────────────────
  const getStreamingChunkCount = useCallback(() => ttsChunksCountRef.current, [])

  // ── HTTP TTS fallback (used when no chunks streamed) ────────────────────
  const playFullText = useCallback(async (text, replyId) => {
    const t = String(text ?? '').trim()
    if (!t) return
    logTime(`[playFullText] called. text="${t.slice(0, 40)}...", replyId=${replyId}`)
    if (replyId == null || replyId !== activeReplyIdRef.current) {
      logTime(`[playFullText] Ignored — stale replyId.`)
      return
    }

    playbackEpochRef.current += 1
    const playEpoch = playbackEpochRef.current
    window.speechSynthesis?.cancel()

    if (playRef.current) {
      playRef.current.pause()
      playRef.current.currentTime = 0
      playRef.current = null
    }
    if (playUrlRef.current) {
      URL.revokeObjectURL(playUrlRef.current)
      playUrlRef.current = null
    }

    const onDone = () => {
      if (playEpoch !== playbackEpochRef.current) return
      if (replyId !== activeReplyIdRef.current) return
      logTime(`[playFullText] Playback completed.`)
      onAllAudioDoneRef.current?.()
    }

    const fallbackSpeak = () => {
      if (playEpoch !== playbackEpochRef.current) return
      logTime(`[playFullText] Browser SpeechSynthesis fallback...`)
      onSpeakingStartRef.current?.()
      speakingStartRef.current = 0

      window.speechSynthesis?.cancel()
      const utt = new SpeechSynthesisUtterance(t)
      const det = detectLanguage(t)
      const langMap = { gu: 'gu-IN', hi: 'hi-IN', en: 'en-IN' }
      utt.lang = langMap[det] || 'en-IN'
      utt.rate = 1.02
      utt.onstart = () => {
        speakingStartRef.current = Date.now()
        logTime(`[playFullText] Fallback TTS started (${utt.lang}).`)
      }
      utt.onend = () => {
        logTime(`[playFullText] Fallback TTS completed.`)
        onDone()
      }
      window.speechSynthesis?.speak(utt)
    }

    try {
      logTime(`[playFullText] Fetching TTS from backend...`)
      const res = await fetch(`${apiOrigin}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...voiceHeaders() },
        body: JSON.stringify({ text: t }),
      })
      if (replyId !== activeReplyIdRef.current) return
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      if (replyId !== activeReplyIdRef.current) return
      logTime(`[playFullText] TTS fetched, size: ${blob.size} bytes.`)

      onSpeakingStartRef.current?.()
      speakingStartRef.current = 0

      const url = URL.createObjectURL(blob)
      playUrlRef.current = url
      const a = new Audio(url)
      playRef.current = a
      a.onplaying = () => {
        speakingStartRef.current = Date.now()
        logTime(`[playFullText] HTML5 Audio playing.`)
      }
      a.onended = () => {
        if (playUrlRef.current === url) {
          URL.revokeObjectURL(url)
          playUrlRef.current = null
        }
        onDone()
      }
      await a.play()
    } catch (err) {
      logTime(`[playFullText] HTTP TTS failed: ${err.message || err}`)
      if (replyId === activeReplyIdRef.current) fallbackSpeak()
    }
  }, [])

  // ── Track query start time + reset metrics flags for new query ──────────
  const beginNewQuery = useCallback((queryStartTime) => {
    queryStartTimeRef.current = queryStartTime || Date.now()
    firstTokenLoggedRef.current = false
    firstAudioChunkLoggedRef.current = false
    firstAudioPlayLoggedRef.current = false
  }, [])

  const logFirstTokenIfNeeded = useCallback(() => {
    if (!firstTokenLoggedRef.current && queryStartTimeRef.current > 0) {
      firstTokenLoggedRef.current = true
      const lat = Date.now() - queryStartTimeRef.current
      console.log(`[Metrics] 🧠 LLM First Token Latency: ${lat}ms`)
    }
  }, [])

  return {
    // Refs (read-only access for VAD / WS)
    audioCtxRef,
    speakingStartRef,
    activeReplyIdRef,
    replyEpochRef,
    playbackEpochRef,

    // Streaming queue
    ensureAudioContext,
    closeAudioContext,
    enqueueChunk,
    markStreamDone,
    getStreamingChunkCount,

    // Stop all in flight
    stopAll,

    // HTTP / browser fallback
    playFullText,

    // Phase callbacks
    onSpeakingStart,
    onAllAudioDone,

    // Metrics
    beginNewQuery,
    logFirstTokenIfNeeded,
  }
}