import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { GraphStateType } from "../state.js";
import { billableTokens } from "../tokens.js";
import { withUsage } from "../usage.js";

const SYSTEM_PROMPT = `You are the Router. Decide how the team should tackle a task:
- "single": one focused deliverable that a single writer + reviewer can nail
  (a short text, an email, one answer, a small fix).
- "team": a multi-part or long deliverable that benefits from decomposition
  (a full plan, a long document, several sections, "cover X, Y and Z").
Pick the lightest topology that fits. Return the topology and a one-sentence
reason.`;

const RouteSchema = z.object({
  topology: z.enum(["single", "team"]),
  reason: z.string().describe("One short sentence explaining the choice."),
});

export function makeRouterNode(model: BaseChatModel) {
  const structured = model.withStructuredOutput(RouteSchema, {
    name: "route",
    includeRaw: true,
  });

  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    // Operator override: use the forced topology verbatim, no model call, no tokens.
    if (state.forcedTopology) {
      return {
        topology: state.forcedTopology,
        status: "running",
        messages: [
          {
            agent: "system",
            role: "system",
            content: `Router → ${state.forcedTopology}: manually overridden.`,
          },
        ],
      };
    }

    const { raw, parsed } = await structured.invoke(
      [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(`Task:\n${state.task}`)],
      withUsage("router"),
    );
    const route = RouteSchema.parse(parsed);
    const tokens = billableTokens((raw as AIMessage).usage_metadata);

    return {
      topology: route.topology,
      status: "running",
      tokensUsed: state.tokensUsed + tokens,
      messages: [
        {
          agent: "system",
          role: "system",
          content: `Router → ${route.topology}: ${route.reason}`,
        },
      ],
    };
  };
}
