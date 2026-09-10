// the wrapAgent run loop: the multi-turn conversation between the sdk and a
// model provider, gated at every boundary.
//
// invariants this module enforces:
//   - a tool name only ever executes if it is in BOTH config.tools and the
//     tools implementations map (UNREGISTERED_TOOL otherwise, never executed)
//   - model-supplied arguments are validated against the tool's inputSchema
//     before the real implementation runs (TOOL_ARGUMENT_INVALID otherwise)
//   - a throwing tool implementation is captured as a failed tool result and
//     fed back to the model, it never crashes the run
//   - the loop never converges on a tool call, only on a text response
//   - MAX_TURNS caps the loop (TURN_LIMIT_EXCEEDED), an AbortController
//     enforces the whole-run wall-clock budget (RUN_TIMED_OUT)
//   - the api key never appears in captured toolsUsed, error messages, or
//     logs, and is not even passed into this module's tool executions

import type {
  AgentConfig,
  CapturedToolCall,
  ProviderMessage,
  ProviderResponse,
  ProviderClient,
  ToolImplementations,
} from "./types/providers.js";
import type { Result } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import { validateAgainstSchema } from "./providers/validate.js";
import { isAbortError, ProviderApiError } from "./providers/errors.js";

export const MAX_TURNS = 10;
export const MAX_RUN_MS = 120_000;

export interface RunLoopOptions {
  // how long the whole run may take before the AbortController fires.
  // defaults to MAX_RUN_MS; tests pass a short value to exercise the
  // timeout path without waiting two minutes.
  maxRunMs?: number;
  maxTurns?: number;
  // live progress hook invoked right after each tool executes, carrying the
  // captured tool call (the exact object that later reaches attest()). a tui
  // uses this to paint tool calls as they run; when absent the loop's
  // behavior is byte-identical to before (no extra awaits, no extra calls).
  onToolCall?: (toolCall: CapturedToolCall) => void;
}

export interface RunLoopResult {
  output: string;
  toolsUsed: CapturedToolCall[];
  turns: number;
}

/**
 * runs the multi-turn model loop until the model returns a final text
 * response. every terminal state except a converged text response is a typed
 * failure; a run that did not converge never reaches attest().
 */
