import { Phone } from 'lucide-react'

/**
 * Top bar of the voice agent card.
 * Shows brand + a live indicator when call is active.
 */
export function CallHeader({ wsReady, isCallStarted, phase }) {
  const showLive = isCallStarted && phase !== 'idle'

  return (
    <header className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center">
          <Phone
            className="w-4 h-4 text-blue-600 dark:text-blue-400"
            aria-hidden="true"
          />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
            Vyapar TaxOne
          </p>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100 -mt-0.5">
            Support call
          </p>
        </div>
      </div>

      {showLive ? (
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Live
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              wsReady ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {wsReady ? 'Ready' : 'Connecting'}
          </span>
        </div>
      )}
    </header>
  )
}

export default CallHeader