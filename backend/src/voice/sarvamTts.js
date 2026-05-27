import { config } from "../config.js";
import { detectLanguage } from "../utils/langDetect.js";

const SARVAM_TTS_URLS = [
  "https://api.sarvam.ai/text-to-speech",
];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Attempt a single TTS fetch against one URL.
 * Returns { buffer, contentType } on success, throws on failure.
 */
async function attemptTts(url, body, key, signal) {
  const startFetch = Date.now();
  console.log(`[voice/tts] Fetching Sarvam TTS from: ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });

  const fetchDuration = Date.now() - startFetch;
  console.log(`[voice/tts] Sarvam response received in ${fetchDuration}ms, HTTP status: ${res.status}`);

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

  const buffer = Buffer.from(b64, "base64");
  console.log(`[voice/tts] Successfully decoded base64 audio payload. Size: ${buffer.length} bytes`);
  return { buffer, contentType: "audio/mpeg" };
}

/**
 * Attempt a single TTS fetch and return the raw base64 string.
 * Used by the streaming chunker to avoid double Buffer encode/decode.
 */
async function attemptTtsBase64(url, body, key, signal) {
  const startFetch = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });

  const fetchDuration = Date.now() - startFetch;
  console.log(`[voice/tts] Sarvam (b64) response in ${fetchDuration}ms, HTTP ${res.status}`);

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

  console.log(`[voice/tts] b64 audio length: ${b64.length} chars`);
  return b64;
}


/**
 * @param {string} text
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function synthesizeSarvam(text, targetLanguageCode, signal) {
  const startTts = Date.now();
  console.log(`[voice/tts] synthesizeSarvam called for text length: ${text.length} chars`);

  const key = config.voice.sarvamApiKey;
  if (!key) {
    throw Object.assign(new Error("SARVAM_API_KEY not set"), {
      code: "NO_SARVAM",
    });
  }

  const detected = detectLanguage(text);
  const langMap = {
    gu: "gu-IN",
    hi: "hi-IN",
    en: "en-IN"
  };
  const resolvedLang = targetLanguageCode || langMap[detected] || config.voice.sarvamTtsLang;

  const body = JSON.stringify({
    text: text.slice(0, 2500),
    target_language_code: resolvedLang,
    model: config.voice.sarvamTtsModel,
    speaker: config.voice.sarvamTtsSpeaker,
    output_audio_codec: "mp3",
  });

  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [500, 1500, 3000]; // backoff between retries

  let lastErr = "Sarvam TTS failed";

  for (const url of SARVAM_TTS_URLS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await attemptTts(url, body, key, signal);
        const totalTtsDuration = Date.now() - startTts;
        console.log(`[voice/tts] synthesizeSarvam completed successfully in ${totalTtsDuration}ms total`);
        return result; // success — return immediately
      } catch (err) {
        lastErr = String(err?.message ?? err);
        const isNetworkReset =
          err?.cause?.code === "ECONNRESET" ||
          err?.cause?.code === "ECONNREFUSED" ||
          err?.cause?.code === "ETIMEDOUT" ||
          lastErr.includes("ECONNRESET") ||
          lastErr.includes("fetch failed");

        // Only retry on network errors, not on 4xx API errors
        if (!isNetworkReset || attempt === MAX_RETRIES - 1) break;

        const waitMs = RETRY_DELAYS_MS[attempt];
        console.warn(
          `[voice/tts] ${lastErr} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await delay(waitMs);
      }
    }
    // If one URL keeps failing on network errors, try the next
  }

  throw new Error(lastErr);
}

/**
 * Same as synthesizeSarvam but returns the raw base64 audio string.
 * Used by the streaming WS TTS chunker — avoids double encode/decode.
 * @param {string} text
 * @returns {Promise<string>} base64-encoded MP3 audio
 */
export async function synthesizeSarvamBase64(text, targetLanguageCode, signal) {
  const startTts = Date.now();
  console.log(`[voice/tts] synthesizeSarvamBase64 called, ${text.length} chars`);

  const key = config.voice.sarvamApiKey;
  if (!key) {
    throw Object.assign(new Error("SARVAM_API_KEY not set"), { code: "NO_SARVAM" });
  }

  const detected = detectLanguage(text);
  const langMap = {
    gu: "gu-IN",
    hi: "hi-IN",
    en: "en-IN"
  };
  const resolvedLang = targetLanguageCode || langMap[detected] || config.voice.sarvamTtsLang;

  const body = JSON.stringify({
    text: text.slice(0, 2500),
    target_language_code: resolvedLang,
    model:                 config.voice.sarvamTtsModel,
    speaker:               config.voice.sarvamTtsSpeaker,
    output_audio_codec:    "mp3",
  });

  const MAX_RETRIES       = 2;             // fewer retries for streaming latency
  const RETRY_DELAYS_MS   = [300, 1000];
  let   lastErr           = "Sarvam TTS failed";

  for (const url of SARVAM_TTS_URLS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const b64 = await attemptTtsBase64(url, body, key, signal);
        const dur = Date.now() - startTts;
        console.log(`[voice/tts] synthesizeSarvamBase64 done in ${dur}ms`);
        return b64;
      } catch (err) {
        lastErr = String(err?.message ?? err);
        const isNetwork =
          err?.cause?.code === "ECONNRESET"   ||
          err?.cause?.code === "ECONNREFUSED" ||
          err?.cause?.code === "ETIMEDOUT"    ||
          lastErr.includes("ECONNRESET")      ||
          lastErr.includes("fetch failed");
        if (!isNetwork || attempt === MAX_RETRIES - 1) break;
        await delay(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  throw new Error(lastErr);
}
