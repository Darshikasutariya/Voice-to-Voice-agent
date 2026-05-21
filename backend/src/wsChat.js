import { streamRagAnswer, parseChatHistory } from "./rag.js";
import { isChatApiKeyValid } from "./security.js";
import { createWindowLimiter } from "./rateLimit.js";
import { createTtsChunker } from "./voice/ttsChunker.js";

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

    // ── Greeting ─────────────────────────────────────────────────────────────
    // The frontend ignores WS messages until the user clicks "Call support",
    // so these messages will be dropped on the client. The greeting is played
    // client-side via a direct HTTP TTS call in startCall().
    safeSend(socket, { type: "token", text: GREETING });
    safeSend(socket, { type: "done",  sources: [] });
    console.log(`[${ts()}] 🤖 Agent  : ${GREETING}`);

    let keyFromUrl = "";
    try {
      keyFromUrl =
        new URL(req.url || "/", "http://localhost").searchParams
          .get("apiKey")
          ?.trim() ?? "";
    } catch {
      // ignore bad URL
    }

    /**
     * AbortController for the active reply (LLM stream + TTS chunker).
     * Aborting this cancels both the LLM stream and any pending TTS requests.
     * @type {AbortController | null}
     */
    let activeReply = null;

    socket.on("close", () => {
      activeReply?.abort();
      activeReply = null;
      console.log(`[${ts()}] 🔴 Client disconnected (ip: ${ip})\n`);
    });

    socket.on("message", async (raw, isBinary) => {
      // ── Basic validation ───────────────────────────────────────────────────
      if (isBinary) {
        safeSend(socket, {
          type:    "error",
          code:    "binary_not_supported",
          message: "Send UTF-8 JSON text only",
        });
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

      const question = String(body.question ?? "").trim();
      if (!question) {
        safeSend(socket, {
          type:    "error",
          code:    "question_required",
          message: 'Include a "question" string',
        });
        return;
      }

      // ── Interrupt previous reply ───────────────────────────────────────────
      console.log(`\n[${ts()}] 👤 User   : ${question}`);

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

      /**
       * Streaming TTS chunker:
       *  - Each time it has a sentence/clause chunk ready, it calls Sarvam TTS
       *  - TTS results are sent in-order as { type: "tts_chunk", chunkId, audio }
       *  - Concurrent TTS calls overlap with continued LLM streaming
       */
      const chunker = createTtsChunker({
        sendFn: (chunkId, b64) => {
          if (socket.readyState === 1 && !signal.aborted) {
            safeSend(socket, { type: "tts_chunk", chunkId, audio: b64 });
          }
        },
        signal,
      });

      console.log(`[${ts()}] 🧠 Initiating streamRagAnswer...`);

      try {
        const history = parseChatHistory(body.history);

        await streamRagAnswer(
          question,
          (ev) => {
            if (signal.aborted) {
              console.log(`[${ts()}] ⚠️  emit ignored (aborted)`);
              return;
            }
            if (ev.type === "token" && ev.text) {
              fullAnswer += ev.text;
              console.log(`[${ts()}] 📤 Token: "${ev.text}"`);
              // Send text token for live display in the UI
              safeSend(socket, { type: "token", text: ev.text });
              // Also feed into the TTS chunker
              chunker.push(ev.text);
            }
            if (ev.type === "done") {
              // Capture sources — we send done AFTER tts_done (see below)
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
        );

        // Flush any remaining text from the chunker and wait for ALL TTS calls
        // to complete (i.e. all tts_chunk messages have been sent).
        await chunker.flush();

        if (!signal.aborted) {
          // tts_done tells the client the audio queue is fully populated.
          // done(sources) finalises the text bubble.
          safeSend(socket, { type: "tts_done" });
          safeSend(socket, { type: "done", sources: capturedSources ?? [] });
          console.log(`[${ts()}] 📤 Sent tts_done + done`);
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
    });
  });
}
