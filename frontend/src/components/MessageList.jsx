import { useEffect, useRef } from 'react'
import MessageBubble from './MessageBubble'
import InterimTranscript from './InterimTranscript'

/**
 * Scrollable chat list. Auto-scrolls to bottom on new messages or
 * when interim transcript updates.
 */
export default function MessageList({ messages, interimText }) {
  const scrollRef = useRef(null)
  const endRef = useRef(null)

  // Auto-scroll to bottom on any update
  useEffect(() => {
    const el = endRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, interimText])

  const isEmpty = messages.length === 0 && !interimText

  return (
    <div
      ref={scrollRef}
      className="flex-1 px-4 py-4 overflow-y-auto min-h-[280px] max-h-[420px] flex flex-col gap-2.5"
    >
      {isEmpty && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-slate-400 dark:text-slate-500 text-center">
            Start speaking to begin the conversation
          </p>
        </div>
      )}

      {messages.map((m, i) => (
        <MessageBubble key={i} message={m} />
      ))}

      {interimText && <InterimTranscript text={interimText} />}

      <div ref={endRef} />
    </div>
  )
}