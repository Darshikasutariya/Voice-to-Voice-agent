import WebSocket from "ws";
import { config } from "./config.js";
import { streamRagAnswer, parseChatHistory } from "./rag.js";
import { isChatApiKeyValid } from "./security.js";
import { createWindowLimiter } from "./rateLimit.js";
import { createTtsChunker } from "./voice/ttsChunker.js";
import { detectLanguage } from "./utils/langDetect.js";

const MAX_MESSAGE_BYTES = 64 * 1024;

const GREETING =
  "Hello! I'm your TaxOne support agent. How can I help you today?";

function safeSend(socket, obj) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(obj));
  }
}

/** Pretty timestamp for terminal logs */
function ts() {
  const d = new Date();
  return `${d.toLocaleTimeString("en-IN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * @param {import("ws").WebSocketServer} wss
 * @param {object} opts
 * @param {string} opts.chatApiKey
 * @param {number} opts.wsRateLimitWindowMs
 * @param {number} opts.wsRateLimitMax
 */
export function attachChatSocket(wss, opts) {
  const { chatApiKey } = opts;

  const wsAllow = createWindowLimiter(
    opts.wsRateLimitWindowMs,
    opts.wsRateLimitMax,
  );

  wss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    console.log(`\n[${ts()}] 🟢 New client connected  (ip: ${ip})`);

    // Chat history for this socket session
    const chatHistory = [];

    // Parse language and apiKey from URL
    let language = "multi";
    let keyFromUrl = "";
    try {
      const urlParams = new URL(req.url || "/", "http://localhost").searchParams;
      language = urlParams.get("language")?.trim() || "multi";
      keyFromUrl = urlParams.get("apiKey")?.trim() ?? "";
    } catch {
      // ignore bad URL
    }

    console.log(`[${ts()}] 👤 Client preferred language: "${language}"`);

    // Connect to Deepgram Streaming API (Parallel sockets for en, hi, gu)
    const dgKey = config.voice.deepgramApiKey;
    
    const dgSockets = {
      en: { ws: null, open: false, buffer: [] },
      hi: { ws: null, open: false, buffer: [] },
      gu: { ws: null, open: false, buffer: [] }
    };

    const turnState = {
      en: { accumulatedText: "", confidenceSum: 0, confidenceCount: 0, interimText: "", speechFinalReceived: false },
      hi: { accumulatedText: "", confidenceSum: 0, confidenceCount: 0, interimText: "", speechFinalReceived: false },
      gu: { accumulatedText: "", confidenceSum: 0, confidenceCount: 0, interimText: "", speechFinalReceived: false }
    };
    /**
 * After we trigger a winner, ignore further speech_final events for this many
 * milliseconds. They're echoes of the same utterance from the other sockets.
 * Without this, each socket's late speech_final spawns a new RAG call.
 */
const POST_TRIGGER_LOCKOUT_MS = 500;
let postTriggerLockoutUntil = 0;

    let keepAliveInterval = null;
    let sttReadySent = false;

    function sendInterimUpdate() {
      let longestLength = -1;
      let textToShow = "";

      for (const lang of ["en", "hi", "gu"]) {
        const state = turnState[lang];
        const currentText = (state.accumulatedText + " " + state.interimText).trim();
        if (currentText.length > longestLength) {
          longestLength = currentText.length;
          textToShow = currentText;
        }
      }

      if (textToShow) {
        safeSend(socket, { type: "interim_transcript", text: textToShow });
      }
    }

    let finalAnswerTimeout = null;

   // ──────────────────────────────────────────────────────────────────────────
//  Constants for smart winner selection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Minimum word count before we trust an early-trigger. Prevents firing on
 * partial transcripts like "What is" or "How to" that arrive before the
 * user has actually finished speaking.
 */
const MIN_WORDS_FOR_EARLY_TRIGGER = 3;

/**
 * Confidence threshold for early-trigger (single-socket high-confidence path).
 * Was 0.92. Kept the same.
 */
const EARLY_TRIGGER_CONF = 0.92;

/**
 * Wait window after first socket finalizes — gives the other sockets a chance
 * to also report. Improves language detection accuracy at the cost of slight
 * STT latency increase (~100-200ms).
 */
const WINNER_WAIT_MS = 150;

/**
 * Fallback timeout if waiting too long. If we've already waited this long
 * for all 3 to report, just go with what we have.
 */
const HARD_TIMEOUT_MS = 400;

/**
 * Count words in a transcript. Handles whitespace and punctuation.
 */
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Compute a quality score for a finalized transcript.
 * Higher = better. Combines:
 *  - Average confidence (0-1)
 *  - Word count (capped at 8 to avoid super-long transcripts dominating)
 *  - English preference bonus (Indian users often code-mix; English socket
 *    is usually more reliable for mixed content)
 *
 * @param {{accumulatedText: string, confidenceSum: number, confidenceCount: number}} state
 * @param {string} lang
 */
/**
 * Detect if a transcript is "Latin script dominant" — i.e., mostly English
 * letters and ASCII punctuation. This is the strongest signal that the user
 * actually spoke English, even when the Hindi socket also transcribed it.
 */
function isLatinScriptDominant(text) {
  if (!text) return false;
  // Count ASCII letters vs Devanagari/Gujarati script characters
  let latinChars = 0;
  let indicChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      latinChars++;
    } else if (
      // Devanagari (Hindi) range
      (code >= 0x0900 && code <= 0x097F) ||
      // Gujarati range
      (code >= 0x0A80 && code <= 0x0AFF)
    ) {
      indicChars++;
    }
  }
  // If 70%+ of letter-chars are Latin, treat as English speech
  const total = latinChars + indicChars;
  if (total === 0) return false;
  return latinChars / total >= 0.7;
}

/**
 * Detect if a Hindi transcript is "Devanagari dominant" — mostly Hindi script.
 * Used to confirm user actually spoke Hindi (not English transcribed by Hindi model).
 */
function isDevanagariDominant(text) {
  if (!text) return false;
  let latinChars = 0;
  let devChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      latinChars++;
    } else if (code >= 0x0900 && code <= 0x097F) {
      devChars++;
    }
  }
  const total = latinChars + devChars;
  if (total === 0) return false;
  return devChars / total >= 0.5;
}

/**
 * Detect if a Gujarati transcript is "Gujarati script dominant".
 */
function isGujaratiDominant(text) {
  if (!text) return false;
  let latinChars = 0;
  let gujChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      latinChars++;
    } else if (code >= 0x0A80 && code <= 0x0AFF) {
      gujChars++;
    }
  }
  const total = latinChars + gujChars;
  if (total === 0) return false;
  return gujChars / total >= 0.5;
}

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

  // ── Script-aware scoring (the key fix) ─────────────────────────────────
  //
  // Each Deepgram socket is optimized for one language. The transcript SCRIPT
  // tells us what the user *actually* spoke:
  //  - Latin script in en/hi/gu sockets → user spoke English
  //  - Devanagari in hi socket → user spoke Hindi
  //  - Gujarati script in gu socket → user spoke Gujarati
  //
  // We BOOST sockets whose script matches what they're supposed to handle,
  // and PENALIZE sockets transcribing in a script that doesn't match their
  // language (which usually means low-quality cross-language transcription).

  const latinDominant = isLatinScriptDominant(text);

  if (lang === "en") {
    // English socket should produce Latin text. If it does, big boost.
    if (latinDominant) score += 0.20;
    else score -= 0.10; // English socket producing Hindi/Gujarati script? Weird, penalize
  } else if (lang === "hi") {
    // Hindi socket: ideal is Devanagari. Latin-only means it transcribed English.
    if (latinDominant) {
      score -= 0.15; // English speech being routed to Hindi answer is bad
    } else if (isDevanagariDominant(text)) {
      score += 0.10;
    }
  } else if (lang === "gu") {
    // Gujarati socket: ideal is Gujarati script.
    if (latinDominant) {
      score -= 0.15; // English speech transcribed phonetically as Gujarati — bad
    } else if (isGujaratiDominant(text)) {
      score += 0.10;
    }
  }

  return score;
}

function checkAndTriggerFinalAnswer() {
  const finalized = Object.entries(turnState).filter(
    ([, s]) => s.speechFinalReceived,
  );
  const finalizedCount = finalized.length;

  // Fast path: all 3 finalized → trigger immediately
  if (finalizedCount === 3) {
    if (finalAnswerTimeout) {
      clearTimeout(finalAnswerTimeout);
      finalAnswerTimeout = null;
    }
    triggerWinner();
    return;
  }

  // First socket just finalized → check if it's strong enough alone
  if (finalizedCount === 1) {
    const [lang, state] = finalized[0];
    const text = state.accumulatedText.trim();
    const avgConf = state.confidenceCount > 0
      ? state.confidenceSum / state.confidenceCount
      : 0;
    const wordCount = countWords(text);

    // STRONG-AND-LONG path: super-confident transcript with enough words
    // skips the wait — fastest path, ~70-100ms STT latency
   // STRONG-AND-LONG path: super-confident long transcript.
// BUT — we still wait briefly for other sockets, because Deepgram's Hindi
// model often confidently transcribes English speech (or vice versa),
// and we need to compare across languages to pick the right one.
//
// Wait is SHORTER than the regular path (75ms vs 150ms) since this socket
// already has high-quality content — we just want a quick cross-check.
if (
  avgConf >= 0.98 &&
  wordCount >= MIN_WORDS_FOR_EARLY_TRIGGER &&
  text.length >= 12
) {
  if (!finalAnswerTimeout) {
    console.log(
      `[${ts()}] ⚡ Strong-and-long detected on ${lang}, brief 75ms cross-check wait (conf=${avgConf.toFixed(2)}, words=${wordCount})`,
    );
    finalAnswerTimeout = setTimeout(() => {
      finalAnswerTimeout = null;
      triggerWinner();
    }, 75);
  }
  return;
}

    // Otherwise: schedule a SHORT wait to let other sockets weigh in
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

  // Two finalized → if either is good, trigger now (don't wait for third)
  if (finalizedCount === 2) {
    if (finalAnswerTimeout) {
      clearTimeout(finalAnswerTimeout);
      finalAnswerTimeout = null;
    }

    // Quick check: is at least one of these good enough?
    const hasUsable = finalized.some(([lang, s]) => {
      const text = s.accumulatedText.trim();
      const wc = countWords(text);
      const conf = s.confidenceCount > 0 ? s.confidenceSum / s.confidenceCount : 0;
      return wc >= MIN_WORDS_FOR_EARLY_TRIGGER && conf >= EARLY_TRIGGER_CONF;
    });

    if (hasUsable) {
      console.log(`[${ts()}] ⚡ 2 sockets finalized, at least one is usable. Triggering.`);
      triggerWinner();
      return;
    }

    // Neither is great — wait briefly for the third (hard cap)
    if (!finalAnswerTimeout) {
      finalAnswerTimeout = setTimeout(() => {
        finalAnswerTimeout = null;
        triggerWinner();
      }, HARD_TIMEOUT_MS - WINNER_WAIT_MS); // total budget enforced
    }
    return;
  }

  // No sockets finalized yet — set a hard timeout safety net
  if (!finalAnswerTimeout) {
    finalAnswerTimeout = setTimeout(() => {
      console.log(`[${ts()}] ⏰ Hard timeout reached. Triggering with available transcripts.`);
      finalAnswerTimeout = null;
      triggerWinner();
    }, HARD_TIMEOUT_MS);
  }
}
function triggerWinner() {
  let winnerLang = "en";
  let maxScore = -1;
  let winnerText = "";

  console.log(`[${ts()}] 📊 Evaluating transcripts for the current turn:`);
  for (const lang of ["en", "hi", "gu"]) {
    const state = turnState[lang];
    const text = state.accumulatedText.trim();
    const avgConf = state.confidenceCount > 0 ? state.confidenceSum / state.confidenceCount : 0;
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

  // Reset turn state
  for (const lang of ["en", "hi", "gu"]) {
    turnState[lang] = {
      accumulatedText: "",
      confidenceSum: 0,
      confidenceCount: 0,
      interimText: "",
      speechFinalReceived: false
    };
  }

  if (winnerText) {
    const now = Date.now();
    const sttLatency = lastAudioTime ? now - lastAudioTime : 0;
    console.log(`[${ts()}] 🏆 Winner: "${winnerLang}" with "${winnerText}" (score=${maxScore.toFixed(3)}, STT Latency: ${sttLatency}ms)`);
  
    // Set lockout — late speech_final from other sockets will be ignored
    postTriggerLockoutUntil = now + POST_TRIGGER_LOCKOUT_MS;
  
    void triggerRagReply(winnerText, null, sttLatency, winnerLang);
  } else {
    console.log(`[${ts()}] ⚠️ No non-empty transcripts found for this turn.`);
  }
}

    if (dgKey) {
      const languages = ["en", "hi", "gu"];
      
      languages.forEach((lang) => {
        const dgQueryParams = new URLSearchParams({
          model: config.voice.deepgramModel || "nova-3",
          language: lang,
          // Endpointing: ms of silence before Deepgram declares end-of-speech.
          // 200ms is the practical floor for Indian-language voice agents.
          // Lower than this risks cutting mid-sentence on natural pauses.
          endpointing: "200",
          // Hard cutoff: if no speech_final after this much time, force one.
          utterance_end_ms: "1000",
          // VAD events let us detect speech-start early (useful for barge-in).
          vad_events: "true",
          interim_results: "true",
          smart_format: "true",
          punctuate: "true",
        });
        const dgUrl = `wss://api.deepgram.com/v1/listen?${dgQueryParams.toString()}`;
        console.log(`[${ts()}] 🔌 Connecting to Deepgram [${lang}] Streaming: ${dgUrl}`);
        
        const dgWs = new WebSocket(dgUrl, {
          headers: {
            Authorization: `Token ${dgKey}`,
          },
        });
        
        dgSockets[lang].ws = dgWs;

        dgWs.on("open", () => {
          dgSockets[lang].open = true;
          console.log(`[${ts()}] 🔌 Deepgram [${lang}] Streaming WS opened`);
          
          const buf = dgSockets[lang].buffer;
          while (buf.length > 0) {
            const chunk = buf.shift();
            dgWs.send(chunk);
          }

          const allOpen = languages.every((l) => dgSockets[l].open);
          if (allOpen && !sttReadySent) {
            sttReadySent = true;
            console.log(`[${ts()}] 🔌 All Deepgram sockets open. Sending stt_ready to client.`);
            safeSend(socket, { type: "stt_ready" });
          }
        });

        dgWs.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.channel && msg.channel.alternatives) {
              const alternative = msg.channel.alternatives[0];
              const transcript = alternative.transcript;
              const confidence = alternative.confidence;
              const isFinal = msg.is_final;
              const speechFinal = msg.speech_final;

              if (transcript) {
                if (isFinal) {
                  turnState[lang].accumulatedText += (turnState[lang].accumulatedText ? " " : "") + transcript;
                  turnState[lang].confidenceSum += confidence;
                  turnState[lang].confidenceCount += 1;
                  turnState[lang].interimText = "";
                } else {
                  turnState[lang].interimText = transcript;
                }
              }

              sendInterimUpdate();

              if (speechFinal && isFinal) {
                // Drop late echoes from other sockets after a winner was already triggered
                if (Date.now() < postTriggerLockoutUntil) {
                  console.log(
                    `[${ts()}] 🔇 Deepgram [${lang}] speech_final ignored (post-trigger lockout active, ${postTriggerLockoutUntil - Date.now()}ms left)`,
                  );
                  // Reset this socket's state so it's clean for the next real utterance
                  turnState[lang] = {
                    accumulatedText: "",
                    confidenceSum: 0,
                    confidenceCount: 0,
                    interimText: "",
                    speechFinalReceived: false,
                  };
                  return;
                }
              
                turnState[lang].speechFinalReceived = true;
                console.log(
                  `[${ts()}] 🎙️ Deepgram [${lang}] speech_final received: "${turnState[lang].accumulatedText}" (conf: ${confidence.toFixed(2)})`,
                );
                checkAndTriggerFinalAnswer();
              }
            }
          } catch (err) {
            console.error(`Error parsing Deepgram [${lang}] message:`, err);
          }
        });

        dgWs.on("error", (err) => {
          console.error(`[${ts()}] ❌ Deepgram [${lang}] WS error:`, err);
        });

        dgWs.on("close", (code, reason) => {
          console.log(`[${ts()}] 🔌 Deepgram [${lang}] WS closed (code: ${code}, reason: ${reason?.toString()})`);
          dgSockets[lang].open = false;
        });
      });

      keepAliveInterval = setInterval(() => {
        languages.forEach((l) => {
          const dgWs = dgSockets[l].ws;
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
          }
        });
      }, 3000);
    } else {
      console.error(`[${ts()}] ⚠️ DEEPGRAM_API_KEY not configured!`);
    }

    // ── Greeting ─────────────────────────────────────────────────────────────
    // Play greeting client-side via a direct HTTP TTS call in startCall()
    console.log(`[${ts()}] 🤖 Agent  : ${GREETING}`);

    /**
     * AbortController for the active reply (LLM stream + TTS chunker).
     * Aborting this cancels both the LLM stream and any pending TTS requests.
     * @type {AbortController | null}
     */
    let activeReply = null;

    socket.on("close", () => {
      activeReply?.abort();
      activeReply = null;
      if (finalAnswerTimeout) {
        clearTimeout(finalAnswerTimeout);
        finalAnswerTimeout = null;
      }
      for (const lang of ["en", "hi", "gu"]) {
        const dg = dgSockets[lang];
        if (dg && dg.ws && (dg.ws.readyState === WebSocket.OPEN || dg.ws.readyState === WebSocket.CONNECTING)) {
          dg.ws.close();
        }
      }
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
      console.log(`[${ts()}] 🔴 Client disconnected (ip: ${ip})\n`);
    });

    let lastAudioTime = 0;

    socket.on("message", async (raw, isBinary) => {
      // ── Basic validation ───────────────────────────────────────────────────
      if (isBinary) {
        lastAudioTime = Date.now();
        for (const lang of ["en", "hi", "gu"]) {
          const dg = dgSockets[lang];
          if (dg && dg.ws) {
            if (dg.open) {
              dg.ws.send(raw);
            } else {
              dg.buffer.push(raw);
            }
          }
        }
        return;
      }

      if (!wsAllow(ip)) {
        safeSend(socket, {
          type:    "error",
          code:    "rate_limited",
          message: "Too many messages; try again later",
        });
        return;
      }

      if (raw.length > MAX_MESSAGE_BYTES) {
        safeSend(socket, {
          type:    "error",
          code:    "message_too_large",
          message: `Max message size is ${MAX_MESSAGE_BYTES} bytes`,
        });
        return;
      }

      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        safeSend(socket, {
          type:    "error",
          code:    "invalid_json",
          message: "Body must be JSON",
        });
        return;
      }

      const keyCandidate = String(body.apiKey ?? "").trim() || keyFromUrl;
      if (!isChatApiKeyValid(keyCandidate, chatApiKey)) {
        safeSend(socket, {
          type:    "error",
          code:    "invalid_api_key",
          message: "Missing or wrong apiKey",
        });
        return;
      }

      // Handle interrupt request
      if (body.type === "interrupt") {
        console.log(`[${ts()}] ⏹️  Client sent interrupt message`);
        if (activeReply) {
          activeReply.abort();
          activeReply = null;
        }
        if (finalAnswerTimeout) {
          clearTimeout(finalAnswerTimeout);
          finalAnswerTimeout = null;
        }
        // Reset turn state on interrupt
        for (const lang of ["en", "hi", "gu"]) {
          turnState[lang] = {
            accumulatedText: "",
            confidenceSum: 0,
            confidenceCount: 0,
            interimText: "",
            speechFinalReceived: false
          };
        }
        return;
      }

      const question = String(body.question ?? "").trim();
      if (!question) {
        // If not a question and not interrupt, just ignore
        return;
      }

      // If user typed a question or sent it via JSON, handle it
      void triggerRagReply(question, body.history);
    });

    async function triggerRagReply(questionText, clientHistory, sttLatency = 0, winnerLang = null) {
      const queryStartTime = Date.now();
      if (activeReply) {
        activeReply.abort();
        console.log(`[${ts()}] ⏹️  Interrupted previous reply`);
      }

      // ── Set up this reply ─────────────────────────────────────────────────
      const replyAbort = new AbortController();
      activeReply      = replyAbort;
      const signal     = replyAbort.signal;

      let fullAnswer      = "";
      let capturedSources = null;

      // Detect language: use winnerLang if provided, else run detectLanguage on the text (typed input fallback)
      const detected = winnerLang || detectLanguage(questionText);
      const langMap = {
        gu: "gu-IN",
        hi: "hi-IN",
        en: "en-IN"
      };
      const targetLanguageCode = langMap[detected] || "en-IN";
      console.log(`[${ts()}] 🌐 Detected language: "${detected}" -> TTS language: "${targetLanguageCode}"`);

      // Notify the client of the user question with STT latency & queryStartTime
      safeSend(socket, {
        type: "user_question",
        text: questionText,
        sttLatency,
        queryStartTime,
      });

      const chunker = createTtsChunker({
        sendFn: (chunkId, b64) => {
          if (socket.readyState === 1 && !signal.aborted) {
            safeSend(socket, { type: "tts_chunk", chunkId, audio: b64 });
          }
        },
        signal,
        targetLanguageCode,
      });

      console.log(`[${ts()}] 🧠 Initiating streamRagAnswer...`);

      try {
        const history = clientHistory ? parseChatHistory(clientHistory) : [...chatHistory];

        await streamRagAnswer(
          questionText,
          (ev) => {
            if (signal.aborted) {
              console.log(`[${ts()}] ⚠️  emit ignored (aborted)`);
              return;
            }
            if (ev.type === "token" && ev.text) {
              fullAnswer += ev.text;
              console.log(`[${ts()}] 📤 Token: "${ev.text}"`);
              safeSend(socket, { type: "token", text: ev.text });
              chunker.push(ev.text);
            }
            if (ev.type === "done") {
              capturedSources = ev.sources ?? [];
              console.log(`[${ts()}] 🤖 Agent  : ${fullAnswer}`);
              if (ev.sources?.length) {
                const urls = ev.sources.map((s) => s.url || s.title).join(", ");
                console.log(`[${ts()}] 📎 Sources: ${urls}`);
              }
            }
          },
          history,
          signal,
          detected,
        );

        await chunker.flush();

        if (!signal.aborted) {
          safeSend(socket, { type: "tts_done" });
          safeSend(socket, { type: "done", sources: capturedSources ?? [] });
          console.log(`[${ts()}] 📤 Sent tts_done + done`);

          // Store in session history
          chatHistory.push({ role: "user", content: questionText });
          chatHistory.push({ role: "assistant", content: fullAnswer });
        }
      } catch (err) {
        if (signal.aborted) return;
        const code = err?.code;
        if (code === "NO_OPENAI_KEY") {
          safeSend(socket, {
            type:    "error",
            code:    "no_openai_key",
            message: "OPENAI_API_KEY is not configured",
          });
        } else {
          console.error(`[${ts()}] ❌ [ws/chat]`, err);
          safeSend(socket, {
            type:    "error",
            code:    "chat_failed",
            message: "Something went wrong processing the chat",
          });
        }
      } finally {
        if (activeReply === replyAbort) activeReply = null;
      }
    }
  });
}
