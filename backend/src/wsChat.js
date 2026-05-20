import { streamRagAnswer, parseChatHistory } from "./rag.js";
import { isChatApiKeyValid } from "./security.js";
import { createWindowLimiter } from "./rateLimit.js";

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
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

/**
 * @param {import("ws").WebSocketServer} wss
 * @param {object} opts
 * @param {string} opts.chatApiKey
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

    // --- Send greeting ---
    safeSend(socket, { type: "token", text: GREETING });
    safeSend(socket, { type: "done", sources: [] });
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

    /** @type {AbortController | null} */
    let activeReply = null;

    socket.on("close", () => {
      activeReply?.abort();
      activeReply = null;
      console.log(`[${ts()}] 🔴 Client disconnected (ip: ${ip})\n`);
    });

    socket.on("message", async (raw, isBinary) => {
      if (isBinary) {
        safeSend(socket, {
          type: "error",
          code: "binary_not_supported",
          message: "Send UTF-8 JSON text only",
        });
        return;
      }

      if (!wsAllow(ip)) {
        safeSend(socket, {
          type: "error",
          code: "rate_limited",
          message: "Too many messages; try again later",
        });
        return;
      }

      if (raw.length > MAX_MESSAGE_BYTES) {
        safeSend(socket, {
          type: "error",
          code: "message_too_large",
          message: `Max message size is ${MAX_MESSAGE_BYTES} bytes`,
        });
        return;
      }

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

      const keyCandidate =
        String(body.apiKey ?? "").trim() || keyFromUrl;
      if (!isChatApiKeyValid(keyCandidate, chatApiKey)) {
        safeSend(socket, {
          type: "error",
          code: "invalid_api_key",
          message: "Missing or wrong apiKey (use X-API-Key equivalent: JSON apiKey or ?apiKey= on URL)",
        });
        return;
      }

      const question = String(body.question ?? "").trim();
      if (!question) {
        safeSend(socket, {
          type: "error",
          code: "question_required",
          message: 'Include a "question" string',
        });
        return;
      }

      // --- Log the incoming question ---
      console.log(`\n[${ts()}] 👤 User   : ${question}`);

      if (activeReply) {
        activeReply.abort();
        console.log(`[${ts()}] ⏹️  Interrupted previous reply`);
      }

      const replyAbort = new AbortController();
      activeReply = replyAbort;
      let fullAnswer = "";

      try {
        const history = parseChatHistory(body.history);

        // Wrap emit so we also accumulate the answer for logging
        await streamRagAnswer(
          question,
          (ev) => {
            if (replyAbort.signal.aborted) return;
            if (ev.type === "token" && ev.text) {
              fullAnswer += ev.text;
            }
            if (ev.type === "done") {
              // --- Log the complete answer ---
              console.log(`[${ts()}] 🤖 Agent  : ${fullAnswer}`);
              if (ev.sources?.length) {
                const urls = ev.sources.map((s) => s.url || s.title).join(", ");
                console.log(`[${ts()}] 📎 Sources: ${urls}`);
              }
            }
            safeSend(socket, ev);
          },
          history,
          replyAbort.signal,
        );
      } catch (err) {
        if (replyAbort.signal.aborted) return;
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
    });
  });
}
