import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Always load backend/.env (this file lives in backend/src/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Disable TLS verification ONLY in development (for corporate proxies / self-signed certs).
// In production this would be a security hole — set NODE_ENV=production to enforce.
if (process.env.NODE_ENV !== "production") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/** @param {string | undefined} raw @param {number} fallback */
function parsePort(raw, fallback) {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback;
}

/** @param {string | undefined} raw @param {number} fallback */
function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * CORS:
 * - unset or `*` → reflect request Origin (convenient for local dev)
 * - comma-separated list → allow only those origins
 * @returns {{ mode: "reflect" } | { mode: "list", origins: string[] }}
 */
function parseCorsConfig() {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === "*") {
    return { mode: "reflect" };
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { mode: "list", origins };
}

export const config = {
  crawl: {
    baseUrl: process.env.CRAWL_BASE_URL || "https://taxone.vyapar.com/help",
    maxDepth: parsePositiveInt(process.env.CRAWL_MAX_DEPTH, 3),
    delayMs: parsePositiveInt(process.env.CRAWL_DELAY_MS, 500),
    concurrency: parsePositiveInt(process.env.CRAWL_CONCURRENCY, 4),
    userAgent: "TaxOneIngestBot/0.1 (RAG indexing)",
  },
  chunk: {
    chunkSize: 1000,
    chunkOverlap: 150,
  },
  embed: {
    modelId: "Xenova/bge-m3",
    pooling: "cls",
    normalize: true,
    batchSize: 8,
    dtype: (process.env.EMBED_DTYPE?.trim() || "q8").toLowerCase(),
  },
  chroma: {
    url: process.env.CHROMA_URL || "http://localhost:8000",
    collection: process.env.CHROMA_COLLECTION || "taxone_help_v1",
  },
  paths: {
    scrapeOutput: "./data/scraped.json",
  },

  /** HTTP + WebSocket process */
  server: {
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: parsePort(process.env.PORT, 3001),
    cors: parseCorsConfig(),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  },

  /** Set CHAT_API_KEY empty in .env to disable auth (local dev). */
  security: {
    chatApiKey: process.env.CHAT_API_KEY?.trim() ?? "",
    httpRateLimitWindowMs: parsePositiveInt(
      process.env.RATE_LIMIT_WINDOW_MS,
      60_000,
    ),
    httpRateLimitMax: parsePositiveInt(process.env.RATE_LIMIT_MAX, 30),
    wsRateLimitWindowMs: parsePositiveInt(
      process.env.WS_RATE_LIMIT_WINDOW_MS,
      60_000,
    ),
    wsRateLimitMax: parsePositiveInt(process.env.WS_RATE_LIMIT_MAX, 20),
    /** Set "1" behind a reverse proxy so client IP uses X-Forwarded-For */
    trustProxy: process.env.TRUST_PROXY?.trim() === "1",
  },

  /** Voice: STT via Deepgram (streaming) or Sarvam, TTS via Sarvam. */
  voice: {
    sttProvider: (process.env.VOICE_STT_PROVIDER || "deepgram")
      .trim()
      .toLowerCase(),
    deepgramApiKey: process.env.DEEPGRAM_API_KEY?.trim() ?? "",
    deepgramModel: process.env.DEEPGRAM_MODEL?.trim() || "nova-3",
    deepgramLanguage: process.env.DEEPGRAM_LANGUAGE?.trim() || "multi",
    sarvamApiKey: process.env.SARVAM_API_KEY?.trim() ?? "",
    sarvamSttModel: process.env.SARVAM_STT_MODEL?.trim() || "saaras:v3",
    sarvamSttLanguage:
      process.env.SARVAM_STT_LANGUAGE?.trim() || "unknown",
    sarvamTtsModel: process.env.SARVAM_TTS_MODEL?.trim() || "bulbul:v2",
    sarvamTtsSpeaker: process.env.SARVAM_TTS_SPEAKER?.trim() || "shubh",
    sarvamTtsLang: process.env.SARVAM_TTS_LANG?.trim() || "en-IN",
  },
};