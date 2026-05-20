import { config } from "../config.js";

/**
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {Promise<string>}
 */
export async function transcribeSarvam(buffer, mimetype) {
  const key = config.voice.sarvamApiKey;
  if (!key) {
    throw Object.assign(new Error("SARVAM_API_KEY not set"), {
      code: "NO_SARVAM",
    });
  }

  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buffer], { type: mimetype || "application/octet-stream" }),
    "audio.webm",
  );
  fd.append("model", config.voice.sarvamSttModel);
  fd.append("language_code", config.voice.sarvamSttLanguage);

  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: {
      "api-subscription-key": key,
    },
    body: fd,
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Sarvam STT HTTP ${res.status}: ${rawText.slice(0, 500)}`);
  }

  const json = JSON.parse(rawText);
  return String(json?.transcript ?? "").trim();
}
