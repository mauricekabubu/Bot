export class RateLimiter {
  constructor(limit, windowMs = 60_000) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key, now = Date.now()) { const active = (this.hits.get(key) || []).filter((time) => now - time < this.windowMs); if (active.length >= this.limit) { this.hits.set(key, active); return false; } active.push(now); this.hits.set(key, active); return true; }
}
