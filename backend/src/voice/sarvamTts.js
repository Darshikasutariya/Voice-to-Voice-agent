import { config } from "../config.js";

const SARVAM_TTS_URLS = [
  "https://api.sarvam.ai/v1/text-to-speech",
  "https://api.sarvam.ai/text-to-speech",
];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Attempt a single TTS fetch against one URL.
 * Returns { buffer, contentType } on success, throws on failure.
 */
async function attemptTts(url, body, key) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body,
  });

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

  return { buffer: Buffer.from(b64, "base64"), contentType: "audio/wav" };
}

/**
 * @param {string} text
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function synthesizeSarvam(text) {
  const key = config.voice.sarvamApiKey;
  if (!key) {
    throw Object.assign(new Error("SARVAM_API_KEY not set"), {
      code: "NO_SARVAM",
    });
  }

  const body = JSON.stringify({
    text: text.slice(0, 2500),
    target_language_code: config.voice.sarvamTtsLang,
    model: config.voice.sarvamTtsModel,
    speaker: config.voice.sarvamTtsSpeaker,
  });

  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [500, 1500, 3000]; // backoff between retries

  let lastErr = "Sarvam TTS failed";

  for (const url of SARVAM_TTS_URLS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await attemptTts(url, body, key);
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
