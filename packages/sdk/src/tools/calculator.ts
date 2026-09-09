// a safe arithmetic evaluator. no eval(), no code execution: a strict
// tokenizer plus a recursive-descent parser over + - * / ^ and parens, with
// exponentiation binding tighter than unary minus (so -2^2 is -4). division
// by zero and anything the tokenizer does not recognize throw a ToolError
// that the run loop captures and feeds back to the model.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { ToolError } from "./guards.js";

const CALCULATOR_MAX_INPUT = 200;

type Tok =
  | { kind: "num"; value: number }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" };

function tokenize(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (char === " " || char === "\t") {
      i += 1;
      continue;
    }
    if (char >= "0" && char <= "9") {
      let j = i;
      while (j < input.length && ((input[j] >= "0" && input[j] <= "9") || input[j] === ".")) j += 1;
      const raw = input.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ToolError("invalid number");
      }
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (char === "+" || char === "-" || char === "*" || char === "/" || char === "^") {
      tokens.push({ kind: "op", value: char });
      i += 1;
      continue;
    }
    throw new ToolError(`unexpected character "${char}"`);
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Tok[]) {}

  private peek(): Tok | undefined {
    return this.tokens[this.index];
  }

  private isOp(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.kind === "op" && tok.value === value;
  }

  private next(): Tok | undefined {
    const tok = this.tokens[this.index];
    this.index += 1;
    return tok;
  }

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      if (this.isOp("+")) {
        this.next();
        value += this.parseTerm();
      } else if (this.isOp("-")) {
        this.next();
        value -= this.parseTerm();
      } else {
        return value;
      }
    }
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    for (;;) {
      if (this.isOp("*")) {
        this.next();
        value *= this.parseFactor();
      } else if (this.isOp("/")) {
        this.next();
        const divisor = this.parseFactor();
        if (divisor === 0) {
          throw new ToolError("division by zero");
        }
        value /= divisor;
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    const tok = this.peek();
    if (tok !== undefined && tok.kind === "op" && (tok.value === "-" || tok.value === "+")) {
      this.next();
      const value = this.parseFactor();
      return tok.value === "-" ? -value : value;
    }
    return this.parsePower();
  }

  // power binds tighter than unary minus and associates right: 2^3^2 = 2^9.
  private parsePower(): number {
    const base = this.parsePrimary();
    if (this.isOp("^")) {
      this.next();
      const exponent = this.parseFactor();
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parsePrimary(): number {
    const tok = this.next();
    if (tok === undefined) {
      throw new ToolError("unexpected end of expression");
    }
    if (tok.kind === "num") return tok.value;
    if (tok.kind === "lparen") {
      const value = this.parseExpression();
      const closing = this.next();
      if (closing === undefined || closing.kind !== "rparen") {
        throw new ToolError("missing closing parenthesis");
      }
      return value;
    }
    throw new ToolError("unexpected token");
  }
}

export function evaluate(input: string): number {
  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new ToolError("empty expression");
  }
  const parser = new Parser(tokens);
  const value = parser.parseExpression();
  // trailing tokens mean a malformed expression such as "1 2" or "1(".
  if (!parser.atEnd()) {
    throw new ToolError("unexpected trailing input");
  }
  return value;
}

const calculatorDefinition: ToolDefinition = {
  name: "calculator",
  description:
    `evaluate a pure arithmetic expression and return the result. supports + - * / ^ and parentheses, decimal numbers, and unary minus. no variables, no functions, no units. use it instead of doing arithmetic by hand. input is capped at ${CALCULATOR_MAX_INPUT} characters.`,
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", minLength: 1, maxLength: CALCULATOR_MAX_INPUT },
    },
    required: ["expression"],
    additionalProperties: false,
  },
};

const calculatorImplementation: ToolImplementation = async (args: unknown) => {
  const expression = (args as { expression?: unknown }).expression;
  if (typeof expression !== "string") {
    throw new ToolError("expression must be a string");
  }
  const raw = evaluate(expression);
  // round away float noise like 0.30000000000000004 without masking real
  // precision: 12 significant digits is far beyond anything arithmetic on
  // small user inputs needs.
  const result = Number(raw.toPrecision(12));
  if (!Number.isFinite(result)) {
    throw new ToolError("result is not a finite number");
  }
  return { expression, result };
};

export const calculatorTool: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
  { definition: calculatorDefinition, implementation: calculatorImplementation },
];