export async function runAgentLoop(
  client: ProviderClient,
  config: AgentConfig,
  tools: ToolImplementations,
  task: string,
  options: RunLoopOptions = {},
): Promise<Result<RunLoopResult>> {
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  const maxRunMs = options.maxRunMs ?? MAX_RUN_MS;
  // the conversation accumulates across turns. tool results are appended as
  // labeled user messages; the tool call itself as an assistant message.
  const messages: ProviderMessage[] = [{ role: "user", content: task }];

  // all tools offered to the model must have an executable implementation;
  // the whitelist for execution is built from config.tools only.
  const toolsByName = new Map<string, { description: string; inputSchema: unknown }>();
  for (const tool of config.tools) {
    if (!(tool.name in tools)) {
      return failure("INVALID_INPUT", `tool "${tool.name}" has no implementation registered`);
    }
    toolsByName.set(tool.name, tool);
  }

  const toolsUsed: CapturedToolCall[] = [];
  const abortController = new AbortController();
  const overallTimeout = setTimeout(() => abortController.abort(), maxRunMs);
  // the timer must not keep the process alive after the loop finishes; the
  // unref pattern is not needed because clearTimeout always runs below.
  let turns = 0;

  try {
    while (turns < maxTurns) {
      if (abortController.signal.aborted) {
        return failure("RUN_TIMED_OUT", `run exceeded ${maxRunMs}ms wall-clock budget`);
      }

      let response: ProviderResponse;
      try {
        // the per-call signal is the same overall controller, so a wall-clock
        // timeout aborts whichever provider request is in flight.
        response = await client.complete(messages, abortController.signal, config);
      } catch (error) {
        if (isAbortError(error) || abortController.signal.aborted) {
          return failure("RUN_TIMED_OUT", `run exceeded ${maxRunMs}ms wall-clock budget`);
        }
        if (error instanceof ProviderApiError) {
          return failure("PROVIDER_API_FAILURE", error.message, {
            status: error.status,
            retryAfterSeconds: error.retryAfterSeconds,
          });
        }
        // an unexpected non-provider exception from the adapter is still a
        // provider-side failure from the loop's perspective; fail closed and
        // never let it escape as an untyped throw.
        return failure("PROVIDER_API_FAILURE", "provider call failed unexpectedly");
      }

      turns += 1;

      if (response.kind === "text") {
        // converged. the run is complete with a final output.
        return ok({ output: response.text, toolsUsed, turns });
      }

      // tool_call branch: the model named a tool it wants executed.
      const toolDef = toolsByName.get(response.name);
      if (!toolDef) {
        // protocol violation: a tool that was never offered. hard error,
        // never executed. the whitelist is exact-key, so a hallucinated or
        // injection-prompted name cannot reach an implementation.
        return failure(
          "UNREGISTERED_TOOL",
          `model requested unregistered tool "${response.name}"`,
        );
      }

      const validated = validateAgainstSchema(response.arguments, toolDef.inputSchema);
      if (!validated.valid) {
        return failure(
          "TOOL_ARGUMENT_INVALID",
          `tool "${response.name}" arguments rejected: ${validated.reason}`,
        );
      }

      // execute the real implementation with the validated arguments only
      // (validation passed above, so response.arguments is safe to hand over).
      // a thrown error is captured as a structured failed tool result and fed
      // back to the model, so the model can recover; it is never a crash and
      // never an untyped escape.
      let output: unknown;
      try {
        output = await tools[response.name](response.arguments);
      } catch (error) {
        output = {
          error: "tool execution failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const captured: CapturedToolCall = {
        tool: response.name,
        input: response.arguments,
        output,
      };
      toolsUsed.push(captured);

      // live progress hook: a tui or other interactive surface can paint
      // tool calls as they happen. when absent (the default), no call is
      // made and the loop's timing is unchanged.
      options.onToolCall?.(captured);

      // feed the tool result back. the assistant turn records what was
      // requested, the user turn carries the result in a labeled form so the
      // model sees the outcome. the structured toolCall fields carry the raw
      // functionCall id/thoughtSignature through, so providers that require
      // those to be echoed (gemini 3) get a valid multi-turn history;
      // providers without that requirement ignore the extra fields.
      messages.push({
        role: "assistant",
        content: `call ${response.name}`,
        toolCall: {
          name: response.name,
          arguments: response.arguments,
          ...(response.id !== undefined && { id: response.id }),
          ...(response.thoughtSignature !== undefined && { thoughtSignature: response.thoughtSignature }),
        },
      });
      messages.push({
        role: "user",
        content: serializeToolOutput(output),
        name: response.name,
        ...(response.id !== undefined && { toolCallId: response.id }),
        ...(response.thoughtSignature !== undefined && { thoughtSignature: response.thoughtSignature }),
      });
    }

    return failure(
      "TURN_LIMIT_EXCEEDED",
      `run did not converge within ${maxTurns} turns`,
    );
  } finally {
    clearTimeout(overallTimeout);
  }
}

// a safe, bounded representation of a tool output for feeding back to the
// model. never includes the api key (the key never enters this module) and
// caps the serialized length so a tool that returns a huge object does not
// balloon the conversation into attest()'s size limits. the 4000 bound
// mirrors attest()'s per-entry serialized limit.
const MAX_TOOL_RESULT_PREVIEW_LENGTH = 4000;

function serializeToolOutput(output: unknown): string {
  try {
    const serialized = JSON.stringify(output);
    if (serialized === undefined) return String(output);
    return serialized.length > MAX_TOOL_RESULT_PREVIEW_LENGTH
      ? `${serialized.slice(0, MAX_TOOL_RESULT_PREVIEW_LENGTH)}... (truncated)`
      : serialized;
  } catch {
    return String(output);
  }
}