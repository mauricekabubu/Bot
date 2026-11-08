export class SafeError extends Error { constructor(message, cause) { super(message); this.cause = cause; } }
