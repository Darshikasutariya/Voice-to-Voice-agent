import { useState } from 'react'
import { useChatHistory } from './hooks/useChatHistory'
import { useAudioPlayback } from './hooks/useAudioPlayback'
import { useVoiceSession } from './hooks/useVoiceSession'

import CallHeader from './components/CallHeader'
import EmptyCallState from './components/EmptyCallState'
import MessageList from './components/MessageList'
import VoiceControlBar from './components/VoiceControlBar'

/** @typedef {'idle' | 'active' | 'listening' | 'thinking' | 'speaking'} Phase */

export default function App() {
  const [phase, setPhase] = useState(/** @type {Phase} */('idle'))
  const [interimText, setInterimText] = useState('')

  const history = useChatHistory()
  const audio = useAudioPlayback()

  const voice = useVoiceSession({
    audio,
    history,
    setInterimText,
    setPhase,
    getPhase: () => phase,
  })

  const { messages } = history
  const {
    wsReady,
    wsError,
    isMuted,
    isCallStarted,
    statusLine,
    startCall,
    endCall,
    toggleMute,
  } = voice

  const inCall = isCallStarted && phase !== 'idle'

  // Only show interim transcript while user is actively speaking.
  // Hides stale interim events that arrive during thinking/speaking phases.
  const visibleInterimText =
    phase === 'listening' || phase === 'active' ? interimText : ''

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden flex flex-col">

        <CallHeader
          wsReady={wsReady}
          isCallStarted={isCallStarted}
          phase={phase}
        />

        {inCall ? (
          <>
            <MessageList messages={messages} interimText={visibleInterimText} />

            {wsError && (
              <p className="px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 text-center border-t border-amber-200/50 dark:border-amber-900/40">
                {wsError}
              </p>
            )}

            {statusLine && (
              <p className="px-4 py-1 text-[11px] text-slate-500 dark:text-slate-400 text-center">
                {statusLine}
              </p>
            )}

            <VoiceControlBar
              phase={phase}
              isMuted={isMuted}
              onToggleMute={toggleMute}
              onEndCall={endCall}
            />
          </>
        ) : (
          <EmptyCallState
            onStartCall={startCall}
            wsReady={wsReady}
            wsError={wsError}
          />
        )}

      </div>

      <p className="text-[11px] text-slate-400 dark:text-slate-600 mt-5 text-center max-w-sm">
        STT: Deepgram Nova-3 · TTS: Sarvam · VAD: Web Audio API
      </p>
    </div>
  )
}