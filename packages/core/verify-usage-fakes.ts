/**
 * Shared fakes for the verify-usage-*.ts scripts — not a verify script itself.
 * Every fake goes through LangChain's real BaseChatModel call path, so callback
 * handlers fire exactly as they do for a real provider.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  assembleStructuredOutputPipeline,
  createFunctionCallingParser,
} from "@langchain/core/language_models/structured_output";
import type { Serialized } from "@langchain/core/load/serializable";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

export const FAKE_USAGE = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

/** Records the metadata LangChain hands every chat-model call. */
export class MetadataCollector extends BaseCallbackHandler {
  name = "metadata_collector";
  readonly calls: Record<string, unknown>[] = [];

  constructor() {
    super({ _awaitHandler: true });
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    _runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.calls.push({ ...(metadata ?? {}) });
  }

  /** The role of every call seen, in call order. */
  roles(): unknown[] {
    return this.calls.map((call) => call.ae_role);
  }
}

/** A tool-capable chat model that answers in plain text and never calls a tool. */
export class TextModel extends BaseChatModel {
  _llmType(): string {
    return "fake-text";
  }

  override bindTools() {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ content: "done", usage_metadata: FAKE_USAGE });
    return { generations: [{ text: "done", message }] };
  }
}

/**
 * A chat model whose structured-output calls go through LangChain's real
 * function-calling pipeline and always answer `args` under the requested tool
 * name. Its tool-calling side (a ReAct loop, e.g. a survey) is a TextModel.
 */
export function structuredModel(args: Record<string, unknown>): BaseChatModel {
  let toolName = "tool";
  class Scripted extends BaseChatModel {
    _llmType(): string {
      return "fake-structured";
    }

    override bindTools() {
      return new TextModel({});
    }

    async _generate(): Promise<ChatResult> {
      const message = new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: toolName, args }],
        usage_metadata: FAKE_USAGE,
      });
      return { generations: [{ text: "", message }] };
    }
  }
  const model = new Scripted({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (model as any).withStructuredOutput = (schema: any, config?: { name?: string; includeRaw?: boolean }) => {
    toolName = config?.name ?? toolName;
    return assembleStructuredOutputPipeline(
      model,
      createFunctionCallingParser(schema, toolName),
      config?.includeRaw,
    );
  };
  return model;
}
