import { z } from 'zod';
import { defineTool } from './tool.js';

class Parser {
  private position = 0;
  constructor(private readonly source: string) {}
  parse(): number { const value = this.expression(); this.space(); if (this.position !== this.source.length) throw new Error(`Unexpected token at position ${this.position}`); if (!Number.isFinite(value)) throw new Error('Expression produced a non-finite result'); return value; }
  private expression(): number { let value = this.term(); while (true) { this.space(); if (this.take('+')) value += this.term(); else if (this.take('-')) value -= this.term(); else return value; } }
  private term(): number { let value = this.power(); while (true) { this.space(); if (this.take('*')) value *= this.power(); else if (this.take('/')) { const divisor = this.power(); if (divisor === 0) throw new Error('Division by zero'); value /= divisor; } else if (this.take('%')) value %= this.power(); else return value; } }
  private power(): number { const base = this.unary(); this.space(); return this.take('^') ? base ** this.power() : base; }
  private unary(): number { this.space(); if (this.take('+')) return this.unary(); if (this.take('-')) return -this.unary(); return this.primary(); }
  private primary(): number { this.space(); if (this.take('(')) { const value = this.expression(); this.space(); if (!this.take(')')) throw new Error('Missing closing parenthesis'); return value; } const match = this.source.slice(this.position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i); if (!match) throw new Error(`Expected number at position ${this.position}`); this.position += match[0].length; return Number(match[0]); }
  private take(value: string): boolean { if (this.source.startsWith(value, this.position)) { this.position += value.length; return true; } return false; }
  private space() { while (/\s/.test(this.source[this.position] ?? '')) this.position += 1; }
}

export const calculatorTool = defineTool({
  name: 'calculator', description: 'Evaluate arithmetic using +, -, *, /, %, ^, and parentheses.',
  input: z.object({ expression: z.string().min(1).max(1000) }),
  output: z.object({ expression: z.string(), value: z.number() }),
  execute: ({ expression }) => ({ expression, value: new Parser(expression).parse() }),
});
