import { composeCampOpenRouterRequestWithBreakdown, type ComposedInputBreakdown } from './campRequest';
import {
  runToolUseLoop,
  streamOpenRouterChatCompletion,
  type OpenRouterChatMessage,
  type OpenRouterChatRequestPayload,
  type OpenRouterTelemetryHooks,
  type OpenRouterToolLoopExecutionInput,
  type OpenRouterToolSpec,
} from './openrouter';
import type { Camp, CampAppendMessagePayload, CampArtifact, CampToolCall, TokenUsage } from './types';

export type CampRuntimeTranscriptPayload = Omit<CampAppendMessagePayload, 'camp_id' | 'included_artifact_ids'>;

export type RunCampChatRuntimeInput = {
  campId: string;
  camp: Camp;
  selectedArtifacts: CampArtifact[];
  apiKey: string;
  temperature: number;
  maxTokens: number;
  onToken: (token: string) => void;
  tools?: OpenRouterToolSpec[];
  executeToolCall?: (input: OpenRouterToolLoopExecutionInput) => Promise<string>;
  correlationId?: string;
  telemetry?: OpenRouterTelemetryHooks;
  onComposeStart?: () => void;
  onComposeEnd?: (event: {
    requestPayload: OpenRouterChatRequestPayload;
    breakdown: ComposedInputBreakdown;
  }) => void;
};

export type RunCampChatRuntimeResult = {
  outputText: string;
  requestPayload: OpenRouterChatRequestPayload;
  requestPayloads: OpenRouterChatRequestPayload[];
  transcriptMessages: CampRuntimeTranscriptPayload[];
  usingTools: boolean;
  usage?: TokenUsage;
  resolvedModel: string | null;
  composedInputBreakdown: ComposedInputBreakdown;
};

function messageContentToString(content: OpenRouterChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object') {
        const maybeText = (part as { text?: unknown }).text;
        if (typeof maybeText === 'string') {
          return maybeText;
        }
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeAssistantToolCalls(toolCalls: OpenRouterChatMessage['tool_calls']): CampToolCall[] | undefined {
  const normalized =
    toolCalls
      ?.map((toolCall) => {
        if (!toolCall.id) {
          return null;
        }

        return {
          id: toolCall.id,
          type: 'function' as const,
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        };
      })
      .filter((toolCall): toolCall is CampToolCall => Boolean(toolCall)) ?? [];

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeLoopTranscriptMessages(messages: OpenRouterChatMessage[]): CampRuntimeTranscriptPayload[] {
  const normalized: CampRuntimeTranscriptPayload[] = [];

  for (const message of messages) {
    const content = messageContentToString(message.content);

    if (message.role === 'assistant') {
      normalized.push({
        role: 'assistant',
        content,
        tool_calls: normalizeAssistantToolCalls(message.tool_calls),
      });
      continue;
    }

    if (message.role === 'tool') {
      if (!message.tool_call_id || !message.name) {
        continue;
      }

      normalized.push({
        role: 'tool',
        content,
        tool_call_id: message.tool_call_id,
        name: message.name,
      });
    }
  }

  return normalized;
}

function assertNonEmptyOutput(outputText: string): void {
  if (!outputText.trim()) {
    throw new Error('Model returned an empty response.');
  }
}

export async function runCampChatRuntime(input: RunCampChatRuntimeInput): Promise<RunCampChatRuntimeResult> {
  const tools = input.camp.config.tools_enabled ? input.tools : undefined;
  input.onComposeStart?.();
  const composed = composeCampOpenRouterRequestWithBreakdown({
    camp: input.camp,
    selectedArtifacts: input.selectedArtifacts,
    userMessage: '',
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    tools,
  });
  const requestPayload = composed.payload;
  input.onComposeEnd?.({
    requestPayload,
    breakdown: composed.breakdown,
  });

  if (tools && !input.executeToolCall) {
    throw new Error('Tool executor is not configured.');
  }

  if (tools && input.executeToolCall) {
    const looped = await runToolUseLoop(
      input.campId,
      requestPayload.messages,
      tools,
      input.apiKey,
      input.onToken,
      {
        model: requestPayload.model,
        temperature: requestPayload.temperature,
        max_tokens: requestPayload.max_tokens,
        executeToolCall: input.executeToolCall,
        correlationId: input.correlationId,
        telemetry: input.telemetry,
      },
    );

    assertNonEmptyOutput(looped.outputText);

    return {
      outputText: looped.outputText,
      requestPayload: looped.requestPayloads[looped.requestPayloads.length - 1] ?? requestPayload,
      requestPayloads: looped.requestPayloads,
      transcriptMessages: normalizeLoopTranscriptMessages(looped.transcriptMessages),
      usingTools: true,
      usage: looped.usage,
      resolvedModel: looped.resolvedModel,
      composedInputBreakdown: composed.breakdown,
    };
  }

  const streamed = await streamOpenRouterChatCompletion(input.apiKey, requestPayload, input.onToken, {
    correlationId: input.correlationId,
    telemetry: input.telemetry,
  });
  assertNonEmptyOutput(streamed.outputText);

  return {
    outputText: streamed.outputText,
    requestPayload,
    requestPayloads: [requestPayload],
    transcriptMessages: [
      {
        role: 'assistant',
        content: streamed.outputText,
      },
    ],
    usingTools: false,
    usage: streamed.usage,
    resolvedModel: streamed.resolvedModel,
    composedInputBreakdown: composed.breakdown,
  };
}
