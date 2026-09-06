// a minimal internal structural validator for tool-call arguments.
//
// ToolDefinition.inputSchema is typed `unknown` and, for an agent tool, is a
// small json-schema subset. the sdk deliberately carries no json-schema
// library dependency, so wrapAgent uses this validator to gate model-supplied
// arguments before they ever reach a real tool implementation. it supports
// exactly the subset that matters for gating untrusted input:
//
//   - type: "object" | "string" | "number" | "boolean" | "array"
//   - properties: { [name]: schema }           (for type "object")
//   - required: string[]                       (for type "object")
//   - additionalProperties: false              (for type "object")
//   - items: schema                            (for type "array")
//   - minLength / maxLength                    (for type "string")
//
// unsupported schema keys are ignored, which is a deliberate trade: the gate
// is structural, not a full json-schema evaluator. callers that need strict
// schema enforcement beyond this subset can validate again inside their tool
// implementation; the boundary here exists to stop model-generated input
// from reaching an implementation in an unchecked shape.

export type ValidationResult = { valid: true } | { valid: false; reason: string };

export function validateAgainstSchema(args: unknown, schema: unknown): ValidationResult {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    // no usable schema means no gate: accept structurally, the boundary
    // still requires the top-level value to be a plain object.
    return typeof args === "object" && args !== null && !Array.isArray(args)
      ? { valid: true }
      : { valid: false, reason: "arguments must be a plain object" };
  }

  const rule = schema as Record<string, unknown>;

  if (rule.type === undefined) {
    // schema without an explicit type: accept only if the value is a plain
    // object, which is the minimum shape for tool arguments.
    return typeof args === "object" && args !== null && !Array.isArray(args)
      ? { valid: true }
      : { valid: false, reason: "arguments must be a plain object" };
  }

  switch (rule.type) {
    case "object": {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { valid: false, reason: "expected an object" };
      }
      const record = args as Record<string, unknown>;
      const required = Array.isArray(rule.required) ? (rule.required as unknown[]) : [];
      for (const key of required) {
        if (typeof key !== "string") continue; // ignore malformed required entries
        if (!(key in record)) {
          return { valid: false, reason: `missing required property ${key}` };
        }
      }
      const properties =
        rule.properties !== null && typeof rule.properties === "object" && !Array.isArray(rule.properties)
          ? (rule.properties as Record<string, unknown>)
          : {};
      for (const [key, value] of Object.entries(record)) {
        const propSchema = properties[key];
        if (propSchema === undefined) {
          if (rule.additionalProperties === false) {
            return { valid: false, reason: `unexpected property ${key}` };
          }
          continue;
        }
        const nested = validateAgainstSchema(value, propSchema);
        if (!nested.valid) return { valid: false, reason: `property ${key}: ${nested.reason}` };
      }
      return { valid: true };
    }
    case "array": {
      if (!Array.isArray(args)) return { valid: false, reason: "expected an array" };
      const itemsSchema = rule.items;
      for (const item of args) {
        const nested = validateAgainstSchema(item, itemsSchema);
        if (!nested.valid) return { valid: false, reason: `array item: ${nested.reason}` };
      }
      return { valid: true };
    }
    case "string": {
      if (typeof args !== "string") return { valid: false, reason: "expected a string" };
      if (typeof rule.minLength === "number" && args.length < rule.minLength) {
        return { valid: false, reason: `string shorter than minLength ${rule.minLength}` };
      }
      if (typeof rule.maxLength === "number" && args.length > rule.maxLength) {
        return { valid: false, reason: `string longer than maxLength ${rule.maxLength}` };
      }
      return { valid: true };
    }
    case "number": {
      if (typeof args !== "number" || Number.isNaN(args)) {
        return { valid: false, reason: "expected a number" };
      }
      return { valid: true };
    }
    case "boolean": {
      if (typeof args !== "boolean") return { valid: false, reason: "expected a boolean" };
      return { valid: true };
    }
    default:
      return { valid: false, reason: `unsupported schema type ${String(rule.type)}` };
  }
}