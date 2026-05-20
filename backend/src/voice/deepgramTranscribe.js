import { config } from "../config.js";

/**
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {Promise<string>}
 */
export async function transcribeDeepgram(buffer, mimetype) {
  const key = config.voice.deepgramApiKey;
  if (!key) {
    throw Object.assign(new Error("DEEPGRAM_API_KEY not set"), {
      code: "NO_DEEPGRAM",
    });
  }

  const params = new URLSearchParams({
    model: config.voice.deepgramModel,
    smart_format: "true",
  });
  if (config.voice.deepgramLanguage) {
    params.set("language", config.voice.deepgramLanguage);
  }

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": mimetype || "application/octet-stream",
    },
    body: buffer,
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Deepgram HTTP ${res.status}: ${rawText.slice(0, 500)}`);
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error("Deepgram: invalid JSON");
  }

  const text =
    json?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ??
    "";
  return text;
}
