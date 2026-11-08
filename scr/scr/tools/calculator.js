const MAX_LENGTH = 120;
const MAX_MAGNITUDE = 1e15;

class Parser {
  constructor(source) { this.source = source; this.index = 0; }
  parse() { const value = this.expression(); this.space(); if (this.index !== this.source.length) throw new Error('Invalid calculation expression.'); return this.safe(value); }
  space() { while (/\s/.test(this.source[this.index] || '')) this.index++; }
  take(token) { this.space(); if (this.source.startsWith(token, this.index)) { this.index += token.length; return true; } return false; }
  expression() { let value = this.term(); while (true) { if (this.take('+')) value = this.safe(value + this.term()); else if (this.take('-')) value = this.safe(value - this.term()); else return value; } }
  term() { let value = this.unary(); while (true) { if (this.take('*')) value = this.safe(value * this.unary()); else if (this.take('/')) { const divisor = this.unary(); if (divisor === 0) throw new Error('Division by zero is not allowed.'); value = this.safe(value / divisor); } else return value; } }
  unary() { if (this.take('-')) return this.safe(-this.unary()); if (this.take('+')) return this.unary(); return this.primary(); }
  primary() { if (this.take('(')) { const value = this.expression(); if (!this.take(')')) throw new Error('Unclosed parenthesis.'); return value; } this.space(); const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(this.source.slice(this.index)); if (!match) throw new Error('Expected a number.'); this.index += match[0].length; return this.safe(Number(match[0])); }
  safe(value) { if (!Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE) throw new Error('Calculation result is outside the allowed range.'); return value; }
}
export function calculate(expression) { if (typeof expression !== 'string' || expression.length === 0 || expression.length > MAX_LENGTH) throw new Error('Invalid calculation expression.'); if (!/^[0-9+\-*/().\s]+$/.test(expression)) throw new Error('Only arithmetic operators and numbers are allowed.'); const normalized = expression.trim(); return { expression: normalized, result: new Parser(normalized).parse() }; }
