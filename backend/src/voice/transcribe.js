import { config } from "../config.js";
import { transcribeDeepgram } from "./deepgramTranscribe.js";
import { transcribeSarvam } from "./sarvamTranscribe.js";

/**
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {Promise<string>}
 */
export async function transcribeAudio(buffer, mimetype) {
  const provider = config.voice.sttProvider;

  if (provider === "sarvam") {
    return transcribeSarvam(buffer, mimetype);
  }

  if (provider === "deepgram") {
    return transcribeDeepgram(buffer, mimetype);
  }

  throw new Error(`Unknown VOICE_STT_PROVIDER: ${provider}`);
}
