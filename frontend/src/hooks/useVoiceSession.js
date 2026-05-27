import { useCallback, useEffect, useRef, useState } from 'react'
import { buildWsChatUrl, chatApiKey } from '../config'

function logTime(msg) {
  const d = new Date()
  const ts = `${d.toLocaleTimeString('en-IN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  console.log(`[${ts}] ${msg}`)
}

// VAD tuning — same values as before
const VAD_THRESHOLD = 40
const VAD_FRAMES = 10

/**
 * Voice session hook: WebSocket connection, MediaRecorder streaming,
 * VAD (Voice Activity Detection) with barge-in.
 *
 * @param {object} opts
 * @param {object} opts.audio                - object returned by useAudioPlayback()
 * @param {object} opts.history              - object returned by useChatHistory()
 * @param {(text: string) => void} opts.setInterimText
 * @param {(p: string) => void} opts.setPhase
 * @param {() => string} opts.getPhase       - getter for current phase
 *
 * Returns:
 *  - wsReady, wsError
 *  - isMuted, isCallStarted, statusLine
 *  - startCall(), endCall(), toggleMute()
 *  - sendQuestion(text) — for typed input (not used in voice mode but kept)
 */
export function useVoiceSession({ audio, history, setInterimText, setPhase, getPhase }) {
  // ── State ──────────────────────────────────────────────────────────────
  const [wsReady, setWsReady] = useState(false)
  const [wsError, setWsError] = useState('')
  const [isMuted, setIsMuted] = useState(false)
  const [isCallStarted, setIsCallStarted] = useState(false)
  const [statusLine, setStatusLine] = useState('')

  // ── Refs ───────────────────────────────────────────────────────────────
  const wsRef = useRef(null)
  const micStreamRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const phaseRef = useRef('idle')
  const mutedRef = useRef(false)
  const callStartedRef = useRef(false)
  const isListeningRef = useRef(false)
  const sttReadyRef = useRef(false)
  const assistantDraftRef = useRef('')

  // VAD refs
  const vadStreamRef = useRef(null)
  const vadContextRef = useRef(null)
  const vadRafRef = useRef(null)
  const vadLoudFrames = useRef(0)

  // ── "Latest value" refs for objects with unstable identity ─────────────
  // These prevent re-running effects when audio/history object identity
  // changes (which happens on every render since hooks return new objects).
  const audioRef = useRef(audio)
  const historyRef = useRef(history)
  audioRef.current = audio
  historyRef.current = history

  // ── Helper: keep phase ref in sync ─────────────────────────────────────
  const updatePhase = useCallback((p) => {
    // Early return if phase unchanged — avoids redundant setPhase calls and
    // log spam from token handlers that fire updatePhase('thinking') per token.
    if (phaseRef.current === p) return
    logTime(`[updatePhase] "${phaseRef.current}" -> "${p}"`)
    phaseRef.current = p
    setPhase(p)
  }, [setPhase])

  // ── Listening helper (just updates phase) ──────────────────────────────
  const startListening = useCallback(() => {
    if (mutedRef.current) {
      logTime(`[startListening] Skipped — mic is muted.`)
      return
    }
    if (phaseRef.current === 'idle') return
    if (phaseRef.current !== 'thinking' && phaseRef.current !== 'speaking') {
      updatePhase('listening')
    }
    setInterimText('')
    setStatusLine('')
  }, [updatePhase, setInterimText])

  // ── VAD: stop polling ──────────────────────────────────────────────────
  const stopVAD = useCallback(() => {
    if (vadRafRef.current != null) {
      cancelAnimationFrame(vadRafRef.current)
      vadRafRef.current = null
    }
    vadStreamRef.current = null
    vadLoudFrames.current = 0
  }, [])

  // ── VAD: start always-on analyser ──────────────────────────────────────
  const startVAD = useCallback((stream, bargeInFn) => {
    stopVAD()
    vadStreamRef.current = stream

    if (!vadContextRef.current || vadContextRef.current.state === 'closed') {
      vadContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (vadContextRef.current.state === 'suspended') {
      vadContextRef.current.resume().catch(() => { })
    }
    const ctx = vadContextRef.current

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256

    const src = ctx.createMediaStreamSource(stream)
    src.connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)

    function tick() {
      analyser.getByteFrequencyData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i]
      const rms = sum / buf.length

      const p = phaseRef.current
      const now = Date.now()
      const speakingStart = audioRef.current.speakingStartRef.current
      const timeSinceSpeakingStart = speakingStart ? now - speakingStart : 0
      const isRefractory = p === 'speaking' && (!speakingStart || timeSinceSpeakingStart <= 1000)

      const shouldDetect =
        !mutedRef.current &&
        rms > VAD_THRESHOLD &&
        p === 'speaking' &&
        !isRefractory

      if (rms > VAD_THRESHOLD && !mutedRef.current) {
        if (p === 'thinking' || p === 'speaking') {
          if (shouldDetect) {
            vadLoudFrames.current += 1
            logTime(`[VAD] Sound (${rms.toFixed(1)}) frames=${vadLoudFrames.current}/${VAD_FRAMES}`)
            if (vadLoudFrames.current >= VAD_FRAMES) {
              logTime(`[VAD] Threshold met. Barge-in.`)
              vadLoudFrames.current = 0
              bargeInFn()
            }
          } else {
            if (isRefractory) {
              logTime(`[VAD] Ignored (${rms.toFixed(1)}) refractory (${timeSinceSpeakingStart}ms)`)
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
  }, [stopVAD])

  // ── Mute toggle ────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const nowMuted = !mutedRef.current
    mutedRef.current = nowMuted
    setIsMuted(nowMuted)

    if (micStreamRef.current) {
      micStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !nowMuted })
      logTime(`[toggleMute] Mic tracks enabled: ${!nowMuted}`)
    }

    if (nowMuted) {
      isListeningRef.current = false
      setInterimText('')
      if (phaseRef.current === 'listening') updatePhase('active')
    } else {
      if (phaseRef.current === 'active' || phaseRef.current === 'listening') {
        updatePhase('active')
        setTimeout(() => startListening(), 150)
      }
    }
  }, [updatePhase, startListening, setInterimText])

  // ── Register audio phase callbacks ONCE on mount ───────────────────────
  // Uses audioRef.current so identity changes of audio object don't re-run.
  useEffect(() => {
    audioRef.current.onSpeakingStart(() => {
      updatePhase('speaking')
    })
    audioRef.current.onAllAudioDone(() => {
      updatePhase('active')
      setTimeout(() => startListening(), 300)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once

  // ── WebSocket message handler (re-created each render, that's OK) ──────
  // We DON'T use it as a useEffect dep — we use handleMessageRef instead.
  const handleMessage = (ev) => {
    let data
    try { data = JSON.parse(ev.data) } catch { return }

    const audio = audioRef.current
    const history = historyRef.current

    if (data.type === 'stt_ready') {
      logTime(`[WS] stt_ready received.`)
      sttReadyRef.current = true
      if (callStartedRef.current && mediaRecorderRef.current?.state === 'inactive') {
        logTime(`[WS] Starting MediaRecorder.`)
        mediaRecorderRef.current.start(250)
      }
      return
    }

    if (!callStartedRef.current) return

    const isStaleReply = () => {
      const stale = audio.activeReplyIdRef.current === 0 ||
        audio.replyEpochRef.current !== audio.activeReplyIdRef.current
      if (stale) logTime(`[WS] Ignored ${data.type} — stale reply.`)
      return stale
    }

    if (data.type === 'interim_transcript') {
      // Only show interim transcripts when we're actually listening for user input.
      // Late events from other Deepgram sockets can arrive during thinking/speaking
      // phases — those are stale and should not be displayed.
      const p = phaseRef.current
      if (p === 'listening' || p === 'active') {
        setInterimText(data.text)
      } else {
        // Defensive: ensure no stale interim text lingers during thinking/speaking
        setInterimText('')
      }
      return
    }

    if (data.type === 'user_question') {
      logTime(`[WS] user_question: "${data.text}"`)
      audio.stopAll()
      audio.activeReplyIdRef.current = audio.replyEpochRef.current
      history.pruneInterruptedAssistant()
      setInterimText('')
      setStatusLine('')
      updatePhase('thinking')

      audio.beginNewQuery(data.queryStartTime)
      if (data.sttLatency) {
        console.log(`[Metrics] 🎙️ STT Latency: ${data.sttLatency}ms`)
      }

      history.addUserMessage(data.text)
      history.addAssistantPlaceholder()
      return
    }

    if (data.type === 'tts_chunk') {
      logTime(`[WS] tts_chunk #${data.chunkId ?? 0}`)
      if (isStaleReply()) return
      audio.enqueueChunk(data.audio, data.chunkId ?? 0, audio.activeReplyIdRef.current)
      return
    }

    if (data.type === 'tts_done') {
      logTime(`[WS] tts_done`)
      if (isStaleReply()) return
      audio.markStreamDone(audio.activeReplyIdRef.current)
      return
    }

    if (data.type === 'token' && data.text) {
      if (isStaleReply()) return
      audio.logFirstTokenIfNeeded()
      assistantDraftRef.current += data.text
      updatePhase('thinking')
      history.appendAssistantToken(data.text)
      return
    }

    if (data.type === 'done') {
      logTime(`[WS] done. sources=${data.sources?.length ?? 0}`)
      if (isStaleReply()) return
      const full = assistantDraftRef.current
      const replyId = audio.activeReplyIdRef.current
      assistantDraftRef.current = ''
      history.finalizeAssistant(data.sources)

      // HTTP TTS fallback only if no streaming chunks arrived
      if (audio.getStreamingChunkCount() === 0) {
        logTime(`[WS] No TTS chunks — HTTP fallback.`)
        void audio.playFullText(full, replyId)
      } else {
        logTime(`[WS] Streaming active (${audio.getStreamingChunkCount()} chunks).`)
      }
      return
    }

    if (data.type === 'error') {
      logTime(`[WS] error: ${JSON.stringify(data)}`)
      if (data.code === 'busy') return
      if (isStaleReply()) return
      setWsError(data.message || data.code || 'chat error')
      assistantDraftRef.current = ''
      updatePhase('active')
      history.markAssistantError(data.message || data.code || 'unknown')
      setTimeout(() => startListening(), 500)
    }
  }

  // ── Latest-value ref for handleMessage ─────────────────────────────────
  // This is the KEY FIX. WS effect runs ONCE on mount; ws.onmessage reads
  // the latest handleMessage via this ref. No more reconnect loop.
  const handleMessageRef = useRef(handleMessage)
  handleMessageRef.current = handleMessage

  // ── WebSocket connection + auto-reconnect (RUNS ONCE) ──────────────────
  useEffect(() => {
    const url = buildWsChatUrl()
    const shouldReconnect = { current: true }
    let reconnectTimer = null
    let attempt = 0
    let ws = null

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
      ws.onopen = () => { attempt = 0; setWsReady(true); setWsError('') }
      // Use ref so re-renders don't change the handler identity
      ws.onmessage = (ev) => handleMessageRef.current?.(ev)
      ws.onerror = () => {
        setWsError('WebSocket error — is the backend running?')
        sttReadyRef.current = false
      }
      ws.onclose = () => {
        setWsReady(false)
        sttReadyRef.current = false
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Empty deps — connect once on mount, cleanup on unmount

  // ── Send typed question (kept for completeness, voice flow uses STT) ───
  const sendQuestion = useCallback((questionText) => {
    const q = String(questionText ?? '').trim()
    if (!q) return
    logTime(`[sendQuestion] "${q}"`)
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatusLine('Not connected — wait for reconnect.')
      updatePhase('active')
      return
    }

    const audio = audioRef.current
    const history = historyRef.current

    audio.stopAll()
    history.pruneInterruptedAssistant()
    setInterimText('')
    setStatusLine('')
    updatePhase('thinking')

    const historyForApi = history.buildHistoryPayload()
    audio.activeReplyIdRef.current = audio.replyEpochRef.current

    history.addUserMessage(q)
    history.addAssistantPlaceholder()

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

    setTimeout(() => {
      if (audioRef.current.activeReplyIdRef.current === audioRef.current.replyEpochRef.current) {
        startListening()
      }
    }, 150)
  }, [updatePhase, setInterimText, startListening])

  // ── Start call ─────────────────────────────────────────────────────────
  const startCall = useCallback(() => {
    logTime(`[startCall] Requesting mic...`)

    const audio = audioRef.current

    // AudioContexts must be created/resumed inside user gesture!
    audio.ensureAudioContext()
    if (!vadContextRef.current || vadContextRef.current.state === 'closed') {
      vadContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (vadContextRef.current.state === 'suspended') {
      vadContextRef.current.resume().catch(() => { })
    }

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        logTime(`[startCall] Mic granted.`)
        micStreamRef.current = stream
        callStartedRef.current = true
        setIsCallStarted(true)

        let options = { mimeType: 'audio/webm;codecs=opus' }
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          console.warn(`[startCall] opus not supported. Using default.`)
          options = {}
        }

        const mediaRecorder = new MediaRecorder(stream, options)
        mediaRecorderRef.current = mediaRecorder

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            const ws = wsRef.current
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(event.data)
          }
        }
        mediaRecorder.onstart = () => logTime(`[startCall] Recorder started.`)
        mediaRecorder.onerror = (e) => logTime(`[startCall] Recorder error: ${e.error || e.message}`)

        if (sttReadyRef.current) {
          logTime(`[startCall] STT ready, starting recorder.`)
          mediaRecorder.start(250)
        } else {
          logTime(`[startCall] Waiting for stt_ready.`)
        }

        const bargeIn = () => {
          const p = phaseRef.current
          logTime(`[bargeIn] currentPhase="${p}"`)
          if (p !== 'speaking' && p !== 'thinking') return

          logTime(`[bargeIn] Executing.`)
          const audio = audioRef.current
          const history = historyRef.current

          audio.stopAll()
          audio.activeReplyIdRef.current = 0
          history.pruneInterruptedAssistant()

          const ws = wsRef.current
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'interrupt' }))
            logTime(`[bargeIn] interrupt sent`)
          }

          updatePhase('listening')
          setTimeout(() => startListening(), 80)
        }

        startVAD(stream, bargeIn)

        // Greeting
        void audio.playFullText(
          "Hello! I'm your TaxOne support agent. How can I help you today?",
          audio.activeReplyIdRef.current,
        )

        updatePhase('active')
      })
      .catch((err) => {
        logTime(`[startCall] Mic denied: ${err.message || err}`)
        setStatusLine('Microphone permission denied. Please allow mic access.')
        updatePhase('idle')
      })
  }, [updatePhase, startListening, startVAD])

  // ── End call ───────────────────────────────────────────────────────────
  const endCall = useCallback(() => {
    callStartedRef.current = false
    setIsCallStarted(false)

    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop()
        }
      } catch (err) {
        logTime(`[endCall] Recorder stop error: ${err.message || err}`)
      }
      mediaRecorderRef.current = null
    }

    if (micStreamRef.current) {
      try {
        micStreamRef.current.getTracks().forEach((t) => t.stop())
      } catch (err) {
        logTime(`[endCall] Stream tracks stop error: ${err.message || err}`)
      }
      micStreamRef.current = null
    }

    isListeningRef.current = false
    const audio = audioRef.current
    audio.stopAll()
    stopVAD()
    audio.closeAudioContext()

    if (vadContextRef.current && vadContextRef.current.state !== 'closed') {
      vadContextRef.current.close().catch(() => { })
      vadContextRef.current = null
    }

    audio.replyEpochRef.current = 0
    audio.activeReplyIdRef.current = 0
    audio.playbackEpochRef.current = 0
    historyRef.current.reset()
    assistantDraftRef.current = ''
    setInterimText('')
    updatePhase('idle')
    setStatusLine('')
    setWsError('')
  }, [updatePhase, stopVAD, setInterimText])

  return {
    // State
    wsReady,
    wsError,
    isMuted,
    isCallStarted,
    statusLine,

    // Actions
    startCall,
    endCall,
    toggleMute,
    sendQuestion,
  }
}