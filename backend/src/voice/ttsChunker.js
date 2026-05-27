import { synthesizeSarvamBase64 } from "./sarvamTts.js";

function ts() {
  const d = new Date();
  return `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Flush a sentence when we see .  !  ? (with optional closing quotes/brackets)
 * followed by whitespace OR end-of-string.
 *
 * Using a look-ahead so the whitespace character stays in the remaining buffer.
 */
const SENTENCE_END_RE = /[.!?]['")\]]*(?=\s|$)/;

/**
 * Flush a clause when we see ,  ;  : followed by a space.
 * Requires more chars in the buffer before we split here.
 */
const CLAUSE_END_RE = /[,;:]\s/;

/** Minimum characters at the split point before a sentence flush triggers */
const MIN_SENTENCE_CHARS = 15;

/** Minimum total buffer length before a clause flush triggers */
const MIN_CLAUSE_CHARS = 35;

/** Force-flush timeout when no boundary is found but we have text */
const TIMEOUT_FLUSH_MS = 450;

/** Minimum buffer length before we start the timeout timer */
const MIN_TIMEOUT_CHARS = 15;

/**
 * Creates a streaming text → TTS chunker.
 *
 * Usage:
 *   const chunker = createTtsChunker({ sendFn, signal, targetLanguageCode });
 *   for each LLM token:  chunker.push(tokenText)
 *   when LLM done:       await chunker.flush()
 *
 * @param {{
 *   sendFn: (chunkId: number, base64Audio: string | null) => void,
 *   signal?: AbortSignal,
 *   targetLanguageCode?: string
 * }} opts
 * @returns {{ push: (text: string) => void, flush: () => Promise<void> }}
 */
export function createTtsChunker({ sendFn, signal, targetLanguageCode }) {
  let buffer     = "";
  let nextChunkId = 0;   // ID to assign to the next dispatched chunk

  const pending  = [];        // Promise[] — one per dispatched TTS call
  let timeoutHandle = null;
  let aborted       = false;

  // ── Abort handler ────────────────────────────────────────────────────────
  signal?.addEventListener(
    "abort",
    () => {
      aborted = true;
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      buffer = "";
    },
    { once: true },
  );

  // ── Dispatch a TTS call for one text chunk ────────────────────────────────
  function dispatchChunk(text) {
    const trimmed = text.trim();
    if (!trimmed || aborted) return;

    const chunkId = nextChunkId++;
    console.log(
      `[${ts()}] [TTS-Chunker] 🔊 Dispatching TTS chunk #${chunkId}: "${trimmed.slice(0, 60)}"`,
    );

    const p = synthesizeSarvamBase64(trimmed, targetLanguageCode, signal)
      .then((b64) => {
        if (aborted) return;
        console.log(`[${ts()}] [TTS-Chunker] ▶ Sending chunk #${chunkId} immediately`);
        try { sendFn(chunkId, b64); } catch { /* socket may have closed */ }
      })
      .catch((err) => {
        if (aborted) return;
        console.error(
          `[${ts()}] [TTS-Chunker] ❌ Chunk #${chunkId} failed: ${err.message}`,
        );
        // Mark null/failed so the client's queue doesn't wait
        try { sendFn(chunkId, null); } catch { }
      });

    pending.push(p);
  }

  // ── Timeout helpers ───────────────────────────────────────────────────────
  function clearTimer() {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  }

  const TIMEOUT_FLUSH_MS = 200; // 200ms token pause triggers flush

  function scheduleTimeout() {
    if (timeoutHandle || aborted) return;
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (buffer.trim() && !aborted) {
        console.log(`[${ts()}] [TTS-Chunker] ⏰ Timeout flush: "${buffer.slice(0, 50)}"`);
        dispatchChunk(buffer);
        buffer = "";
      }
    }, TIMEOUT_FLUSH_MS);
  }

  // ── Extract all available chunks from the buffer ──────────────────────────
  function extractChunks() {
    let anyExtracted = false;
    while (!aborted) {
      // 1. Check for sentence end punctuation: . ! ? । | followed by whitespace or end
      const sm = /[.!?।|]+['")\]]*(?=\s|$)/.exec(buffer);
      if (sm !== null) {
        const cutAt = sm.index + sm[0].length;
        if (cutAt >= 6) { // Small sentence chunk
          const chunk = buffer.slice(0, cutAt);
          buffer = buffer.slice(cutAt).trimStart();
          dispatchChunk(chunk);
          anyExtracted = true;
          continue;
        }
      }

      // 2. Check for clause end punctuation: , ; : — followed by whitespace
      const cm = /[,;:—]+(?=\s|$)/.exec(buffer);
      if (cm !== null) {
        const cutAt = cm.index + cm[0].length;
        if (cutAt >= 10) { // Medium clause chunk
          const chunk = buffer.slice(0, cutAt);
          buffer = buffer.slice(cutAt).trimStart();
          dispatchChunk(chunk);
          anyExtracted = true;
          continue;
        }
      }

      // 3. Word threshold: if we have 10 or more words, split at the last space
      const words = buffer.trim().split(/\s+/);
      if (words.length >= 10) {
        const lastSpaceIndex = buffer.lastIndexOf(" ");
        if (lastSpaceIndex !== -1 && lastSpaceIndex >= 10) {
          const chunk = buffer.slice(0, lastSpaceIndex);
          buffer = buffer.slice(lastSpaceIndex).trimStart();
          dispatchChunk(chunk);
          anyExtracted = true;
          continue;
        }
      }

      break;
    }
    return anyExtracted;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Call with each LLM token as it arrives. Non-blocking. */
  function push(text) {
    if (aborted) return;
    buffer += text;
    clearTimer();
    extractChunks();
    if (buffer.trim()) {
      scheduleTimeout();
    }
  }

  /**
   * Flush any remaining buffer text, then await all in-flight TTS calls.
   * Call once when the LLM stream ends.
   */
  async function flush() {
    if (aborted) return;
    clearTimer();
    if (buffer.trim()) {
      dispatchChunk(buffer);
      buffer = "";
    }
    // Wait for every TTS promise (success or failure)
    await Promise.allSettled(pending);
  }

  return { push, flush };
}
