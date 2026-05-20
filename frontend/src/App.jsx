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
  const [messages, setMessages] = useState([])
  const [phase, setPhase] = useState(/** @type {Phase} */ ('idle'))
  const [wsReady, setWsReady] = useState(false)
  const [wsError, setWsError] = useState('')
  const [statusLine, setStatusLine] = useState('')
  const [interimText, setInterimText] = useState('')
  const [isMuted, setIsMuted] = useState(false)

  const wsRef = useRef(null)
  const assistantDraftRef = useRef('')
  const messagesRef = useRef([])
  const playRef = useRef(/** @type {HTMLAudioElement | null} */ (null))
  const playUrlRef = useRef(/** @type {string | null} */ (null))
  const recognitionRef = useRef(/** @type {InstanceType<typeof SpeechRecognitionAPI> | null} */ (null))
  const phaseRef = useRef(/** @type {Phase} */ ('idle'))
  const isListeningRef = useRef(false)
  const mutedRef = useRef(false)
  /** Set to true once user clicks "Call support" — gates all WS message handling */
  const callStartedRef = useRef(false)
  /** Bumped on interrupt / new question — ignore stale WS tokens and TTS callbacks */
  const replyEpochRef = useRef(0)
  /** Id of the in-flight WS reply (set when a question is sent) */
  const activeReplyIdRef = useRef(0)
  const playbackEpochRef = useRef(0)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  /** Set both state and ref so callbacks always have the current value */
  const updatePhase = useCallback((/** @type {Phase} */ p) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  /** Stop TTS / playback and invalidate in-flight assistant reply handling */
  const stopAgentOutput = useCallback(() => {
    replyEpochRef.current += 1
    playbackEpochRef.current += 1
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
  }, [])

  /** Drop incomplete streaming assistant bubble after interrupt */
  const pruneInterruptedAssistant = useCallback(() => {
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (
        last?.role === 'assistant' &&
        (last.streaming || !last.content?.trim())
      ) {
        next.pop()
      }
      return next
    })
  }, [])

  /** Start mic (allowed during speaking/thinking so user can interrupt) */
  const startListening = useCallback(() => {
    if (mutedRef.current) return
    const rec = recognitionRef.current
    if (!rec || isListeningRef.current) return
    if (phaseRef.current === 'idle') return
    try {
      rec.start()
      isListeningRef.current = true
      if (phaseRef.current !== 'thinking') {
        phaseRef.current = 'listening'
        setPhase('listening')
      }
      setInterimText('')
      setStatusLine('')
    } catch {
      // recognition already started — ignore
    }
  }, [])

  /** Toggle mic mute on/off */
  const toggleMute = useCallback(() => {
    const nowMuted = !mutedRef.current
    mutedRef.current = nowMuted
    setIsMuted(nowMuted)

    if (nowMuted) {
      // Stop recognition immediately
      const rec = recognitionRef.current
      if (rec && isListeningRef.current) {
        try { rec.stop() } catch {}
      }
      isListeningRef.current = false
      setInterimText('')
      // Move to 'active' so the avatar shows on-call but not listening
      if (phaseRef.current === 'listening') {
        phaseRef.current = 'active'
        setPhase('active')
      }
    } else {
      // Unmuted — restart listening if call is active
      if (phaseRef.current === 'active' || phaseRef.current === 'listening') {
        phaseRef.current = 'active'
        setPhase('active')
        setTimeout(() => startListening(), 150)
      }
    }
  }, [startListening])

  const sendQuestion = useCallback(
    (questionText) => {
      const q = String(questionText ?? '').trim()
      if (!q) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
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

      // Keep mic on during thinking so the user can interrupt again
      setTimeout(() => {
        if (activeReplyIdRef.current === replyEpochRef.current) startListening()
      }, 150)
    },
    [updatePhase, stopAgentOutput, pruneInterruptedAssistant, startListening],
  )

  const playAgentReply = useCallback(
    async (text, replyId) => {
      const t = String(text ?? '').trim()
      if (!t) return
      if (!replyId || replyId !== activeReplyIdRef.current) return

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

      updatePhase('speaking')
      startListening()

      const onDone = () => {
        if (playEpoch !== playbackEpochRef.current) return
        if (!replyId || replyId !== activeReplyIdRef.current) return
        updatePhase('active')
        setTimeout(() => startListening(), 300)
      }

      const fallbackSpeak = () => {
        if (playEpoch !== playbackEpochRef.current) return
        window.speechSynthesis?.cancel()
        const utt = new SpeechSynthesisUtterance(t)
        utt.lang = 'en-IN'
        utt.rate = 1.02
        utt.onend = onDone
        window.speechSynthesis?.speak(utt)
      }

      try {
        const res = await fetch(`${apiOrigin}/api/voice/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...voiceHeaders() },
          body: JSON.stringify({ text: t }),
        })
        if (!replyId || replyId !== activeReplyIdRef.current) return
        if (!res.ok) throw new Error(await res.text())
        const blob = await res.blob()
        if (!replyId || replyId !== activeReplyIdRef.current) return
        const url = URL.createObjectURL(blob)
        playUrlRef.current = url
        const a = new Audio(url)
        playRef.current = a
        a.onended = () => {
          if (playUrlRef.current === url) {
            URL.revokeObjectURL(url)
            playUrlRef.current = null
          }
          onDone()
        }
        await a.play()
      } catch {
        if (replyId && replyId === activeReplyIdRef.current) fallbackSpeak()
      }
    },
    [updatePhase, startListening],
  )

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

      const isStaleReply = () =>
        activeReplyIdRef.current === 0 ||
        replyEpochRef.current !== activeReplyIdRef.current

      if (data.type === 'token' && data.text) {
        if (isStaleReply()) return
        assistantDraftRef.current += data.text
        setPhase('thinking')
        phaseRef.current = 'thinking'
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
        if (isStaleReply()) return
        const full = assistantDraftRef.current
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
        void playAgentReply(full, replyId)
        return
      }

      if (data.type === 'error') {
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
        setTimeout(() => startListening(), 500)
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
      ws.onopen = () => { attempt = 0; setWsReady(true); setWsError('') }
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
  }, [playAgentReply, updatePhase, startListening])

  // ── Start call: set up SpeechRecognition and begin auto-listen ───────────
  const startCall = useCallback(() => {
    if (!SpeechRecognitionAPI) {
      updatePhase('active')
      setStatusLine('Speech recognition is not supported in this browser. Please use Chrome.')
      return
    }

    const rec = new SpeechRecognitionAPI()
    rec.lang = 'en-IN'
    rec.continuous = false      // fire one result per utterance
    rec.interimResults = true   // show live transcription while speaking

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

      const p = phaseRef.current
      const userSpeaking =
        interim.length >= 2 || final.length >= 2

      if (
        userSpeaking &&
        (p === 'speaking' || p === 'thinking')
      ) {
        stopAgentOutput()
        activeReplyIdRef.current = 0
        pruneInterruptedAssistant()
        updatePhase('listening')
        try {
          rec.stop()
        } catch {}
        isListeningRef.current = false
      }

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
      // 'no-speech', 'audio-capture', etc. → onend will restart automatically
    }

    rec.onend = () => {
      isListeningRef.current = false
      setInterimText('')
      // Auto-restart only when in 'listening' or 'active' phase AND not muted
      // Use startListening() so mutedRef and phaseRef guards run in one place
      const p = phaseRef.current
      if (!mutedRef.current && (p === 'listening' || p === 'active')) {
        setTimeout(() => startListening(), 200)
      }
    }

    recognitionRef.current = rec
    callStartedRef.current = true
    updatePhase('speaking')  // show speaking state while greeting plays
    // Play the greeting now that recognition is ready.
    // playAgentReply sets phase→speaking, and its onDone sets phase→active
    // then calls startListening() — that is the ONLY place the mic starts.
    void playAgentReply(
      "Hello! I'm your TaxOne support agent. How can I help you today?"
    )
  }, [
    sendQuestion,
    startListening,
    updatePhase,
    playAgentReply,
    stopAgentOutput,
    pruneInterruptedAssistant,
  ])

  const endCall = useCallback(() => {
    callStartedRef.current = false  // reset so next call starts fresh
    const rec = recognitionRef.current
    if (rec) {
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      try { rec.stop() } catch {}
      recognitionRef.current = null
    }
    isListeningRef.current = false
    stopAgentOutput()
    replyEpochRef.current = 0
    activeReplyIdRef.current = 0
    playbackEpochRef.current = 0
    setMessages([])
    assistantDraftRef.current = ''
    setInterimText('')
    updatePhase('idle')
    setStatusLine('')
    setWsError('')
  }, [updatePhase, stopAgentOutput])

  const lastAssistant = messages.filter((m) => m.role === 'assistant').pop()
  const lastUser = messages.filter((m) => m.role === 'user').pop()

  const phaseLabel =
    phase === 'idle' ? 'Ready' :
    isMuted ? 'Muted' :
    phase === 'active' ? 'On call' :
    phase === 'listening' ? 'Listening…' :
    phase === 'thinking' ? 'Agent is thinking…' :
    'Agent is speaking'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/90 shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-8 pb-6 text-center border-b border-slate-800">
          <p className="text-xs uppercase tracking-widest text-slate-500">Vyapar TaxOne</p>
          <h1 className="text-xl font-semibold mt-1">Support call</h1>
          <p className="text-xs text-slate-500 mt-1">Voice agent · RAG</p>
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
              "{interimText}"
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
                disabled={phase === 'thinking'}
                className={`w-full py-3 rounded-2xl font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
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
        STT: Browser Web Speech API (Chrome only) · TTS: Sarvam
      </p>
    </div>
  )
}
