/**
 * The model adapter.
 *
 * Narrow on purpose. Discovery needs one thing from a provider - "here is the screen,
 * which tool do you call next" - so that is the whole interface. It also means the
 * agent loop is testable against a scripted fake with no network and no key.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmTurn {
  /** Summarised reasoning, when the provider returns it. Recorded as evidence. */
  thinking?: string;
  text?: string;
  toolCalls: LlmToolCall[];
  stopReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: Anthropic.ContentBlockParam[];
}

export interface LlmClient {
  readonly model: string;
  complete(system: string, messages: LlmMessage[], tools: Anthropic.Tool[]): Promise<{ turn: LlmTurn; assistant: Anthropic.ContentBlockParam[] }>;
}

export const DEFAULT_MODEL = "claude-opus-5";

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(readonly model: string = process.env["CUA_MODEL"] ?? DEFAULT_MODEL) {
    // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
    this.client = new Anthropic();
  }

  async complete(system: string, messages: LlmMessage[], tools: Anthropic.Tool[]) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16_000,
      // Adaptive thinking with a summary: the summary is the "why" half of the
      // evidence requirement, and it costs nothing extra to record.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      system,
      tools,
      messages: messages as Anthropic.MessageParam[],
    });

    const toolCalls: LlmToolCall[] = [];
    let text = "";
    let thinking = "";
    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      } else if (block.type === "text") {
        text += block.text;
      } else if (block.type === "thinking") {
        thinking += block.thinking;
      }
    }

    return {
      turn: {
        thinking: thinking || undefined,
        text: text || undefined,
        toolCalls,
        stopReason: response.stop_reason ?? undefined,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      },
      // Echoed back verbatim on the next turn, thinking blocks included.
      assistant: response.content as unknown as Anthropic.ContentBlockParam[],
    };
  }
}

/** A scripted stand-in, so the agent loop can be tested without a model or a key. */
export class ScriptedClient implements LlmClient {
  readonly model = "scripted";
  private index = 0;

  constructor(private readonly script: LlmToolCall[][]) {}

  async complete(): Promise<{ turn: LlmTurn; assistant: Anthropic.ContentBlockParam[] }> {
    const toolCalls = this.script[this.index++] ?? [];
    return {
      turn: { toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn" },
      assistant: toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
    };
  }
}
