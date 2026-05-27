import WebSocket from "ws";
import { config } from "../config.js";
import {
  isLatinScriptDominant,
  isDevanagariDominant,
  isGujaratiDominant,
} from "../utils/langDetect.js";

const LANGUAGES = ["en", "hi", "gu"];

// ── Tuning constants ─────────────────────────────────────────────────────

/** Min words before we trust an early-trigger (prevents firing on "What is"). */
const MIN_WORDS_FOR_EARLY_TRIGGER = 3;

/** Confidence threshold for 2-socket early-trigger path. */
const EARLY_TRIGGER_CONF = 0.92;

/** Wait window after first socket finalizes — gives others a chance. */
const WINNER_WAIT_MS = 150;

/** Cross-check wait when first socket has strong-and-long transcript. */
const STRONG_AND_LONG_WAIT_MS = 75;

/** Hard cap for any wait scenario. */
const HARD_TIMEOUT_MS = 400;

/**
 * After a winner triggers, ignore further speech_final events for this many ms.
 * They're echoes from other sockets transcribing the same utterance.
 */
const POST_TRIGGER_LOCKOUT_MS = 500;

// ── Helpers ──────────────────────────────────────────────────────────────

function ts() {
  const d = new Date();
  return `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function freshTurnState() {
  return {
    accumulatedText: "",
    confidenceSum: 0,
    confidenceCount: 0,
    interimText: "",
    speechFinalReceived: false,
  };
}

/**
 * Quality score for a finalized transcript.
 * Combines confidence + word count + script-language match bonus/penalty.
 */
function scoreTranscript(state, lang) {
  const text = state.accumulatedText.trim();
  if (!text) return 0;

  const avgConf = state.confidenceCount > 0
    ? state.confidenceSum / state.confidenceCount
    : 0;

  const wordCount = countWords(text);
  if (wordCount < 1) return 0;

  const wordFactor = Math.min(wordCount, 8) / 8;
  let score = avgConf * (0.5 + 0.5 * wordFactor);

  // Script-aware adjustments — the transcript SCRIPT tells us what the user
  // actually spoke, independent of which socket transcribed it.
  const latinDominant = isLatinScriptDominant(text);

  if (lang === "en") {
    if (latinDominant) score += 0.20;
    else score -= 0.10;
  } else if (lang === "hi") {
    if (latinDominant) score -= 0.15;
    else if (isDevanagariDominant(text)) score += 0.10;
  } else if (lang === "gu") {
    if (latinDominant) score -= 0.15;
    else if (isGujaratiDominant(text)) score += 0.10;
  }

  return score;
}

// ── Public factory ───────────────────────────────────────────────────────

/**
 * Create a Deepgram STT router for one client connection.
 *
 * Manages 3 parallel Deepgram sockets (en/hi/gu), accumulates per-language
 * transcripts, and triggers `onWinner(text, lang, sttLatency)` once per
 * utterance with the best transcript.
 *
 * @param {{
 *   apiKey: string,
 *   onWinner: (text: string, lang: "en"|"hi"|"gu", sttLatency: number) => void,
 *   onInterim: (text: string) => void,
 *   onReady: () => void,
 * }} opts
 *
 * @returns {{
 *   sendAudio: (chunk: Buffer) => void,
 *   resetTurn: () => void,
 *   close: () => void,
 *   markAudioReceived: () => void,
 * }}
 */
export function createSttRouter({ apiKey, onWinner, onInterim, onReady }) {
  const sockets = {
    en: { ws: null, open: false, buffer: [] },
    hi: { ws: null, open: false, buffer: [] },
    gu: { ws: null, open: false, buffer: [] },
  };

  let turnState = {
    en: freshTurnState(),
    hi: freshTurnState(),
    gu: freshTurnState(),
  };

  let finalAnswerTimeout = null;
  let postTriggerLockoutUntil = 0;
  let lastAudioTime = 0;
  let sttReadySent = false;
  let keepAliveInterval = null;

  // ── Interim transcript fan-out ────────────────────────────────────────

  function sendInterimUpdate() {
    let longest = "";
    for (const lang of LANGUAGES) {
      const s = turnState[lang];
      const text = (s.accumulatedText + " " + s.interimText).trim();
      if (text.length > longest.length) longest = text;
    }
    if (longest) onInterim(longest);
  }

  // ── Turn state ────────────────────────────────────────────────────────

  function resetAllTurnState() {
    turnState = {
      en: freshTurnState(),
      hi: freshTurnState(),
      gu: freshTurnState(),
    };
  }

  // ── Winner selection ─────────────────────────────────────────────────

  function clearTimer() {
    if (finalAnswerTimeout) {
      clearTimeout(finalAnswerTimeout);
      finalAnswerTimeout = null;
    }
  }

  function triggerWinner() {
    let winnerLang = "en";
    let maxScore = -1;
    let winnerText = "";

    console.log(`[${ts()}] 📊 Evaluating transcripts for the current turn:`);
    for (const lang of LANGUAGES) {
      const state = turnState[lang];
      const text = state.accumulatedText.trim();
      const avgConf = state.confidenceCount > 0
        ? state.confidenceSum / state.confidenceCount
        : 0;
      const wordCount = countWords(text);
      const score = scoreTranscript(state, lang);

      console.log(
        `   - [${lang}]: "${text}" (conf=${avgConf.toFixed(3)}, words=${wordCount}, score=${score.toFixed(3)})`,
      );

      if (text && score > maxScore) {
        maxScore = score;
        winnerLang = lang;
        winnerText = text;
      }
    }

    resetAllTurnState();

    if (winnerText) {
      const now = Date.now();
      const sttLatency = lastAudioTime ? now - lastAudioTime : 0;
      console.log(
        `[${ts()}] 🏆 Winner: "${winnerLang}" with "${winnerText}" (score=${maxScore.toFixed(3)}, STT Latency: ${sttLatency}ms)`,
      );
      postTriggerLockoutUntil = now + POST_TRIGGER_LOCKOUT_MS;
      onWinner(winnerText, winnerLang, sttLatency);
    } else {
      console.log(`[${ts()}] ⚠️ No non-empty transcripts found for this turn.`);
    }
  }

  function checkAndTriggerFinalAnswer() {
    const finalized = Object.entries(turnState).filter(
      ([, s]) => s.speechFinalReceived,
    );
    const count = finalized.length;

    // All 3 done → trigger immediately
    if (count === 3) {
      clearTimer();
      triggerWinner();
      return;
    }

    // First socket finalized → maybe wait, maybe strong-and-long
    if (count === 1) {
      const [lang, state] = finalized[0];
      const text = state.accumulatedText.trim();
      const avgConf = state.confidenceCount > 0
        ? state.confidenceSum / state.confidenceCount
        : 0;
      const wordCount = countWords(text);

      // Strong-and-long: still wait briefly for cross-check (DG Hindi
      // model often confidently transcribes English; need comparison)
      if (
        avgConf >= 0.98 &&
        wordCount >= MIN_WORDS_FOR_EARLY_TRIGGER &&
        text.length >= 12
      ) {
        if (!finalAnswerTimeout) {
          console.log(
            `[${ts()}] ⚡ Strong-and-long detected on ${lang}, brief ${STRONG_AND_LONG_WAIT_MS}ms cross-check wait (conf=${avgConf.toFixed(2)}, words=${wordCount})`,
          );
          finalAnswerTimeout = setTimeout(() => {
            finalAnswerTimeout = null;
            triggerWinner();
          }, STRONG_AND_LONG_WAIT_MS);
        }
        return;
      }

      // Otherwise: full wait window
      if (!finalAnswerTimeout) {
        console.log(
          `[${ts()}] ⏳ First socket (${lang}) finalized but waiting ${WINNER_WAIT_MS}ms for others (conf=${avgConf.toFixed(2)}, words=${wordCount})`,
        );
        finalAnswerTimeout = setTimeout(() => {
          finalAnswerTimeout = null;
          triggerWinner();
        }, WINNER_WAIT_MS);
      }
      return;
    }

    // Two finalized — go if either is usable, else short wait
    if (count === 2) {
      clearTimer();

      const hasUsable = finalized.some(([, s]) => {
        const wc = countWords(s.accumulatedText);
        const conf = s.confidenceCount > 0 ? s.confidenceSum / s.confidenceCount : 0;
        return wc >= MIN_WORDS_FOR_EARLY_TRIGGER && conf >= EARLY_TRIGGER_CONF;
      });

      if (hasUsable) {
        console.log(`[${ts()}] ⚡ 2 sockets finalized, at least one is usable. Triggering.`);
        triggerWinner();
        return;
      }

      if (!finalAnswerTimeout) {
        finalAnswerTimeout = setTimeout(() => {
          finalAnswerTimeout = null;
          triggerWinner();
        }, HARD_TIMEOUT_MS - WINNER_WAIT_MS);
      }
      return;
    }

    // None finalized — safety net timeout
    if (!finalAnswerTimeout) {
      finalAnswerTimeout = setTimeout(() => {
        console.log(`[${ts()}] ⏰ Hard timeout reached. Triggering with available transcripts.`);
        finalAnswerTimeout = null;
        triggerWinner();
      }, HARD_TIMEOUT_MS);
    }
  }

  // ── Deepgram message handler ──────────────────────────────────────────

  function handleDeepgramMessage(lang, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error(`Error parsing Deepgram [${lang}] message:`, err);
      return;
    }

    if (!msg.channel || !msg.channel.alternatives) return;

    const alt = msg.channel.alternatives[0];
    const transcript = alt.transcript;
    const confidence = alt.confidence;
    const isFinal = msg.is_final;
    const speechFinal = msg.speech_final;

    if (transcript) {
      const state = turnState[lang];
      if (isFinal) {
        state.accumulatedText += (state.accumulatedText ? " " : "") + transcript;
        state.confidenceSum += confidence;
        state.confidenceCount += 1;
        state.interimText = "";
      } else {
        state.interimText = transcript;
      }
    }

    sendInterimUpdate();

    if (speechFinal && isFinal) {
      // Drop late echoes after winner already triggered
      if (Date.now() < postTriggerLockoutUntil) {
        const ms = postTriggerLockoutUntil - Date.now();
        console.log(
          `[${ts()}] 🔇 Deepgram [${lang}] speech_final ignored (post-trigger lockout active, ${ms}ms left)`,
        );
        turnState[lang] = freshTurnState();
        return;
      }

      turnState[lang].speechFinalReceived = true;
      console.log(
        `[${ts()}] 🎙️ Deepgram [${lang}] speech_final received: "${turnState[lang].accumulatedText}" (conf: ${confidence.toFixed(2)})`,
      );
      checkAndTriggerFinalAnswer();
    }
  }

  // ── Connect 3 Deepgram sockets ────────────────────────────────────────

  if (!apiKey) {
    console.error(`[${ts()}] ⚠️ DEEPGRAM_API_KEY not configured!`);
  } else {
    LANGUAGES.forEach((lang) => {
      const params = new URLSearchParams({
        model: config.voice.deepgramModel || "nova-3",
        language: lang,
        endpointing: "200",
        utterance_end_ms: "1000",
        vad_events: "true",
        interim_results: "true",
        smart_format: "true",
        punctuate: "true",
      });
      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
      console.log(`[${ts()}] 🔌 Connecting to Deepgram [${lang}] Streaming: ${url}`);

      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });
      sockets[lang].ws = ws;

      ws.on("open", () => {
        sockets[lang].open = true;
        console.log(`[${ts()}] 🔌 Deepgram [${lang}] Streaming WS opened`);

        // Drain audio buffered while socket was opening
        const buf = sockets[lang].buffer;
        while (buf.length > 0) {
          ws.send(buf.shift());
        }

        const allOpen = LANGUAGES.every((l) => sockets[l].open);
        if (allOpen && !sttReadySent) {
          sttReadySent = true;
          console.log(`[${ts()}] 🔌 All Deepgram sockets open. Sending stt_ready to client.`);
          onReady();
        }
      });

      ws.on("message", (data) => handleDeepgramMessage(lang, data));

      ws.on("error", (err) => {
        console.error(`[${ts()}] ❌ Deepgram [${lang}] WS error:`, err);
      });

      ws.on("close", (code, reason) => {
        console.log(`[${ts()}] 🔌 Deepgram [${lang}] WS closed (code: ${code}, reason: ${reason?.toString()})`);
        sockets[lang].open = false;
      });
    });

    // Keep-alive every 3s (DG closes idle sockets at 10s)
    keepAliveInterval = setInterval(() => {
      for (const lang of LANGUAGES) {
        const ws = sockets[lang].ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }
    }, 3000);
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    /** Forward one audio chunk to all 3 sockets (buffers if not yet open). */
    sendAudio(chunk) {
      lastAudioTime = Date.now();
      for (const lang of LANGUAGES) {
        const sock = sockets[lang];
        if (!sock.ws) continue;
        if (sock.open) sock.ws.send(chunk);
        else sock.buffer.push(chunk);
      }
    },

    /** Reset turn state (used on interrupt or after a reply). */
    resetTurn() {
      clearTimer();
      resetAllTurnState();
    },

    /** Cleanup on connection close. */
    close() {
      clearTimer();
      for (const lang of LANGUAGES) {
        const ws = sockets[lang].ws;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      }
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
    },

    /** Manually note that audio was received (for STT latency calc on typed input). */
    markAudioReceived() {
      lastAudioTime = Date.now();
    },
  };
}