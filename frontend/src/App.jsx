import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiOrigin,
  buildWsChatUrl,
  chatApiKey,
  voiceHeaders,
} from './config'

/** @typedef {'idle' | 'active' | 'listening' | 'thinking' | 'speaking'} Phase */

const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition || null

function logTime(msg) {
  const d = new Date()
  const ts = `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  console.log(`[${ts}] ${msg}`)
}

/** Decode a base64 string into an ArrayBuffer for Web AudioContext */
function base64ToArrayBuffer(b64) {
  const binStr = atob(b64)
  const bytes  = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i)
  return bytes.buffer
}

/**
 * VAD config — tune these if barge-in is too sensitive or too sluggish.
 * RMS is on a 0-255 scale (byte frequency data average).
 * We require VAD_FRAMES consecutive loud frames before triggering to avoid
 * single pops / background noise causing false positives.
 *  - 60 fps rAF → 5 frames ≈ 83 ms latency (well under the 300 ms target)
 */
const VAD_THRESHOLD = 40   // 0-255 — raise if too sensitive to background noise (increased from 20)
const VAD_FRAMES    = 10   // consecutive loud frames required before barge-in (increased from 5 to ~160ms)

function buildHistoryPayload(messages) {
  return messages
    .filter(
      (m) =>
        m.content &&
        !m.error &&
        (m.role === 'user' || m.role === 'assistant'),
    )
    .filter((m) => !m.streaming)
    .map((m) => ({ role: m.role, content: m.content }))
}

export default function App() {
  const [messages, setMessages]     = useState([])
  const [phase, setPhase]           = useState(/** @type {Phase} */ ('idle'))
  const [wsReady, setWsReady]       = useState(false)
  const [wsError, setWsError]       = useState('')
  const [statusLine, setStatusLine] = useState('')
  const [interimText, setInterimText] = useState('')
  const [isMuted, setIsMuted]       = useState(false)

  // ── Core refs ────────────────────────────────────────────────────────────
  const wsRef              = useRef(null)
  const assistantDraftRef  = useRef('')
  const messagesRef        = useRef([])
  const playRef            = useRef(/** @type {HTMLAudioElement | null} */ (null))
  const playUrlRef         = useRef(/** @type {string | null} */ (null))
  const recognitionRef     = useRef(/** @type {InstanceType<typeof SpeechRecognitionAPI> | null} */ (null))
  const phaseRef           = useRef(/** @type {Phase} */ ('idle'))
  const isListeningRef     = useRef(false)
  const mutedRef           = useRef(false)
  /** Set to true once user clicks "Call support" */
  const callStartedRef     = useRef(false)
  /** Bumped on interrupt / new question — invalidates stale WS tokens + TTS */
  const replyEpochRef      = useRef(0)
  /** Id of the in-flight WS reply */
  const activeReplyIdRef   = useRef(0)
  const playbackEpochRef   = useRef(0)
  const speakingStartRef   = useRef(0)

  // ── Streaming audio queue (AudioContext-based) ─────────────────────────────
  const audioCtxRef       = useRef(/** @type {AudioContext | null} */ (null))
  const audioNodesRef     = useRef(/** @type {AudioBufferSourceNode[]} */ ([]))
  const nextAudioTimeRef  = useRef(0)            // ctx.currentTime for next chunk
  const ttsStreamDoneRef  = useRef(false)        // true after tts_done received
  const pendingChunksRef  = useRef(0)            // chunks in decode/play pipeline
  const decodingChainRef  = useRef(Promise.resolve()) // serialise decodeAudioData
  const ttsChunksCountRef = useRef(0)            // tts_chunk count this reply

  // ── VAD refs ─────────────────────────────────────────────────────────────
  const vadStreamRef      = useRef(/** @type {MediaStream | null} */ (null))
  const vadContextRef     = useRef(/** @type {AudioContext | null} */ (null))
  const vadRafRef         = useRef(/** @type {number | null} */ (null))
  const vadLoudFrames     = useRef(0)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // ─────────────────────────────────────────────────────────────────────────
  const updatePhase = useCallback((/** @type {Phase} */ p) => {
    logTime(`[updatePhase] "${phaseRef.current}" -> "${p}"`)
    phaseRef.current = p
    setPhase(p)
  }, [])

  // ── Stop TTS / playback and invalidate in-flight reply ───────────────────
  const stopAgentOutput = useCallback(() => {
    logTime(`[stopAgentOutput] Stopping. epoch→${replyEpochRef.current + 1}`)
    replyEpochRef.current    += 1
    playbackEpochRef.current += 1
    speakingStartRef.current  = 0
    assistantDraftRef.current = ''
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
    // Stop all streamed AudioContext source nodes
    audioNodesRef.current.forEach((src) => {
      try { src.stop() } catch {}
      try { src.disconnect() } catch {}
    })
    audioNodesRef.current     = []
    nextAudioTimeRef.current  = 0
    ttsStreamDoneRef.current  = false
    pendingChunksRef.current  = 0
    ttsChunksCountRef.current = 0
    decodingChainRef.current  = Promise.resolve()
  }, [])

  // ── Drop incomplete streaming assistant bubble after interrupt ────────────
  const pruneInterruptedAssistant = useCallback(() => {
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last?.role === 'assistant' && (last.streaming || !last.content?.trim())) {
        next.pop()
      }
      return next
    })
  }, [])

  // ── Start SpeechRecognition ───────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (mutedRef.current) {
      logTime(`[startListening] Skipped starting SpeechRecognition because mic is muted.`)
      return
    }
    const rec = recognitionRef.current
    if (!rec) {
      logTime(`[startListening] Skipped starting SpeechRecognition because recognitionRef.current is null.`)
      return
    }
    if (isListeningRef.current) {
      logTime(`[startListening] Skipped starting SpeechRecognition because it is already listening (isListeningRef=true).`)
      return
    }
    if (phaseRef.current === 'idle') {
      logTime(`[startListening] Skipped starting SpeechRecognition because phase is idle.`)
      return
    }
    try {
      logTime(`[startListening] Calling SpeechRecognition.start()...`)
      rec.start()
      isListeningRef.current = true
      if (phaseRef.current !== 'thinking') {
        updatePhase('listening')
      }
      setInterimText('')
      setStatusLine('')
    } catch (err) {
      logTime(`[startListening] SpeechRecognition.start() threw: ${err.message || err} (already running/starting).`)
    }
  }, [updatePhase])

  // ── VAD: stop ────────────────────────────────────────────────────────────
  const stopVAD = useCallback(() => {
    if (vadRafRef.current != null) {
      cancelAnimationFrame(vadRafRef.current)
      vadRafRef.current = null
    }
    if (vadContextRef.current) {
      vadContextRef.current.close().catch(() => {})
      vadContextRef.current = null
    }
    if (vadStreamRef.current) {
      vadStreamRef.current.getTracks().forEach((t) => t.stop())
      vadStreamRef.current = null
    }
    vadLoudFrames.current = 0
  }, [])

  // ── VAD: start — always-on AudioContext analyser polling loop ────────────
  const startVAD = useCallback(
    (bargeInFn) => {
      stopVAD()
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        .then((stream) => {
          vadStreamRef.current = stream

          const ctx = new AudioContext()
          vadContextRef.current = ctx

          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256  // 128 frequency bins — fast & sufficient

          const src = ctx.createMediaStreamSource(stream)
          src.connect(analyser)   // NOT connected to destination → no echo

          const buf = new Uint8Array(analyser.frequencyBinCount)

          function tick() {
            analyser.getByteFrequencyData(buf)

            // Average energy across all frequency bins (0-255 scale)
            let sum = 0
            for (let i = 0; i < buf.length; i++) sum += buf[i]
            const rms = sum / buf.length

            const p = phaseRef.current
            const now = Date.now()
            const timeSinceSpeakingStart = speakingStartRef.current ? now - speakingStartRef.current : 0
            const isRefractory = p === 'speaking' && (!speakingStartRef.current || timeSinceSpeakingStart <= 1000)

            const shouldDetect =
              !mutedRef.current &&
              rms > VAD_THRESHOLD &&
              p === 'speaking' &&
              !isRefractory

            if (rms > VAD_THRESHOLD && !mutedRef.current) {
              if (p === 'thinking' || p === 'speaking') {
                if (shouldDetect) {
                  vadLoudFrames.current += 1
                  logTime(`[VAD] Sound detected above threshold (${rms.toFixed(1)} > ${VAD_THRESHOLD}) while speaking. Loud frame count: ${vadLoudFrames.current}/${VAD_FRAMES}`)
                  if (vadLoudFrames.current >= VAD_FRAMES) {
                    logTime(`[VAD] Loud frames threshold met. Triggering barge-in callback.`)
                    vadLoudFrames.current = 0
                    bargeInFn()
                  }
                } else {
                  if (isRefractory) {
                    logTime(`[VAD] Ignored sound (${rms.toFixed(1)} > ${VAD_THRESHOLD}) during speaking refractory period (${timeSinceSpeakingStart}ms)`)
                  } else {
                    logTime(`[VAD] Ignored sound (${rms.toFixed(1)} > ${VAD_THRESHOLD}) during phase: "${p}"`)
                  }
                  vadLoudFrames.current = 0
                }
              } else {
                vadLoudFrames.current = 0
              }
            } else {
              vadLoudFrames.current = 0
            }

            vadRafRef.current = requestAnimationFrame(tick)
          }

          vadRafRef.current = requestAnimationFrame(tick)
        })
        .catch(() => {
          // Mic denied or not available — VAD silently disabled; user can still
          // tap to interrupt via the stop agent output path.
        })
    },
    [stopVAD],
  )

  // ── Toggle mute ───────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const nowMuted = !mutedRef.current
    mutedRef.current = nowMuted
    setIsMuted(nowMuted)

    if (nowMuted) {
      const rec = recognitionRef.current
      if (rec && isListeningRef.current) {
        try { rec.stop(); } catch { /* ignore */ }
      }
      isListeningRef.current = false
      setInterimText('')
      if (phaseRef.current === 'listening') {
        updatePhase('active')
      }
    } else {
      if (phaseRef.current === 'active' || phaseRef.current === 'listening') {
        updatePhase('active')
        setTimeout(() => startListening(), 150)
      }
    }
  }, [startListening, updatePhase])

  // ── Send question to backend ──────────────────────────────────────────────
  const sendQuestion = useCallback(
    (questionText) => {
      const q = String(questionText ?? '').trim()
      if (!q) return
      logTime(`[sendQuestion] Sending final question: "${q}"`)
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logTime(`[sendQuestion] WebSocket not open! readyState=${ws?.readyState}`)
        setStatusLine('Not connected — wait for reconnect.')
        updatePhase('active')
        return
      }

      stopAgentOutput()
      pruneInterruptedAssistant()
      setInterimText('')
      setStatusLine('')
      updatePhase('thinking')

      const historyForApi = buildHistoryPayload(messagesRef.current)
      activeReplyIdRef.current = replyEpochRef.current
      logTime(`[sendQuestion] Generated activeReplyIdRef = ${activeReplyIdRef.current}`)

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: q },
        { role: 'assistant', content: '', streaming: true, sources: [] },
      ])

      const payload = { question: q, history: historyForApi }
      if (chatApiKey) {
        try {
          const hasKey = new URL(buildWsChatUrl()).searchParams.has('apiKey')
          if (!hasKey) payload.apiKey = chatApiKey
        } catch {
          payload.apiKey = chatApiKey
        }
      }
      ws.send(JSON.stringify(payload))
      logTime(`[sendQuestion] WebSocket payload sent.`)

      // Keep mic open during thinking so the user can barge in again
      setTimeout(() => {
        if (activeReplyIdRef.current === replyEpochRef.current) {
          logTime(`[sendQuestion] Re-starting listening after 150ms delay.`)
          startListening()
        }
      }, 150)
    },
    [updatePhase, stopAgentOutput, pruneInterruptedAssistant, startListening],
  )

  // ── Play agent TTS reply ──────────────────────────────────────────────────
  const playAgentReply = useCallback(
    async (text, replyId) => {
      const t = String(text ?? '').trim()
      if (!t) return
      logTime(`[playAgentReply] playAgentReply called. text="${t.slice(0, 40)}...", replyId=${replyId}, active=${activeReplyIdRef.current}`)
      if (replyId == null || replyId !== activeReplyIdRef.current) {
        logTime(`[playAgentReply] Ignored playAgentReply call because replyId doesn't match activeReplyId (${activeReplyIdRef.current})`)
        return
      }

      playbackEpochRef.current += 1
      const playEpoch = playbackEpochRef.current
      logTime(`[playAgentReply] Set playEpoch = ${playEpoch}`)
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

      // VAD (AudioContext) stays running so it can still detect barge-in.
      const rec = recognitionRef.current

      const onDone = () => {
        if (playEpoch !== playbackEpochRef.current) {
          logTime(`[playAgentReply] onDone ignored: playEpoch mismatch. playEpoch=${playEpoch}, current=${playbackEpochRef.current}`)
          return
        }
        if (replyId == null || replyId !== activeReplyIdRef.current) {
          logTime(`[playAgentReply] onDone ignored: activeReplyId mismatch. replyId=${replyId}, active=${activeReplyIdRef.current}`)
          return
        }
        logTime(`[playAgentReply] Playback completed. Transitioning back to active.`)
        updatePhase('active')
        setTimeout(() => {
          logTime(`[playAgentReply] Re-starting listening after 300ms post-play delay.`)
          startListening()
        }, 300)
      }

      const fallbackSpeak = () => {
        if (playEpoch !== playbackEpochRef.current) return
        logTime(`[playAgentReply] Triggering browser SpeechSynthesis fallback...`)
        
        updatePhase('speaking')
        speakingStartRef.current = 0
        if (rec && isListeningRef.current) {
          logTime(`[playAgentReply] Stopping SpeechRecognition to prevent echo feedback.`)
          try { rec.stop(); } catch { /* ignore */ }
          isListeningRef.current = false
        }

        window.speechSynthesis?.cancel()
        const utt = new SpeechSynthesisUtterance(t)
        utt.lang  = 'en-IN'
        utt.rate  = 1.02
        utt.onstart = () => {
          speakingStartRef.current = Date.now()
          logTime(`[playAgentReply] Fallback SpeechSynthesis started. Refractory period started.`)
        }
        utt.onend = () => {
          logTime(`[playAgentReply] Fallback SpeechSynthesis completed.`)
          onDone()
        }
        window.speechSynthesis?.speak(utt)
      }

      try {
        logTime(`[playAgentReply] Fetching TTS audio from backend API...`)
        const res = await fetch(`${apiOrigin}/api/voice/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...voiceHeaders() },
          body: JSON.stringify({ text: t }),
        })
        if (replyId == null || replyId !== activeReplyIdRef.current) {
          logTime(`[playAgentReply] TTS fetch returned, but request is now stale. Aborting.`)
          return
        }
        if (!res.ok) throw new Error(await res.text())
        const blob = await res.blob()
        if (replyId == null || replyId !== activeReplyIdRef.current) {
          logTime(`[playAgentReply] Blob conversion completed, but request is now stale. Aborting.`)
          return
        }
        logTime(`[playAgentReply] TTS fetch succeeded, size: ${blob.size} bytes. Initializing Audio playback...`)

        updatePhase('speaking')
        speakingStartRef.current = 0
        if (rec && isListeningRef.current) {
          logTime(`[playAgentReply] Stopping SpeechRecognition to prevent echo feedback.`)
          try { rec.stop(); } catch { /* ignore */ }
          isListeningRef.current = false
        }

        const url = URL.createObjectURL(blob)
        playUrlRef.current = url
        const a  = new Audio(url)
        playRef.current = a
        a.onplaying = () => {
          speakingStartRef.current = Date.now()
          logTime(`[playAgentReply] HTML5 Audio playing event fired. Refractory period started.`)
        }
        a.onended = () => {
          logTime(`[playAgentReply] HTML5 Audio ended event fired.`)
          if (playUrlRef.current === url) {
            URL.revokeObjectURL(url)
            playUrlRef.current = null
          }
          onDone()
        }
        await a.play()
        logTime(`[playAgentReply] HTML5 Audio play() promise resolved. Playing audio...`)
      } catch (err) {
        logTime(`[playAgentReply] TTS generation or playback failed: ${err.message || err}`)
        if (replyId != null && replyId === activeReplyIdRef.current) fallbackSpeak()
      }
    },
    [updatePhase, startListening],
  )

  // ── Audio queue: check if everything has played ──────────────────────────
  const checkAudioPlaybackDone = useCallback((replyId) => {
    if (replyId !== activeReplyIdRef.current) return
    if (!ttsStreamDoneRef.current) return
    if (pendingChunksRef.current > 0) return
    logTime(`[AudioQueue] ✅ All chunks played. Moving to active.`)
    updatePhase('active')
    setTimeout(() => {
      logTime(`[AudioQueue] Re-starting listening after 300ms.`)
      startListening()
    }, 300)
  }, [updatePhase, startListening])

  // ── Audio queue: decode & schedule one TTS chunk ─────────────────────────
  const enqueueAudioChunk = useCallback((base64, chunkId, replyId) => {
    if (replyId !== activeReplyIdRef.current) return

    // Lazy-create or reuse the AudioContext for this call session
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext()
      nextAudioTimeRef.current = 0
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {})
    }

    // Serialise decoding so chunks are scheduled in arrival order
    decodingChainRef.current = decodingChainRef.current.then(async () => {
      // Stale check after potential async gap
      if (replyId !== activeReplyIdRef.current) {
        pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1)
        checkAudioPlaybackDone(replyId)
        return
      }
      const ctx = audioCtxRef.current
      if (!ctx || ctx.state === 'closed') {
        pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1)
        checkAudioPlaybackDone(replyId)
        return
      }

      // Decode base64 → AudioBuffer
      let audioBuffer
      try {
        const ab = base64ToArrayBuffer(base64)
        audioBuffer = await ctx.decodeAudioData(ab)
      } catch (err) {
        logTime(`[AudioQueue] ❌ Decode failed #${chunkId}: ${err.message || err}`)
        pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1)
        checkAudioPlaybackDone(replyId)
        return
      }

      // Stale check again after the async decode
      if (replyId !== activeReplyIdRef.current) {
        pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1)
        return
      }

      // Schedule playback — seamlessly after previous chunk
      const isFirstChunk        = nextAudioTimeRef.current === 0
      const now                 = ctx.currentTime
      const startAt             = Math.max(nextAudioTimeRef.current, now + 0.04)
      nextAudioTimeRef.current  = startAt + audioBuffer.duration

      const src = ctx.createBufferSource()
      src.buffer = audioBuffer
      src.connect(ctx.destination)
      audioNodesRef.current.push(src)
      src.start(startAt)
      logTime(`[AudioQueue] ▶ Chunk #${chunkId} @ +${(startAt - now).toFixed(3)}s, dur=${audioBuffer.duration.toFixed(2)}s`)

      if (isFirstChunk) {
        // Transition to speaking phase when first audio byte is about to play
        updatePhase('speaking')
        speakingStartRef.current = 0
        // Stop SpeechRecognition to prevent microphone echo feedback
        const rec = recognitionRef.current
        if (rec && isListeningRef.current) {
          try { rec.stop() } catch {}
          isListeningRef.current = false
        }
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
    })
  }, [updatePhase, checkAudioPlaybackDone])

  // ── Audio queue: tts_done signal from backend ────────────────────────────
  const handleTtsStreamDone = useCallback((replyId) => {
    if (replyId !== activeReplyIdRef.current) return
    logTime(`[AudioQueue] tts_done signal. pending=${pendingChunksRef.current}`)
    ttsStreamDoneRef.current = true
    checkAudioPlaybackDone(replyId)
  }, [checkAudioPlaybackDone])

  // ── WebSocket connection + auto-reconnect ─────────────────────────────────
  useEffect(() => {
    const url = buildWsChatUrl()
    const shouldReconnect = { current: true }
    let reconnectTimer = null
    let attempt = 0
    let ws = null

    function handleMessage(ev) {
      if (!callStartedRef.current) return

      let data
      try { data = JSON.parse(ev.data) } catch { return }

      const isStaleReply = () => {
        const stale = activeReplyIdRef.current === 0 ||
          replyEpochRef.current !== activeReplyIdRef.current
        if (stale) {
          logTime(`[WebSocket handleMessage] Ignored message of type "${data.type}" because reply is stale. activeReplyId=${activeReplyIdRef.current}, replyEpoch=${replyEpochRef.current}`)
        }
        return stale
      }

      // ── Streaming audio chunk from backend TTS chunker ───────────────────
      if (data.type === 'tts_chunk' && data.audio) {
        logTime(`[WS] tts_chunk #${data.chunkId ?? 0} received`)
        if (isStaleReply()) return
        ttsChunksCountRef.current++
        pendingChunksRef.current++
        enqueueAudioChunk(data.audio, data.chunkId ?? 0, activeReplyIdRef.current)
        return
      }

      // ── All TTS chunks have been sent ─────────────────────────────────────
      if (data.type === 'tts_done') {
        logTime(`[WS] tts_done received`)
        if (isStaleReply()) return
        handleTtsStreamDone(activeReplyIdRef.current)
        return
      }

      if (data.type === 'token' && data.text) {
        logTime(`[WebSocket handleMessage] Received token: "${data.text}"`)
        if (isStaleReply()) return
        assistantDraftRef.current += data.text
        updatePhase('thinking')
        setMessages((prev) => {
          const next = [...prev]
          const i = next.length - 1
          if (i >= 0 && next[i].role === 'assistant') {
            next[i] = { ...next[i], content: next[i].content + data.text }
          }
          return next
        })
        return
      }

      if (data.type === 'done') {
        logTime(`[WebSocket handleMessage] Received "done" event. sourcesCount=${data.sources?.length ?? 0}`)
        if (isStaleReply()) return
        const full    = assistantDraftRef.current
        const replyId = activeReplyIdRef.current
        assistantDraftRef.current = ''
        setMessages((prev) => {
          const next = [...prev]
          const i = next.length - 1
          if (i >= 0 && next[i].role === 'assistant') {
            next[i] = { ...next[i], streaming: false, sources: data.sources ?? [] }
          }
          return next
        })
        // If TTS chunks were streamed, audio is already queued — skip HTTP TTS.
        // Fall back to HTTP TTS only when no chunks arrived (complete TTS failure).
        if (ttsChunksCountRef.current === 0) {
          logTime(`[WS] No TTS chunks received — HTTP TTS fallback`)
          void playAgentReply(full, replyId)
        } else {
          logTime(`[WS] Audio streaming active (${ttsChunksCountRef.current} chunks). Skipping HTTP TTS.`)
        }
        return
      }

      if (data.type === 'error') {
        logTime(`[WebSocket handleMessage] Received "error" event: ${JSON.stringify(data)}`)
        if (data.code === 'busy') return
        if (isStaleReply()) return
        setWsError(data.message || data.code || 'chat error')
        assistantDraftRef.current = ''
        updatePhase('active')
        setMessages((prev) => {
          const next = [...prev]
          const i = next.length - 1
          if (i >= 0 && next[i].role === 'assistant') {
            next[i] = {
              ...next[i],
              streaming: false,
              content: next[i].content || `Error: ${data.message || data.code || 'unknown'}`,
              error: true,
            }
          }
          return next
        })
        setTimeout(() => {
          logTime(`[WebSocket handleMessage] Re-starting listening after 500ms post-error delay.`)
          startListening()
        }, 500)
      }
    }

    function scheduleReconnect() {
      if (!shouldReconnect.current) return
      const delay = Math.min(1000 * Math.pow(2, attempt), 30_000)
      attempt += 1
      setWsReady(false)
      setWsError(`Disconnected. Reconnecting in ${Math.round(delay / 1000)}s…`)
      reconnectTimer = setTimeout(connect, delay)
    }

    function connect() {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen  = () => { attempt = 0; setWsReady(true); setWsError('') }
      ws.onmessage = handleMessage
      ws.onerror = () => setWsError('WebSocket error — is the backend running?')
      ws.onclose = () => {
        setWsReady(false)
        wsRef.current = null
        if (shouldReconnect.current) scheduleReconnect()
      }
    }

    connect()
    return () => {
      shouldReconnect.current = false
      clearTimeout(reconnectTimer)
      ws?.close()
      wsRef.current = null
    }
  }, [playAgentReply, updatePhase, startListening, enqueueAudioChunk, handleTtsStreamDone])

  // ── Start call ───────────────────────────────────────────────────────────
  const startCall = useCallback(() => {
    if (!SpeechRecognitionAPI) {
      updatePhase('active')
      setStatusLine('Speech recognition is not supported in this browser. Please use Chrome.')
      return
    }

    const rec = new SpeechRecognitionAPI()
    rec.lang           = 'en-IN'
    rec.continuous     = false   // fire one result per utterance
    rec.interimResults = true    // live transcription

    rec.onresult = (e) => {
      const results = Array.from(e.results)
      const interim = results
        .filter((r) => !r.isFinal)
        .map((r) => r[0].transcript)
        .join('')
        .trim()
      const final = results
        .filter((r) => r.isFinal)
        .map((r) => r[0].transcript)
        .join('')
        .trim()

      setInterimText(interim)

      if (final) {
        isListeningRef.current = false
        setInterimText('')
        sendQuestion(final)
      }
    }

    rec.onerror = (e) => {
      isListeningRef.current = false
      setInterimText('')
      if (e.error === 'not-allowed') {
        setStatusLine('Microphone permission denied. Please allow mic access.')
        updatePhase('active')
      }
      // 'no-speech', 'audio-capture' → onend restarts automatically
    }

    rec.onend = () => {
      isListeningRef.current = false
      setInterimText('')
      const p = phaseRef.current
      if (!mutedRef.current && (p === 'listening' || p === 'active')) {
        setTimeout(() => startListening(), 200)
      }
    }

    recognitionRef.current = rec
    callStartedRef.current = true

    // ── Barge-in callback — fired by VAD when voice detected during agent output ──
    const bargeIn = () => {
      const p = phaseRef.current
      logTime(`[bargeIn] Barge-in callback triggered. currentPhase="${p}"`)
      if (p !== 'speaking' && p !== 'thinking') {
        logTime(`[bargeIn] Ignored barge-in because phase is not speaking/thinking.`)
        return
      }
      logTime(`[bargeIn] Executing stopAgentOutput and canceling in-flight response.`)
      stopAgentOutput()
      activeReplyIdRef.current = 0
      pruneInterruptedAssistant()
      updatePhase('listening')
      // Small delay so any SpeechRecognition stop() settles before we restart
      setTimeout(() => {
        logTime(`[bargeIn] Re-starting listening after 80ms post-bargein delay.`)
        startListening()
      }, 80)
    }

    // Start always-on VAD — runs on a separate AudioContext stream,
    // independent of SpeechRecognition state.
    startVAD(bargeIn)

    void playAgentReply(
      "Hello! I'm your TaxOne support agent. How can I help you today?",
      activeReplyIdRef.current,
    )
  }, [
    sendQuestion,
    startListening,
    updatePhase,
    playAgentReply,
    stopAgentOutput,
    pruneInterruptedAssistant,
    startVAD,
  ])

  // ── End call ─────────────────────────────────────────────────────────────
  const endCall = useCallback(() => {
    callStartedRef.current = false
    const rec = recognitionRef.current
    if (rec) {
      rec.onresult = null
      rec.onerror  = null
      rec.onend    = null
      try { rec.stop(); } catch { /* ignore */ }
      recognitionRef.current = null
    }
    isListeningRef.current = false
    stopAgentOutput()
    stopVAD()
    // Close AudioContext to free OS audio resources
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    replyEpochRef.current    = 0
    activeReplyIdRef.current = 0
    playbackEpochRef.current = 0
    setMessages([])
    assistantDraftRef.current = ''
    setInterimText('')
    updatePhase('idle')
    setStatusLine('')
    setWsError('')
  }, [updatePhase, stopAgentOutput, stopVAD])

  // ── Derived UI ────────────────────────────────────────────────────────────
  const lastAssistant = messages.filter((m) => m.role === 'assistant').pop()
  const lastUser      = messages.filter((m) => m.role === 'user').pop()

  const phaseLabel =
    phase === 'idle'     ? 'Ready' :
    isMuted              ? 'Muted' :
    phase === 'active'   ? 'On call' :
    phase === 'listening'? 'Listening…' :
    phase === 'thinking' ? 'Agent is thinking…' :
                           'Agent is speaking'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/90 shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-8 pb-6 text-center border-b border-slate-800">
          <p className="text-xs uppercase tracking-widest text-slate-500">Vyapar TaxOne</p>
          <h1 className="text-xl font-semibold mt-1">Support call</h1>
          <p className="text-xs text-slate-500 mt-1">Voice agent · RAG · Barge-in enabled</p>
        </div>

        {/* Avatar + status */}
        <div className="px-6 py-10 flex flex-col items-center">
          <div
            className={`w-32 h-32 rounded-full flex items-center justify-center text-4xl mb-6 transition-all duration-300 ${
              isMuted
                ? 'bg-slate-700/50 ring-2 ring-slate-500/40'
                : phase === 'listening'
                ? 'bg-emerald-500/30 ring-4 ring-emerald-400 animate-pulse'
                : phase === 'thinking'
                ? 'bg-amber-500/20 ring-2 ring-amber-400/50'
                : phase === 'speaking'
                ? 'bg-sky-500/20 ring-2 ring-sky-400/50'
                : phase === 'active'
                ? 'bg-emerald-600/20 ring-2 ring-emerald-500/40'
                : 'bg-slate-800'
            }`}
            aria-hidden
          >
            {isMuted ? '🔇' : phase === 'speaking' ? '🔊' : phase === 'listening' ? '🎤' : '🎧'}
          </div>

          <p className="text-sm font-medium text-slate-300">{phaseLabel}</p>

          {phase === 'speaking' && !isMuted && (
            <p className="text-[11px] text-sky-400/60 mt-1 text-center">
              Just start talking to interrupt
            </p>
          )}

          {(wsError || (!wsReady && phase !== 'idle')) && (
            <p className="text-xs text-amber-400 mt-2 text-center">
              {wsError || 'Connecting…'}
            </p>
          )}

          {statusLine && (
            <p className="text-xs text-slate-500 mt-2 text-center">{statusLine}</p>
          )}

          {/* Live interim transcription while user is speaking */}
          {interimText && (
            <p className="text-xs text-emerald-400/70 mt-3 italic text-center px-4">
              &ldquo;{interimText}&rdquo;
            </p>
          )}

          {/* Last user message */}
          {lastUser && !interimText && (
            <p className="text-xs text-slate-500 mt-4 w-full text-left line-clamp-2">
              You: <span className="text-slate-400">{lastUser.content}</span>
            </p>
          )}

          {/* Last agent message */}
          {(lastAssistant?.content || lastAssistant?.streaming) && (
            <p className="text-xs text-slate-500 mt-1 w-full text-left max-h-24 overflow-y-auto">
              Agent:{' '}
              <span className="text-slate-300">
                {lastAssistant.content}
                {lastAssistant.streaming && (
                  <span className="inline-block w-1.5 h-3 ml-0.5 bg-emerald-400 animate-pulse align-middle rounded-sm" />
                )}
              </span>
            </p>
          )}
        </div>

        {/* Controls */}
        <div className="px-6 pb-8 space-y-3">
          {phase === 'idle' ? (
            <button
              type="button"
              onClick={startCall}
              className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-lg transition-colors"
            >
              📞 Call support
            </button>
          ) : (
            <>
              {/* Mute / Unmute */}
              <button
                type="button"
                onClick={toggleMute}
                className={`w-full py-3 rounded-2xl font-medium text-sm transition-colors ${
                  isMuted
                    ? 'bg-amber-600/80 hover:bg-amber-500 text-white'
                    : 'bg-slate-700 hover:bg-slate-600 text-slate-100'
                }`}
              >
                {isMuted ? '🎤 Unmute — click to speak' : '🔇 Mute mic'}
              </button>

              {/* End call */}
              <button
                type="button"
                onClick={endCall}
                className="w-full py-3 rounded-2xl bg-red-900/80 hover:bg-red-800 text-red-100 text-sm font-medium transition-colors"
              >
                End call
              </button>
            </>
          )}
        </div>
      </div>

      <p className="text-[11px] text-slate-600 mt-6 text-center max-w-sm">
        STT: Browser Web Speech API (Chrome) · TTS: Sarvam · VAD: Web Audio API
      </p>
    </div>
  )
}
