import { useCallback, useRef, useState } from 'react'

/**
 * Manages the conversation message list and history payload for the backend.
 *
 * Public API:
 *  - messages: full array of { role, content, streaming?, sources?, error? }
 *  - messagesRef: ref to latest messages (for use inside async callbacks)
 *  - addUserMessage(text)
 *  - addAssistantPlaceholder() — adds empty streaming bubble
 *  - appendAssistantToken(text) — appends to last assistant bubble
 *  - finalizeAssistant(sources) — marks last bubble as done
 *  - markAssistantError(message) — converts last bubble to error
 *  - pruneInterruptedAssistant() — drops incomplete assistant bubble
 *  - reset() — clears all messages
 *  - buildHistoryPayload() — for sending to backend
 */
export function useChatHistory() {
  const [messages, setMessages] = useState([])
  const messagesRef = useRef([])

  // Keep ref in sync with state (avoids stale closures)
  if (messagesRef.current !== messages) {
    messagesRef.current = messages
  }

  const addUserMessage = useCallback((text) => {
    setMessages((prev) => [...prev, { role: 'user', content: text }])
  }, [])

  const addAssistantPlaceholder = useCallback(() => {
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '', streaming: true, sources: [] },
    ])
  }, [])

  const appendAssistantToken = useCallback((text) => {
    setMessages((prev) => {
      const next = [...prev]
      const i = next.length - 1
      if (i >= 0 && next[i].role === 'assistant') {
        next[i] = { ...next[i], content: next[i].content + text }
      }
      return next
    })
  }, [])

  const finalizeAssistant = useCallback((sources) => {
    setMessages((prev) => {
      const next = [...prev]
      const i = next.length - 1
      if (i >= 0 && next[i].role === 'assistant') {
        next[i] = { ...next[i], streaming: false, sources: sources ?? [] }
      }
      return next
    })
  }, [])

  const markAssistantError = useCallback((message) => {
    setMessages((prev) => {
      const next = [...prev]
      const i = next.length - 1
      if (i >= 0 && next[i].role === 'assistant') {
        next[i] = {
          ...next[i],
          streaming: false,
          content: next[i].content || `Error: ${message}`,
          error: true,
        }
      }
      return next
    })
  }, [])

  const pruneInterruptedAssistant = useCallback(() => {
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last?.role === 'assistant' && (last.streaming || !last.content?.trim())) {
        next.pop()
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setMessages([])
  }, [])

  const buildHistoryPayload = useCallback(() => {
    return messagesRef.current
      .filter(
        (m) =>
          m.content &&
          !m.error &&
          (m.role === 'user' || m.role === 'assistant'),
      )
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }))
  }, [])

  return {
    messages,
    messagesRef,
    addUserMessage,
    addAssistantPlaceholder,
    appendAssistantToken,
    finalizeAssistant,
    markAssistantError,
    pruneInterruptedAssistant,
    reset,
    buildHistoryPayload,
  }
}