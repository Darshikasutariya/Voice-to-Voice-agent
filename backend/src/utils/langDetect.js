/**
 * Language detection and script analysis for the voice pipeline.
 * Three canonical codes: "en" (English), "hi" (Hindi), "gu" (Gujarati).
 */

// Unicode script ranges
const DEVANAGARI_START = 0x0900;
const DEVANAGARI_END   = 0x097F;
const GUJARATI_START   = 0x0A80;
const GUJARATI_END     = 0x0AFF;

/**
 * Count letter-class chars by script.
 * @returns {{ latin: number, devanagari: number, gujarati: number }}
 */
function countScripts(text) {
  let latin = 0, devanagari = 0, gujarati = 0;
  if (!text) return { latin, devanagari, gujarati };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin++;
    else if (code >= DEVANAGARI_START && code <= DEVANAGARI_END) devanagari++;
    else if (code >= GUJARATI_START && code <= GUJARATI_END) gujarati++;
  }
  return { latin, devanagari, gujarati };
}

/**
 * Detect language from text character ranges.
 * Behavior identical to the original implementation.
 * @param {string} text
 * @returns {"en" | "hi" | "gu"}
 */
export function detectLanguage(text) {
  const { latin, devanagari, gujarati } = countScripts(text);
  if (gujarati > 0 && gujarati >= devanagari) return "gu";
  if (devanagari > 0) return "hi";
  return "en";
}

/**
 * Returns true if 70%+ of letter-chars are Latin (likely English speech).
 * Used by winner-selection to penalize Hindi/Gujarati sockets that
 * phonetically transcribed English speech.
 */
export function isLatinScriptDominant(text) {
  const { latin, devanagari, gujarati } = countScripts(text);
  const total = latin + devanagari + gujarati;
  if (total === 0) return false;
  return latin / total >= 0.7;
}

/** Returns true if 50%+ of letter-chars are Devanagari (actual Hindi). */
export function isDevanagariDominant(text) {
  const { latin, devanagari } = countScripts(text);
  const total = latin + devanagari;
  if (total === 0) return false;
  return devanagari / total >= 0.5;
}

/** Returns true if 50%+ of letter-chars are Gujarati script. */
export function isGujaratiDominant(text) {
  const { latin, gujarati } = countScripts(text);
  const total = latin + gujarati;
  if (total === 0) return false;
  return gujarati / total >= 0.5;
}