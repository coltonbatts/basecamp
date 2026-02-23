import { ZodError } from 'zod';

import { insertToolCallStart, updateToolCallError, updateToolCallResult } from './db';
import type { OpenRouterChatMessage, OpenRouterToolCall } from './openrouter';
import { OpenRouterRequestError, runOpenRouterChatCompletion } from './openrouter';
import { isToolName, parseToolArguments, toolArgValidators, toolExecutors, toolSpecs } from './tools/registry';
import type { ToolErrorResult } from './tools/types';
import type { TokenUsage, ToolCallStartPayload } from './types';

export const TOOL_RUNTIME_MAX_STEPS = 5;
export const TOOL_STEP_LIMIT_MESSAGE =
  'Tool step limit reached (5). No further tool calls were executed. Please narrow the task and run again.';

export type ToolRuntimeInput = {
  apiKey: string;
  runId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
};

export type ToolRuntimeResult = {
  outputText: string;
  usage: TokenUsage;
  resolvedModel: string | null;
  requestPayloads: unknown[];
  responsePayloads: unknown[];
  toolStepCount: number;
  stepLimitReached: boolean;
  error: string | null;
};

function toToolErrorObject(message: string): ToolErrorResult {
  return { error: message };
}

function toJsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join('; ');
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Tool execution failed.';
}

function normalizeToolCalls(toolCalls: OpenRouterToolCall[], executedToolSteps: number): OpenRouterToolCall[] {
  return toolCalls.map((toolCall, index) => ({
    ...toolCall,
    id: toolCall.id ?? `tool-call-${executedToolSteps}-${index}`,
  }));
}

async function logToolCallStart(payload: ToolCallStartPayload): Promise<string> {
  return insertToolCallStart(payload);
}

async function executeSingleToolCall(params: {
  runId: string;
  toolCall: OpenRouterToolCall;
  stepIndex: number;
}): Promise<string> {
  const { runId, toolCall, stepIndex } = params;
  const startedAt = Date.now();
  const argsForLogging = typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '{}';

  const toolCallId = await logToolCallStart({
    run_id: runId,
    step_index: stepIndex,
    tool_name: toolCall.function.name,
    args_json: argsForLogging,
    started_at: startedAt,
  });

  try {
    if (!isToolName(toolCall.function.name)) {
      throw new Error(`Unknown tool requested: ${toolCall.function.name}`);
    }

    const rawArgsObject = parseToolArguments(toolCall.function.arguments);
    const validatedArgs = toolArgValidators[toolCall.function.name].parse(rawArgsObject);
    const result = await toolExecutors[toolCall.function.name](validatedArgs);
    const resultJson = toJsonString(result);

    await updateToolCallResult(toolCallId, resultJson, Date.now());

    return resultJson;
  } catch (error) {
    const errorMessage = toErrorMessage(error);

    try {
      await updateToolCallError(toolCallId, errorMessage, Date.now());
    } catch {
      // Preserve original tool error if log update fails.
    }

    return toJsonString(toToolErrorObject(errorMessage));
  }
}

function buildInitialMessages(systemPrompt: string, userPrompt: string): OpenRouterChatMessage[] {
  const messages: OpenRouterChatMessage[] = [];

  if (systemPrompt.trim()) {
    messages.push({
      role: 'system',
      content: systemPrompt.trim(),
    });
  }

  messages.push({
    role: 'user',
    content: userPrompt.trim(),
  });

  return messages;
}

export async function runToolRuntime(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
  const messages = buildInitialMessages(input.systemPrompt, input.userPrompt);

  const requestPayloads: unknown[] = [];
  const responsePayloads: unknown[] = [];

  let outputText = '';
  let usage: TokenUsage = {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  };
  let resolvedModel: string | null = null;
  let toolStepCount = 0;

  while (true) {
    const requestPayload = {
      model: input.model,
      messages,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      tools: toolSpecs,
      tool_choice: 'auto' as const,
    };

    requestPayloads.push(requestPayload);

    let completion;
    try {
      completion = await runOpenRouterChatCompletion(input.apiKey, requestPayload);
    } catch (error) {
      if (error instanceof OpenRouterRequestError) {
        responsePayloads.push(error.responsePayload);
        return {
          outputText: '',
          usage,
          resolvedModel,
          requestPayloads,
          responsePayloads,
          toolStepCount,
          stepLimitReached: false,
          error: error.message,
        };
      }

      return {
        outputText: '',
        usage,
        resolvedModel,
        requestPayloads,
        responsePayloads,
        toolStepCount,
        stepLimitReached: false,
        error: error instanceof Error ? error.message : 'Unexpected OpenRouter error.',
      };
    }

    responsePayloads.push(completion.responsePayload);
    usage = completion.usage;
    resolvedModel = completion.resolvedModel ?? resolvedModel;

    const normalizedToolCalls = normalizeToolCalls(completion.assistantMessage.toolCalls, toolStepCount);
    if (normalizedToolCalls.length === 0) {
      outputText = completion.outputText;
      return {
        outputText,
        usage,
        resolvedModel,
        requestPayloads,
        responsePayloads,
        toolStepCount,
        stepLimitReached: false,
        error: null,
      };
    }

    messages.push({
      role: 'assistant',
      content: completion.assistantMessage.content,
      tool_calls: normalizedToolCalls,
    });

    for (const toolCall of normalizedToolCalls) {
      if (toolStepCount >= TOOL_RUNTIME_MAX_STEPS) {
        return {
          outputText: TOOL_STEP_LIMIT_MESSAGE,
          usage,
          resolvedModel,
          requestPayloads,
          responsePayloads,
          toolStepCount,
          stepLimitReached: true,
          error: null,
        };
      }

      let toolResultJson: string;
      try {
        toolResultJson = await executeSingleToolCall({
          runId: input.runId,
          toolCall,
          stepIndex: toolStepCount,
        });
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        toolResultJson = toJsonString(toToolErrorObject(`Tool logging failure: ${errorMessage}`));
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResultJson,
      });

      toolStepCount += 1;
    }
  }
}
