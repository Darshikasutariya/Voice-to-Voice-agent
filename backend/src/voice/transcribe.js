import { transcribeDeepgram } from "./deepgramTranscribe.js";

/**
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {Promise<string>}
 */
export async function transcribeAudio(buffer, mimetype) {
  return transcribeDeepgram(buffer, mimetype);
}
