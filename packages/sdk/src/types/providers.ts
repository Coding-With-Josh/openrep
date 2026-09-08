import type { Attestation } from "./attestation";
import type { AgentId } from "./identity";

// which model provider an agent runs on. the only place wrapAgent() ever
// branches on provider is selecting an adapter from this.
export type ModelProvider = "anthropic" | "openai" | "gemini" | "openai-compatible";

// one tool an agent can call. provider agnostic, mapped to each provider's
// actual format inside the adapter, that mapping logic is not typed here.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown; // what the provider sees; a small structural schema below
}

// configuration for one agent's model behavior. api keys do not live on
// this type, they are passed to wrapAgent separately and never travel with
// the config into the captured attestation data.
export interface AgentConfig {
  provider: ModelProvider;
  model: string; // provider specific model id
  // required and validated only for provider === "openai-compatible": the
  // base url of a chat-completions-compatible endpoint. ignored everywhere
  // else. never a guessed default: callers must name their endpoint.
  baseUrl?: string;
  tools: ToolDefinition[];
  // optional system-level instruction prepended to every provider call.
  // the sdk never mutates conversation history with it: each adapter
  // translates it into the provider-native wire format at call time
  // (openai: role:system message; anthropic: top-level system field;
  // gemini: systemInstruction content block).
  system?: string;
}

// the raw functionCall fields a provider may attach to a tool call. carried
// through the loop unchanged so a multi-turn history stays valid on
// providers that require the original call id and/or a signature (gemini 3's
// thoughtSignature) to be echoed back with the tool result. providers that
// do not use these fields simply leave them unset.
export interface ProviderToolCallFields {
  name: string;
  arguments: unknown;
  id?: string;
  thoughtSignature?: string;
}

// a single message in the normalized conversation the loop feeds the
// adapter. role is a closed union, the payload is provider agnostic.
// the optional structured fields on assistant messages and tool results
// are additive: providers that do not model them (anthropic, openai)
// ignore them and keep producing their historical wire format.
export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCall?: ProviderToolCallFields }
  | { role: "user"; content: string; name: string; toolCallId?: string; thoughtSignature?: string }; // a fed-back tool result

// the normalized outcome the ProviderClient hands back to the run loop,
// independent of which provider is behind it. the loop never sees a raw
// provider payload, so no provider-specific parsing exists outside adapters.
// tool_call may carry id/thoughtSignature passthrough so the loop can echo
// them back on multi-turn histories that require it.
export type ProviderResponse =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; arguments: unknown; id?: string; thoughtSignature?: string };

// the adapter-facing contract. one concrete implementation per provider.
// each adapter is responsible ONLY for translating ToolDefinition[] into
// its provider's real tool format, making the api request over global
// fetch, and translating the raw response back into ProviderResponse. all
// provider-specific parsing lives inside the adapter, nowhere else.
export interface ProviderClient {
  readonly provider: ModelProvider;
  // config carries the model id and the tool definitions the adapter
  // translates for this call; messages is the accumulated conversation;
  // signal is the run's AbortController signal so a wall-clock timeout
  // aborts an in-flight provider request.
  complete(
    messages: ProviderMessage[],
    signal: AbortSignal,
    config: AgentConfig,
  ): Promise<ProviderResponse>;
}

// an executable tool implementation, keyed by name. wrapAgent() validates
// the model's arguments against the tool's schema before calling this, and
// captures any thrown error as a failed tool result rather than crashing.
export interface ToolImplementation {
  (args: unknown): Promise<unknown>;
}

// the map of real executable tool implementations, keyed by exact tool
// name. only names present here AND in config.tools are ever executed.
export interface ToolImplementations {
  [name: string]: ToolImplementation;
}

// explicit parameters for wrapAgent. all configuration, secrets, and
// dependencies are passed in by the caller; wrapAgent never reads
// environment variables or calls loadEnvConfig() itself.
export interface WrapAgentParams {
  agentId: AgentId; // canonical id of the acting agent
  signingKey: string; // identity private key used by attest()
  storage: import("./storage").StorageAdapter;
  config: AgentConfig; // provider, model, tool definitions
  tools: ToolImplementations; // executable implementations keyed by name
  apiKey: string; // the provider api key, held only as a local param
  task: string; // the input the agent is being asked to do
  options?: WrapAgentRunOptions;
}

// options that flow through to attest() plus run behavior knobs.
export interface WrapAgentRunOptions {
  source?: string; // defaults to "native", matches attest()
  idempotencyKey?: string; // lets retries collapse into one attestation
}

// the normalized shape attest() expects for captured tool calls, carried
// across the loop and handed to attest() by composition.
export type CapturedToolCall = Attestation["toolsUsed"][number];
