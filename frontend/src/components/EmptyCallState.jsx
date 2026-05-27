import { PhoneCall, Headphones } from 'lucide-react'

/**
 * Idle screen shown before the call starts.
 * Big start button + helpful tips.
 */
export function EmptyCallState({ onStartCall, wsReady, wsError }) {
  const canStart = wsReady && !wsError

  return (
    <div className="px-6 py-12 flex flex-col items-center text-center">
      <div className="w-20 h-20 rounded-full bg-slate-100 dark:bg-slate-800/60 flex items-center justify-center mb-5">
        <PhoneCall
          className="w-9 h-9 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
      </div>

      <p className="text-base font-medium text-slate-900 dark:text-slate-100 mb-1.5">
        Talk to your support agent
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-xs mb-6">
        Ask anything about Vyapar TaxOne in English, Hindi, or Gujarati.
      </p>

      <button
        type="button"
        onClick={onStartCall}
        disabled={!canStart}
        className="px-7 py-3 rounded-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-medium text-sm inline-flex items-center gap-2 transition-colors"
      >
        <PhoneCall className="w-4 h-4" aria-hidden="true" />
        Start call
      </button>

      {wsError ? (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-4 max-w-xs">
          {wsError}
        </p>
      ) : (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-4 inline-flex items-center gap-1.5">
          <Headphones className="w-3 h-3" aria-hidden="true" />
          Use headphones for the best experience
        </p>
      )}
    </div>
  )
}

export default EmptyCallState