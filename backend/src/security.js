import crypto from "node:crypto";

/**
 * Constant-time string compare (same length only).
 * @param {string} a
 * @param {string} b
 */
export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** @param {import("express").Request} req */
export function extractHttpApiKey(req) {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

/**
 * @param {string} provided
 * @param {string} expected empty = auth disabled
 */
export function isChatApiKeyValid(provided, expected) {
  if (!expected) return true;
  if (!provided) return false;
  return timingSafeEqualStr(provided, expected);
}
