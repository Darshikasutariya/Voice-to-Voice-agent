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

    function checkAndTriggerFinalAnswer() {
      const allFinished = Object.values(turnState).every(s => s.speechFinalReceived);
      
      if (allFinished) {
        if (finalAnswerTimeout) {
          clearTimeout(finalAnswerTimeout);
          finalAnswerTimeout = null;
        }
        triggerWinner();
      } else {
        if (!finalAnswerTimeout) {
          finalAnswerTimeout = setTimeout(() => {
            console.log(`[${ts()}] ⏰ Turn timeout reached. Triggering winner based on available transcripts.`);
            finalAnswerTimeout = null;
            triggerWinner();
          }, 250);
        }
      }
    }

    function triggerWinner() {
      let winnerLang = "en";
      let maxConfidence = -1;
      let winnerText = "";

      console.log(`[${ts()}] 📊 Evaluating transcripts for the current turn:`);
      for (const lang of ["en", "hi", "gu"]) {
        const state = turnState[lang];
        const text = state.accumulatedText.trim();
        const avgConf = state.confidenceCount > 0 ? state.confidenceSum / state.confidenceCount : 0;
        console.log(`   - [${lang}]: "${text}" (avg conf: ${avgConf.toFixed(3)}, chunks: ${state.confidenceCount})`);
        
        if (text && avgConf > maxConfidence) {
          maxConfidence = avgConf;
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
        console.log(`[${ts()}] 🏆 Winner language: "${winnerLang}" with transcript: "${winnerText}" (STT Latency: ${sttLatency}ms)`);
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
          endpointing: "300",
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
                turnState[lang].speechFinalReceived = true;
                console.log(`[${ts()}] 🎙️ Deepgram [${lang}] speech_final received: "${turnState[lang].accumulatedText}" (conf: ${confidence.toFixed(2)})`);
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
