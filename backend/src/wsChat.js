import { config } from "./config.js";
import { streamRagAnswer, parseChatHistory } from "./rag.js";
import { isChatApiKeyValid } from "./security.js";
import { createWindowLimiter } from "./rateLimit.js";
import { createTtsChunker } from "./voice/ttsChunker.js";
import { createSttRouter } from "./voice/sttRouter.js";
import { detectLanguage } from "./utils/langDetect.js";

const MAX_MESSAGE_BYTES = 64 * 1024;

const GREETING =
  "Hello! I'm your TaxOne support agent. How can I help you today?";

const LANG_MAP = { gu: "gu-IN", hi: "hi-IN", en: "en-IN" };

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
 * @param {{ chatApiKey: string, wsRateLimitWindowMs: number, wsRateLimitMax: number }} opts
 */
export function attachChatSocket(wss, opts) {
  const { chatApiKey } = opts;
  const wsAllow = createWindowLimiter(opts.wsRateLimitWindowMs, opts.wsRateLimitMax);

  wss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    console.log(`\n[${ts()}] 🟢 New client connected  (ip: ${ip})`);

    // ── Per-connection state ─────────────────────────────────────────────
    const chatHistory = [];
    /** AbortController for the active reply; aborting cancels LLM + TTS. */
    let activeReply = null;

    // Parse URL params (language preference + apiKey)
    let keyFromUrl = "";
    try {
      const urlParams = new URL(req.url || "/", "http://localhost").searchParams;
      const language = urlParams.get("language")?.trim() || "multi";
      keyFromUrl = urlParams.get("apiKey")?.trim() ?? "";
      console.log(`[${ts()}] 👤 Client preferred language: "${language}"`);
    } catch {
      // ignore bad URL
    }

    // ── STT Router (3 Deepgram sockets + winner selection) ──────────────
    const stt = createSttRouter({
      apiKey: config.voice.deepgramApiKey,
      onWinner: (text, lang, sttLatency) => {
        void triggerRagReply(text, null, sttLatency, lang);
      },
      onInterim: (text) => {
        safeSend(socket, { type: "interim_transcript", text });
      },
      onReady: () => {
        safeSend(socket, { type: "stt_ready" });
      },
    });

    console.log(`[${ts()}] 🤖 Agent  : ${GREETING}`);

    // ── Client WebSocket lifecycle ──────────────────────────────────────

    socket.on("close", () => {
      activeReply?.abort();
      activeReply = null;
      stt.close();
      console.log(`[${ts()}] 🔴 Client disconnected (ip: ${ip})\n`);
    });

    socket.on("message", async (raw, isBinary) => {
      // Binary = audio chunk → forward to STT router
      if (isBinary) {
        stt.sendAudio(raw);
        return;
      }

      // Rate limit
      if (!wsAllow(ip)) {
        safeSend(socket, {
          type: "error",
          code: "rate_limited",
          message: "Too many messages; try again later",
        });
        return;
      }

      // Size limit
      if (raw.length > MAX_MESSAGE_BYTES) {
        safeSend(socket, {
          type: "error",
          code: "message_too_large",
          message: `Max message size is ${MAX_MESSAGE_BYTES} bytes`,
        });
        return;
      }

      // Parse JSON
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        safeSend(socket, {
          type: "error",
          code: "invalid_json",
          message: "Body must be JSON",
        });
        return;
      }

      // Auth
      const keyCandidate = String(body.apiKey ?? "").trim() || keyFromUrl;
      if (!isChatApiKeyValid(keyCandidate, chatApiKey)) {
        safeSend(socket, {
          type: "error",
          code: "invalid_api_key",
          message: "Missing or wrong apiKey",
        });
        return;
      }

      // Interrupt request
      if (body.type === "interrupt") {
        console.log(`[${ts()}] ⏹️  Client sent interrupt message`);
        if (activeReply) {
          activeReply.abort();
          activeReply = null;
        }
        stt.resetTurn();
        return;
      }

      // Typed question (no STT path)
      const question = String(body.question ?? "").trim();
      if (!question) return;

      stt.markAudioReceived(); // mark for STT latency calc (best-effort)
      void triggerRagReply(question, body.history);
    });

    // ── Reply orchestrator (one RAG turn) ───────────────────────────────

    async function triggerRagReply(questionText, clientHistory, sttLatency = 0, winnerLang = null) {
      const queryStartTime = Date.now();

      // Cancel any in-flight reply
      if (activeReply) {
        activeReply.abort();
        console.log(`[${ts()}] ⏹️  Interrupted previous reply`);
      }

      const replyAbort = new AbortController();
      activeReply = replyAbort;
      const signal = replyAbort.signal;

      let fullAnswer = "";
      let capturedSources = null;

      // Single source of truth for language: prefer winnerLang from STT,
      // fall back to text-based detection for typed input.
      const detected = winnerLang || detectLanguage(questionText);
      const targetLanguageCode = LANG_MAP[detected] || "en-IN";
      console.log(`[${ts()}] 🌐 Detected language: "${detected}" -> TTS language: "${targetLanguageCode}"`);

      // Notify client of the user question + timing
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

          // Persist this exchange in server-side history
          chatHistory.push({ role: "user", content: questionText });
          chatHistory.push({ role: "assistant", content: fullAnswer });
        }
      } catch (err) {
        if (signal.aborted) return;
        const code = err?.code;
        if (code === "NO_OPENAI_KEY") {
          safeSend(socket, {
            type: "error",
            code: "no_openai_key",
            message: "OPENAI_API_KEY is not configured",
          });
        } else {
          console.error(`[${ts()}] ❌ [ws/chat]`, err);
          safeSend(socket, {
            type: "error",
            code: "chat_failed",
            message: "Something went wrong processing the chat",
          });
        }
      } finally {
        if (activeReply === replyAbort) activeReply = null;
      }
    }
  });
}