import { synthesizeSarvamBase64 } from "./sarvamTts.js";

function ts() {
  const d = new Date();
  return `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// ────────────────────────────────────────────────────────────────────────────
//  TUNING CONSTANTS — adjust these to trade latency vs. chunk efficiency
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimum characters before we'll dispatch ANY chunk (except final flush).
 * 5-char chunks waste a full ~500ms Sarvam round-trip — much better to
 * wait one more token and send a bigger payload.
 */
const MIN_DISPATCH_CHARS = 8;

/**
 * Minimum chars before the FIRST chunk fires. Lower = faster time-to-first-audio
 * but smaller initial payload. 12 is a good sweet spot — usually one short phrase.
 */
const MIN_FIRST_CHUNK_CHARS = 12;

/**
 * If buffer has this many chars at a sentence boundary, flush it as a chunk.
 * Lower than MIN_DISPATCH_CHARS would conflict so we use the max of the two.
 */
const MIN_SENTENCE_CHARS = 8;

/**
 * Clause boundaries (comma, semicolon) need more chars before splitting,
 * otherwise we'd cut things like "1, 2, 3" into useless tiny chunks.
 */
const MIN_CLAUSE_CHARS = 12;

/**
 * Word threshold: if buffer has this many words without hitting any boundary,
 * force a split. Prevents long runs of words from never being chunked.
 */
const WORD_FLUSH_THRESHOLD = 10;

/**
 * If no boundary appears but we have text, force-flush after this delay.
 * Lower = more responsive but smaller chunks.
 */
const TIMEOUT_FLUSH_MS = 200;

/**
 * Minimum buffer size before the timeout timer starts. Below this, we wait
 * for more text rather than firing a wasteful tiny chunk.
 */
const TIMEOUT_MIN_BUFFER = 10;

// ────────────────────────────────────────────────────────────────────────────

/**
 * Creates a streaming text → TTS chunker with ORDERED dispatch.
 *
 * Important behaviour:
 *  - Chunks dispatched to Sarvam in parallel (fast)
 *  - But sent to the client IN ORDER (no audio gaps from late-returning chunks)
 *  - First chunk fires aggressively for fast time-to-first-audio
 *  - Tiny fragments are merged into the next chunk, not sent alone
 *
 * Usage:
 *   const chunker = createTtsChunker({ sendFn, signal, targetLanguageCode });
 *   chunker.push(token)                  // for each LLM token
 *   await chunker.flush()                // at end of stream
 *
 * @param {{
 *   sendFn: (chunkId: number, base64Audio: string | null) => void,
 *   signal?: AbortSignal,
 *   targetLanguageCode?: string
 * }} opts
 */
export function createTtsChunker({ sendFn, signal, targetLanguageCode }) {
  let buffer = "";
  let nextChunkId = 0;
  let isFirstChunk = true;       // First chunk uses lower thresholds

  /** All dispatched TTS promises (for flush() to await) */
  const pending = [];

  /** Map of chunkId → audio | null. Chunks held here until in-order send is possible. */
  const readyChunks = new Map();
  let nextSendId = 0;            // The chunkId we're currently waiting to send

  let timeoutHandle = null;
  let aborted = false;

  // ── Abort handling ────────────────────────────────────────────────────────
  signal?.addEventListener(
    "abort",
    () => {
      aborted = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      buffer = "";
      readyChunks.clear();
    },
    { once: true },
  );

  // ── Ordered dispatch: drain readyChunks in chunkId order ──────────────────
  function drainOrderedSends() {
    while (readyChunks.has(nextSendId)) {
      const audio = readyChunks.get(nextSendId);
      readyChunks.delete(nextSendId);
      const idToSend = nextSendId;
      nextSendId++;

      if (aborted) continue;
      try {
        sendFn(idToSend, audio);
        console.log(`[${ts()}] [TTS-Chunker] ▶ Sent chunk #${idToSend} (in order)`);
      } catch {
        // socket may have closed — keep draining the rest anyway
      }
    }
  }

  // ── Dispatch one text chunk to Sarvam (parallel synthesis, ordered send) ──
  function dispatchChunk(text) {
    const trimmed = text.trim();
    if (!trimmed || aborted) return;

    const chunkId = nextChunkId++;
    const startTime = Date.now();
    console.log(
      `[${ts()}] [TTS-Chunker] 🔊 Dispatching chunk #${chunkId} (${trimmed.length} chars): "${trimmed.slice(0, 60)}"`,
    );

    const p = synthesizeSarvamBase64(trimmed, targetLanguageCode, signal)
      .then((b64) => {
        if (aborted) return;
        const ms = Date.now() - startTime;
        console.log(`[${ts()}] [TTS-Chunker] ✓ Chunk #${chunkId} synth done in ${ms}ms`);
        // Store and drain (sends are ordered, not first-come-first-served)
        readyChunks.set(chunkId, b64);
        drainOrderedSends();
      })
      .catch((err) => {
        if (aborted) return;
        console.error(
          `[${ts()}] [TTS-Chunker] ❌ Chunk #${chunkId} failed: ${err.message}`,
        );
        // Send null to unblock the frontend queue
        readyChunks.set(chunkId, null);
        drainOrderedSends();
      });

    pending.push(p);
    isFirstChunk = false;
  }

  // ── Timeout helpers ───────────────────────────────────────────────────────
  function clearTimer() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function scheduleTimeout() {
    if (timeoutHandle || aborted) return;
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      // Only flush if buffer is reasonably sized — avoids tiny chunks
      if (buffer.trim().length >= MIN_DISPATCH_CHARS && !aborted) {
        console.log(
          `[${ts()}] [TTS-Chunker] ⏰ Timeout flush (${buffer.length} chars): "${buffer.slice(0, 50)}"`,
        );
        dispatchChunk(buffer);
        buffer = "";
      } else if (buffer.trim() && !aborted) {
        // Buffer too small — schedule another timeout for more text
        scheduleTimeout();
      }
    }, TIMEOUT_FLUSH_MS);
  }

  // ── Try to extract one or more chunks from the buffer ─────────────────────
  function extractChunks() {
    let extracted = false;

    while (!aborted) {
      const bufLen = buffer.trim().length;

      // Determine minimum for THIS chunk
      const minForThisChunk = isFirstChunk ? MIN_FIRST_CHUNK_CHARS : MIN_DISPATCH_CHARS;

      // Don't even try to chunk if we're below the minimum
      if (bufLen < minForThisChunk) break;

      // 1. Sentence boundary: . ! ? । |  (with optional closing quotes/brackets)
      const sm = /[.!?।|]+['")\]]*(?=\s|$)/.exec(buffer);
      if (sm !== null) {
        const cutAt = sm.index + sm[0].length;
        if (cutAt >= MIN_SENTENCE_CHARS) {
          const chunk = buffer.slice(0, cutAt);
          buffer = buffer.slice(cutAt).trimStart();
          dispatchChunk(chunk);
          extracted = true;
          continue;
        }
      }

      // 2. Clause boundary: , ; : —
      const cm = /[,;:—]+(?=\s|$)/.exec(buffer);
      if (cm !== null) {
        const cutAt = cm.index + cm[0].length;
        if (cutAt >= MIN_CLAUSE_CHARS) {
          const chunk = buffer.slice(0, cutAt);
          buffer = buffer.slice(cutAt).trimStart();
          dispatchChunk(chunk);
          extracted = true;
          continue;
        }
      }

      // 3. Word-count threshold: split at last space if we have many words
      const words = buffer.trim().split(/\s+/);
      if (words.length >= WORD_FLUSH_THRESHOLD) {
        const lastSpaceIndex = buffer.lastIndexOf(" ");
        if (lastSpaceIndex >= MIN_DISPATCH_CHARS) {
          const chunk = buffer.slice(0, lastSpaceIndex);
          buffer = buffer.slice(lastSpaceIndex).trimStart();
          dispatchChunk(chunk);
          extracted = true;
          continue;
        }
      }

      break; // no more boundaries found
    }

    return extracted;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Call with each LLM token as it arrives. Non-blocking. */
  function push(text) {
    if (aborted) return;
    buffer += text;
    clearTimer();
    extractChunks();
    // Schedule timeout only if buffer has meaningful content
    if (buffer.trim().length >= TIMEOUT_MIN_BUFFER) {
      scheduleTimeout();
    }
  }

  /**
   * Flush any remaining buffer text, then await all in-flight TTS calls.
   * Call once when the LLM stream ends.
   *
   * Unlike push(), this WILL send small remaining text (the tail of the
   * response). A 4-char "okay." at the end is better sent than dropped.
   */
  async function flush() {
    if (aborted) return;
    clearTimer();
    if (buffer.trim()) {
      console.log(
        `[${ts()}] [TTS-Chunker] 🏁 Final flush (${buffer.length} chars): "${buffer.slice(0, 50)}"`,
      );
      dispatchChunk(buffer);
      buffer = "";
    }
    await Promise.allSettled(pending);
  }

  return { push, flush };
}