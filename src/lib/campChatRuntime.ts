import { composeCampOpenRouterRequestWithBreakdown, type ComposedInputBreakdown } from './campRequest';
import { runAppendEvent, runStart } from './db';
import {
  runToolUseLoop,
  streamOpenRouterChatCompletion,
  type OpenRouterChatMessage,
  type OpenRouterChatRequestPayload,
  type OpenRouterTelemetryHooks,
  type OpenRouterToolLoopExecutionInput,
  type OpenRouterToolSpec,
} from './openrouter';
import type {
  ApprovalPolicy,
  Camp,
  CampAppendMessagePayload,
  CampArtifact,
  CampToolCall,
  RunEventKind,
  RunStateEvent,
  TokenUsage,
} from './types';

export type CampRuntimeTranscriptPayload = Omit<CampAppendMessagePayload, 'camp_id' | 'included_artifact_ids'>;

export type RunCampChatRuntimeInput = {
  campId: string;
  camp: Camp;
  selectedArtifacts: CampArtifact[];
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
  /** Configurable max iterations (default 10, max 50). Pulled from camp settings. */
  maxIterations?: number;
  /** Approval policy from settings. Controls whether tool calls require manual approval. */
  approvalPolicy?: ApprovalPolicy;
  /** Per-tool timeout in seconds (default 30). */
  toolTimeoutSecs?: number;
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
  runId?: string;
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

function makeRunStateEvent(
  runId: string,
  event: RunEventKind,
  fields?: Partial<Omit<RunStateEvent, 'run_id' | 'event' | 'timestamp_ms'>>,
): RunStateEvent {
  return {
    run_id: runId,
    event,
    timestamp_ms: Date.now(),
    ...fields,
  };
}

async function emitRunEvent(campId: string, event: RunStateEvent): Promise<void> {
  try {
    await runAppendEvent(campId, event);
  } catch {
    // Run state logging is best-effort; don't break the runtime.
  }
}

export async function runCampChatRuntime(input: RunCampChatRuntimeInput): Promise<RunCampChatRuntimeResult> {
  const tools = input.camp.config.tools_enabled ? input.tools : undefined;
  const maxIterations = Math.min(Math.max(input.maxIterations ?? 10, 1), 50);
  const approvalPolicy = input.approvalPolicy ?? 'manual';
  const toolTimeoutSecs = input.toolTimeoutSecs ?? 30;

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

  // Start a durable run when using tools
  let runId: string | undefined;
  if (tools && input.executeToolCall) {
    try {
      const runResult = await runStart(input.campId, {
        max_iterations: maxIterations,
        tool_timeout_secs: toolTimeoutSecs,
        approval_policy: approvalPolicy,
      });
      runId = runResult.run_id;
    } catch {
      // If run_start fails (e.g. workspace not set), continue without run state.
    }

    const wrappedExecuteToolCall = wrapToolCallWithRunState(
      input.campId,
      runId,
      toolTimeoutSecs,
      input.executeToolCall,
    );

    const looped = await runToolUseLoop(
      input.campId,
      requestPayload.messages,
      tools,
      input.onToken,
      {
        model: requestPayload.model,
        temperature: requestPayload.temperature,
        max_tokens: requestPayload.max_tokens,
        executeToolCall: wrappedExecuteToolCall,
        maxIterations,
        correlationId: input.correlationId,
        telemetry: input.telemetry,
      },
    );

    if (runId) {
      await emitRunEvent(input.campId, makeRunStateEvent(runId, 'run_completed'));
    }

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
      runId,
    };
  }

  const streamed = await streamOpenRouterChatCompletion(requestPayload, input.onToken, {
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

/**
 * Wraps a tool call executor with run_state event logging and per-tool timeout.
 * On timeout, emits a run_failed event for that tool step instead of crashing.
 */
function wrapToolCallWithRunState(
  campId: string,
  runId: string | undefined,
  toolTimeoutSecs: number,
  executeToolCall: (input: OpenRouterToolLoopExecutionInput) => Promise<string>,
): (input: OpenRouterToolLoopExecutionInput) => Promise<string> {
  return async (input: OpenRouterToolLoopExecutionInput): Promise<string> => {
    const toolName = input.toolCall.function.name;
    const toolCallId = input.toolCall.id;

    if (runId) {
      await emitRunEvent(campId, makeRunStateEvent(runId, 'tool_executing', {
        tool_name: toolName,
        tool_call_id: toolCallId,
        args_json: input.toolCall.function.arguments,
      }));
    }

    try {
      const result = await Promise.race([
        executeToolCall(input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${toolTimeoutSecs}s`)), toolTimeoutSecs * 1000),
        ),
      ]);

      if (runId) {
        await emitRunEvent(campId, makeRunStateEvent(runId, 'tool_result', {
          tool_name: toolName,
          tool_call_id: toolCallId,
          result_json: result,
        }));
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (runId) {
        await emitRunEvent(campId, makeRunStateEvent(runId, 'run_failed', {
          tool_name: toolName,
          tool_call_id: toolCallId,
          error: errorMessage,
        }));
      }

      return JSON.stringify({ error: errorMessage });
    }
  };
}
