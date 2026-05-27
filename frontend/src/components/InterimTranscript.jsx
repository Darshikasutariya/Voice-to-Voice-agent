/**
 * Live transcript pill — shows the in-progress STT text while the user is
 * speaking. Animated dots indicate active listening.
 */
export default function InterimTranscript({ text }) {
    if (!text) return null
  
    return (
      <div className="flex justify-start">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/50 dark:border-emerald-900/40 max-w-[80%]">
          <span className="inline-flex gap-0.5" aria-hidden="true">
            <span
              className="w-1 h-1 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-bounce"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="w-1 h-1 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-bounce"
              style={{ animationDelay: '120ms' }}
            />
            <span
              className="w-1 h-1 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-bounce"
              style={{ animationDelay: '240ms' }}
            />
          </span>
          <p className="text-xs italic text-emerald-700 dark:text-emerald-300 break-words">
            “{text}”
          </p>
        </div>
      </div>
    )
  }