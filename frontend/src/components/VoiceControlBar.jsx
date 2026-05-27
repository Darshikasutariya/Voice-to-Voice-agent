import { Mic, MicOff, PhoneOff } from 'lucide-react'
import PhaseIndicator from './PhaseIndicator'

/**
 * Sticky bottom bar with phase indicator + mute toggle + end call.
 * Shown only when a call is in progress.
 */
export default function VoiceControlBar({
  phase,
  isMuted,
  onToggleMute,
  onEndCall,
}) {
  return (
    <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <PhaseIndicator phase={phase} isMuted={isMuted} />
        </div>

        <button
          type="button"
          onClick={onToggleMute}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          title={isMuted ? 'Unmute mic' : 'Mute mic'}
          className={`w-10 h-10 rounded-full inline-flex items-center justify-center transition-colors ${
            isMuted
              ? 'bg-amber-500 hover:bg-amber-400 text-white'
              : 'bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700'
          }`}
        >
          {isMuted ? (
            <MicOff className="w-[18px] h-[18px]" aria-hidden="true" />
          ) : (
            <Mic className="w-[18px] h-[18px]" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onEndCall}
          aria-label="End call"
          title="End call"
          className="w-11 h-11 rounded-full bg-red-500 hover:bg-red-600 inline-flex items-center justify-center transition-colors"
        >
          <PhoneOff className="w-5 h-5 text-white" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}