const sensitive = new Set(['delete_memory', 'delete_reminder', 'send_message', 'external_transaction']);
export function permissionFor(tool, confirmed = false) { return !sensitive.has(tool) || confirmed ? { allowed: true } : { allowed: false, reason: 'This action needs your explicit confirmation. Reply CONFIRM to continue.' }; }
export class PendingConfirmationStore {
  constructor(ttlMs = 5 * 60_000, now = () => Date.now()) { this.ttlMs = ttlMs; this.now = now; this.pending = new Map(); }
  pruneExpired() { const now = this.now(); for (const [userId, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(userId); }
  request(userId, action) { if (typeof userId !== 'string' || !userId || typeof action !== 'string' || !action) throw new Error('Invalid confirmation request.'); this.pruneExpired(); const entry = { action, expiresAt: this.now() + this.ttlMs }; this.pending.set(userId, entry); return entry; }
  confirm(userId, action) { this.pruneExpired(); const entry = this.pending.get(userId); this.pending.delete(userId); return Boolean(entry && entry.action === action && entry.expiresAt > this.now()); }
  cancel(userId) { this.pruneExpired(); return this.pending.delete(userId); }
}
