import { AlertCircle } from 'lucide-react'

/**
 * Single chat bubble. Variants:
 *  - user (right-aligned, blue tinted)
 *  - assistant (left-aligned, neutral)
 *  - assistant + streaming (shows blinking cursor)
 *  - assistant + error (red tint, icon)
 */
export default function MessageBubble({ message }) {
  if (!message) return null

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-blue-50 dark:bg-blue-950/40 px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-blue-700 dark:text-blue-300 mb-0.5">
            You
          </p>
          <p className="text-sm leading-relaxed text-blue-900 dark:text-blue-100 whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
      </div>
    )
  }

  // Assistant variants
  const isError = message.error
  const isStreaming = message.streaming && !isError

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[80%] rounded-2xl rounded-bl-md px-3.5 py-2.5 ${
          isError
            ? 'bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-900/50'
            : 'bg-slate-100 dark:bg-slate-800/70'
        }`}
      >
        <p
          className={`text-[11px] font-medium mb-0.5 inline-flex items-center gap-1 ${
            isError
              ? 'text-red-700 dark:text-red-400'
              : 'text-slate-600 dark:text-slate-300'
          }`}
        >
          {isError && <AlertCircle className="w-3 h-3" aria-hidden="true" />}
          Agent
        </p>
        <p
          className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isError
              ? 'text-red-800 dark:text-red-200'
              : 'text-slate-900 dark:text-slate-100'
          }`}
        >
          {message.content}
          {isStreaming && (
            <span
              className="inline-block w-[3px] h-[14px] ml-0.5 align-middle bg-emerald-500 dark:bg-emerald-400 animate-pulse rounded-sm"
              aria-hidden="true"
            />
          )}
        </p>
      </div>
    </div>
  )
}