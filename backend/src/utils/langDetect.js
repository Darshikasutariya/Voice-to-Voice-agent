/**
 * Detects the language of a text based on character ranges.
 * Returns "gu" (Gujarati), "hi" (Hindi/Devanagari), or "en" (English/Latin).
 * @param {string} text
 * @returns {"gu" | "hi" | "en"}
 */
export function detectLanguage(text) {
  let guCount = 0;
  let hiCount = 0;
  let enCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Gujarati range: 0x0A80 to 0x0AFF
    if (code >= 0x0A80 && code <= 0x0AFF) {
      guCount++;
    } 
    // Devanagari (Hindi) range: 0x0900 to 0x097F
    else if (code >= 0x0900 && code <= 0x097F) {
      hiCount++;
    } 
    // English/Latin letters
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      enCount++;
    }
  }

  if (guCount > 0 && guCount >= hiCount) {
    return "gu";
  }
  if (hiCount > 0) {
    return "hi";
  }
  return "en";
}
