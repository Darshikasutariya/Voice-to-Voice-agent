/**
 * Status indicator: colored dot + label that reflects the current call phase.
 * Maps internal phase → user-friendly label + dot color.
 */
export default function PhaseIndicator({ phase, isMuted }) {
    let label = 'Ready'
    let dotClass = 'bg-slate-400'
    let textClass = 'text-slate-500 dark:text-slate-400'
    let pulse = false
  
    if (isMuted) {
      label = 'Muted'
      dotClass = 'bg-amber-500'
      textClass = 'text-amber-700 dark:text-amber-400'
    } else if (phase === 'listening') {
      label = 'Listening'
      dotClass = 'bg-emerald-500'
      textClass = 'text-emerald-700 dark:text-emerald-400'
      pulse = true
    } else if (phase === 'thinking') {
      label = 'Thinking…'
      dotClass = 'bg-amber-500'
      textClass = 'text-amber-700 dark:text-amber-400'
      pulse = true
    } else if (phase === 'speaking') {
      label = 'Speaking'
      dotClass = 'bg-sky-500'
      textClass = 'text-sky-700 dark:text-sky-400'
      pulse = true
    } else if (phase === 'active') {
      label = 'On call'
      dotClass = 'bg-emerald-500'
      textClass = 'text-emerald-700 dark:text-emerald-400'
    }
  
    return (
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${dotClass} ${pulse ? 'animate-pulse' : ''}`}
          aria-hidden="true"
        />
        <span className={`text-sm font-medium ${textClass}`}>{label}</span>
      </div>
    )
  } 