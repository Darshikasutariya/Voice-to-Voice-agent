import { config } from "../config.js";
import { detectLanguage } from "../utils/langDetect.js";
const LANG_MAP = { gu: "gu-IN", hi: "hi-IN", en: "en-IN" };

const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function isNetworkError(err) {
  const msg = String(err?.message ?? err);
  const code = err?.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    msg.includes("ECONNRESET") ||
    msg.includes("fetch failed")
  );
}

function requireSarvamKey() {
  const key = config.voice.sarvamApiKey;
  if (!key) {
    throw Object.assign(new Error("SARVAM_API_KEY not set"), { code: "NO_SARVAM" });
  }
  return key;
}

function resolveLang(text, targetLanguageCode) {
    if (targetLanguageCode) return targetLanguageCode;
    return LANG_MAP[detectLanguage(text)] || config.voice.sarvamTtsLang;
}

function buildBody(text, langCode) {
  return JSON.stringify({
    text: text.slice(0, 2500),
    target_language_code: langCode,
    model: config.voice.sarvamTtsModel,
    speaker: config.voice.sarvamTtsSpeaker,
    output_audio_codec: "mp3",
  });
}

/**
 * One fetch to Sarvam TTS. Returns the raw base64 audio string.
 * Throws on HTTP error or invalid JSON. Used by both public APIs below.
 */
async function fetchSarvamBase64(body, key, signal, label) {
  const start = Date.now();
  const res = await fetch(SARVAM_TTS_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });

  const ms = Date.now() - start;
  console.log(`[voice/tts] Sarvam ${label} response in ${ms}ms, HTTP ${res.status}`);

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error("invalid JSON from Sarvam TTS");
  }

  const first = json?.audios?.[0];
  const b64 =
    typeof first === "string"
      ? first
      : (first?.audio_content ?? first?.audio ?? first?.data ?? "");
  if (!b64) {
    throw new Error("Sarvam TTS: missing audios[0] payload");
  }
  return b64;
}

/**
 * Generic retry wrapper. Retries ONLY on network errors (not on 4xx API errors).
 * @param {() => Promise<T>} fn
 * @param {number[]} delaysMs - one entry per retry attempt
 * @param {string} label - for logs
 * @template T
 */
async function withRetry(fn, delaysMs, label) {
  let lastErr = "Sarvam TTS failed";
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = String(err?.message ?? err);
      if (!isNetworkError(err) || attempt === delaysMs.length) {
        throw new Error(lastErr);
      }
      const waitMs = delaysMs[attempt];
      console.warn(
        `[voice/tts] ${label}: ${lastErr} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${delaysMs.length + 1})`,
      );
      await delay(waitMs);
    }
  }
  throw new Error(lastErr);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Full HTTP TTS — returns a Buffer + content type. Used by the /api/voice/tts
 * endpoint and the frontend's HTTP fallback path.
 *
 * @param {string} text
 * @param {string} [targetLanguageCode]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function synthesizeSarvam(text, targetLanguageCode, signal) {
  const startTts = Date.now();
  console.log(`[voice/tts] synthesizeSarvam called for text length: ${text.length} chars`);
  console.log(`[voice/tts] Fetching Sarvam TTS from: ${SARVAM_TTS_URL}`);

  const key = requireSarvamKey();
  const lang = resolveLang(text, targetLanguageCode);
  const body = buildBody(text, lang);

  const b64 = await withRetry(
    () => fetchSarvamBase64(body, key, signal, "HTTP"),
    [500, 1500, 3000],          // 3 retries with longer backoff
    "synthesizeSarvam",
  );

  const buffer = Buffer.from(b64, "base64");
  console.log(`[voice/tts] Successfully decoded base64 audio payload. Size: ${buffer.length} bytes`);
  console.log(`[voice/tts] synthesizeSarvam completed successfully in ${Date.now() - startTts}ms total`);

  return { buffer, contentType: "audio/mpeg" };
}

/**
 * Streaming TTS — returns the raw base64 string (no Buffer round-trip).
 * Used by the WS TTS chunker for low-latency streaming.
 *
 * @param {string} text
 * @param {string} [targetLanguageCode]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} base64-encoded MP3 audio
 */
export async function synthesizeSarvamBase64(text, targetLanguageCode, signal) {
  const startTts = Date.now();
  console.log(`[voice/tts] synthesizeSarvamBase64 called, ${text.length} chars`);

  const key = requireSarvamKey();
  const lang = resolveLang(text, targetLanguageCode);
  const body = buildBody(text, lang);

  const b64 = await withRetry(
    () => fetchSarvamBase64(body, key, signal, "b64"),
    [300, 1000],                // 2 retries, faster for streaming
    "synthesizeSarvamBase64",
  );

  console.log(`[voice/tts] b64 audio length: ${b64.length} chars`);
  console.log(`[voice/tts] synthesizeSarvamBase64 done in ${Date.now() - startTts}ms`);
  return b64;
}