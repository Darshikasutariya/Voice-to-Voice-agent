import http from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import multer from "multer";

import { config } from "./src/config.js";
import { ragAnswer, parseChatHistory } from "./src/rag.js";
import { attachChatSocket } from "./src/wsChat.js";
import { extractHttpApiKey, isChatApiKeyValid } from "./src/security.js";
import { transcribeAudio } from "./src/voice/transcribe.js";
import { synthesizeSarvam } from "./src/voice/sarvamTts.js";

const app = express();

if (config.security.trustProxy) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

app.use(
  cors(
    config.server.cors.mode === "reflect"
      ? { origin: true, credentials: true }
      : { origin: config.server.cors.origins, credentials: true },
  ),
);

const chatHttpLimiter = rateLimit({
  windowMs: config.security.httpRateLimitWindowMs,
  limit: config.security.httpRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", code: "rate_limited" },
});

const voiceHttpLimitVal = parseInt(
  process.env.VOICE_RATE_LIMIT_MAX ?? "45",
  10,
);
const voiceHttpLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number.isFinite(voiceHttpLimitVal) && voiceHttpLimitVal > 0
    ? voiceHttpLimitVal
    : 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", code: "rate_limited" },
});

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function requireChatApiKey(req, res, next) {
  if (
    !isChatApiKeyValid(
      extractHttpApiKey(req),
      config.security.chatApiKey,
    )
  ) {
    res
      .status(401)
      .json({ error: "unauthorized", code: "invalid_api_key" });
    return;
  }
  next();
}

const { host, port } = config.server;

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: `Server is running on port ${port}`,
    websocket: "/ws/chat",
  });
});

app.post(
  "/api/chat",
  chatHttpLimiter,
  requireChatApiKey,
  async (req, res) => {
    const question = String(req.body?.question ?? "").trim();
    if (!question) {
      res.status(400).json({ error: "question is required" });
      return;
    }
    try {
      const out = await ragAnswer(
        question,
        parseChatHistory(req.body?.history),
      );
      res.json(out);
    } catch (err) {
      const code = err?.code;
      if (code === "NO_OPENAI_KEY") {
        res.status(503).json({
          error: "OPENAI_API_KEY is not configured",
          code: "no_openai_key",
        });
        return;
      }
      console.error(err);
      res.status(500).json({ error: "chat_failed", code: "chat_failed" });
    }
  },
);

app.post(
  "/api/voice/transcribe",
  voiceHttpLimiter,
  requireChatApiKey,
  uploadAudio.single("audio"),
  async (req, res) => {
    if (!req.file?.buffer) {
      res.status(400).json({
        error: "audio file required (multipart field name: audio)",
      });
      return;
    }
    try {
      const text = await transcribeAudio(
        req.file.buffer,
        req.file.mimetype || "application/octet-stream",
      );
      console.log(`[voice/transcribe] 🎤 Transcribed: "${text}"`);
      res.json({ text });
    } catch (err) {
      const code = err?.code;
      if (code === "NO_DEEPGRAM" || code === "NO_SARVAM") {
        res.status(503).json({ error: err.message, code });
        return;
      }
      console.error("[voice/transcribe]", err);
      res.status(500).json({
        error: "transcribe_failed",
        message: String(err?.message || err),
      });
    }
  },
);

app.post(
  "/api/voice/tts",
  voiceHttpLimiter,
  requireChatApiKey,
  async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    try {
      const { buffer, contentType } = await synthesizeSarvam(text);
      res.setHeader("Content-Type", contentType);
      res.send(buffer);
    } catch (err) {
      const code = err?.code;
      if (code === "NO_SARVAM") {
        res.status(503).json({ error: err.message, code });
        return;
      }
      console.error("[voice/tts]", err);
      res.status(500).json({
        error: "tts_failed",
        message: String(err?.message || err),
      });
    }
  },
);

app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    path: req.path,
    message: "Route not found",
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/chat" });
attachChatSocket(wss, {
  chatApiKey: config.security.chatApiKey,
  wsRateLimitWindowMs: config.security.wsRateLimitWindowMs,
  wsRateLimitMax: config.security.wsRateLimitMax,
});

const browserHost = host === "0.0.0.0" ? "localhost" : host;

server.listen(port, host, () => {
  console.log("─".repeat(55));
  console.log("  🎙️  TaxOne Voice Agent — backend ready");
  console.log("─".repeat(55));
  console.log(`  HTTP      : http://${browserHost}:${port}`);
  console.log(`  WebSocket : ws://${browserHost}:${port}/ws/chat`);
  if (config.security.chatApiKey) {
    console.log("  Auth      : CHAT_API_KEY is set");
  }
  console.log("─".repeat(55));
  console.log("  Waiting for connections… (each Q&A will log below)");
  console.log("─".repeat(55));
});
