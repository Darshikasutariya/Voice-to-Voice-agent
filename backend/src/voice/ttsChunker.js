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
 *   const chunker = createTtsChunker({ sendFn, signal });
 *   for each LLM token:  chunker.push(tokenText)
 *   when LLM done:       await chunker.flush()
 *
 * @param {{
 *   sendFn: (chunkId: number, base64Audio: string) => void,
 *   signal?: AbortSignal
 * }} opts
 * @returns {{ push: (text: string) => void, flush: () => Promise<void> }}
 */
export function createTtsChunker({ sendFn, signal }) {
  let buffer     = "";
  let nextChunkId = 0;   // ID to assign to the next dispatched chunk
  let nextSendId  = 0;   // ID of the next chunk to send in-order

  const resolved = new Map(); // chunkId → base64 string | null (null = failed)
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
      resolved.clear();
    },
    { once: true },
  );

  // ── In-order drain ────────────────────────────────────────────────────────
  function drainQueue() {
    while (resolved.has(nextSendId)) {
      const audio = resolved.get(nextSendId);
      resolved.delete(nextSendId);
      if (audio !== null && !aborted) {
        console.log(`[${ts()}] [TTS-Chunker] ▶ Sending chunk #${nextSendId}`);
        try { sendFn(nextSendId, audio); } catch { /* socket may have closed */ }
      }
      nextSendId++;
    }
  }

  // ── Dispatch a TTS call for one text chunk ────────────────────────────────
  function dispatchChunk(text) {
    const trimmed = text.trim();
    if (!trimmed || aborted) return;

    const chunkId = nextChunkId++;
    console.log(
      `[${ts()}] [TTS-Chunker] 🔊 TTS chunk #${chunkId}: "${trimmed.slice(0, 60)}"`,
    );

    const p = synthesizeSarvamBase64(trimmed)
      .then((b64) => {
        if (aborted) return;
        resolved.set(chunkId, b64);
        drainQueue();
      })
      .catch((err) => {
        console.error(
          `[${ts()}] [TTS-Chunker] ❌ Chunk #${chunkId} failed: ${err.message}`,
        );
        // Mark null so the queue does not stall waiting for this ID
        resolved.set(chunkId, null);
        drainQueue();
      });

    pending.push(p);
  }

  // ── Timeout helpers ───────────────────────────────────────────────────────
  function clearTimer() {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  }

  function scheduleTimeout() {
    if (timeoutHandle || aborted) return;
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (buffer.length >= MIN_TIMEOUT_CHARS && !aborted) {
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
      // 1. Try a sentence boundary
      const sm = SENTENCE_END_RE.exec(buffer);
      if (sm !== null) {
        const cutAt = sm.index + sm[0].length; // end of punctuation
        if (cutAt >= MIN_SENTENCE_CHARS) {
          const chunk = buffer.slice(0, cutAt);
          buffer = buffer.slice(cutAt).trimStart();
          dispatchChunk(chunk);
          anyExtracted = true;
          continue;
        }
      }

      // 2. Try a clause boundary (only when buffer is long enough)
      const cm = CLAUSE_END_RE.exec(buffer);
      if (
        cm !== null &&
        buffer.length >= MIN_CLAUSE_CHARS &&
        cm.index + 1 >= MIN_SENTENCE_CHARS
      ) {
        const chunk = buffer.slice(0, cm.index + 1); // include punctuation
        buffer = buffer.slice(cm.index + cm[0].length).trimStart(); // skip space
        dispatchChunk(chunk);
        anyExtracted = true;
        continue;
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
    const extracted = extractChunks();
    if (!extracted && buffer.length >= MIN_TIMEOUT_CHARS) {
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
