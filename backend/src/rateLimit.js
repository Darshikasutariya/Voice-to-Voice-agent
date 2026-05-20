/** Sliding window rate limit: max `max` events per `windowMs` per key. */
export function createWindowLimiter(windowMs, max) {
  /** @type {Map<string, number[]>} */
  const buckets = new Map();

  /**
   * @param {string} key
   * @returns {boolean} true if allowed, false if over limit
   */
  return function allow(key) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let hits = buckets.get(key) ?? [];
    hits = hits.filter((t) => t > cutoff);
    if (hits.length >= max) {
      buckets.set(key, hits);
      return false;
    }
    hits.push(now);
    buckets.set(key, hits);
    return true;
  };
}
