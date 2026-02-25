import { Channel, invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

import type { RunFormValues, TokenUsage } from './types';

const OpenRouterRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().positive(),
});

const OpenRouterChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']) }).passthrough()).min(1),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().positive(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

const OpenRouterResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z.object({
          message: z
            .object({
              content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
              tool_calls: z.array(z.unknown()).optional(),
            })
            .passthrough(),
        }),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export type OpenRouterToolSpec = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const OpenRouterKeyInfoDataSchema = z.object({
  label: z.string().nullable(),
  limit: z.number().nullable(),
  usage: z.number(),
  limit_remaining: z.number().nullable(),
  is_free_tier: z.boolean(),
  rate_limit: z.object({
    requests: z.number(),
    interval: z.string(),
  }),
});

export type OpenRouterKeyInfo = {
  data: z.infer<typeof OpenRouterKeyInfoDataSchema>;
};

export async function fetchOpenRouterKeyInfo(): Promise<OpenRouterKeyInfo['data']> {
  let payload: unknown;
  try {
    payload = await invoke<unknown>('openrouter_fetch_key_info');
  } catch (error) {
    const message =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'Failed to fetch OpenRouter key info.';
    throw new Error(message);
  }

  const parsed = OpenRouterKeyInfoDataSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error('Failed to parse OpenRouter key info response.');
  }

  return parsed.data;
}

export type OpenRouterToolCall = {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenRouterChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | unknown[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
};

export type OpenRouterRequestPayload = {
  model: string;
  messages: Array<{
    role: 'system' | 'user';
    content: string;
  }>;
  temperature: number;
  max_tokens: number;
};

export type OpenRouterChatRequestPayload = {
  model: string;
  messages: OpenRouterChatMessage[];
  temperature: number;
  max_tokens: number;
  tools?: OpenRouterToolSpec[];
  tool_choice?: 'auto';
  stream?: boolean;
};

export type OpenRouterRunResult = {
  responsePayload: unknown;
  outputText: string;
  usage: TokenUsage;
  resolvedModel: string | null;
};

export type OpenRouterChatRunResult = OpenRouterRunResult & {
  assistantMessage: {
    content: string | unknown[] | null;
    toolCalls: OpenRouterToolCall[];
  };
};

export type OpenRouterToolLoopExecutionInput = {
  campId: string;
  toolCall: OpenRouterToolCall & { id: string };
};

export type OpenRouterToolLoopOptions = {
  model: string;
  temperature: number;
  max_tokens: number;
  executeToolCall: (input: OpenRouterToolLoopExecutionInput) => Promise<string>;
  maxIterations?: number;
  correlationId?: string;
  telemetry?: OpenRouterTelemetryHooks;
};

export type OpenRouterToolLoopResult = OpenRouterRunResult & {
  transcriptMessages: OpenRouterChatMessage[];
  requestPayloads: OpenRouterChatRequestPayload[];
};

export type OpenRouterHttpRequestStartEvent = {
  timestamp_ms: number;
  request_payload: OpenRouterChatRequestPayload;
  message_count: number;
  stream: boolean;
};

export type OpenRouterHttpRequestEndEvent = {
  timestamp_ms: number;
  duration_ms: number;
  status: number;
  response_headers: Record<string, string>;
  request_payload: OpenRouterChatRequestPayload;
  response_payload: unknown;
  stream: boolean;
  stream_chunk_count?: number;
};

export type OpenRouterHttpRequestErrorEvent = {
  timestamp_ms: number;
  duration_ms: number;
  status?: number;
  error_message: string;
  request_payload: OpenRouterChatRequestPayload;
  response_payload: unknown;
  stream: boolean;
  stack?: string;
};

export type OpenRouterToolCallStartEvent = {
  timestamp_ms: number;
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
};

export type OpenRouterToolCallEndEvent = {
  timestamp_ms: number;
  duration_ms: number;
  tool_call_id: string;
  tool_name: string;
  success: boolean;
  result: string;
};

export type OpenRouterTelemetryHooks = {
  onHttpRequestStart?: (event: OpenRouterHttpRequestStartEvent) => void;
  onHttpRequestEnd?: (event: OpenRouterHttpRequestEndEvent) => void;
  onHttpRequestError?: (event: OpenRouterHttpRequestErrorEvent) => void;
  onStreamChunk?: (chunkCount: number) => void;
  onToolCallStart?: (event: OpenRouterToolCallStartEvent) => void;
  onToolCallEnd?: (event: OpenRouterToolCallEndEvent) => void;
};

type OpenRouterRequestOptions = {
  correlationId?: string;
  telemetry?: OpenRouterTelemetryHooks;
};

export class OpenRouterRequestError extends Error {
  requestPayload: OpenRouterChatRequestPayload | OpenRouterRequestPayload;
  responsePayload: unknown;

  constructor(
    message: string,
    requestPayload: OpenRouterChatRequestPayload | OpenRouterRequestPayload,
    responsePayload: unknown,
  ) {
    super(message);
    this.name = 'OpenRouterRequestError';
    this.requestPayload = requestPayload;
    this.responsePayload = responsePayload;
  }
}

function normalizeMessageContent(content: unknown): string {
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

function normalizeToolCallArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === 'string') {
    return argumentsValue;
  }

  try {
    return JSON.stringify(argumentsValue ?? {});
  } catch {
    return '{}';
  }
}

function normalizeToolCallIds(toolCalls: OpenRouterToolCall[], iteration: number): Array<OpenRouterToolCall & { id: string }> {
  return toolCalls.map((toolCall, index) => ({
    ...toolCall,
    id: toolCall.id ?? `tool-call-${iteration}-${index}`,
  }));
}

function parseToolCalls(rawToolCalls: unknown): OpenRouterToolCall[] {
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }

  const parsed: OpenRouterToolCall[] = [];

  for (const rawToolCall of rawToolCalls) {
    if (!rawToolCall || typeof rawToolCall !== 'object') {
      continue;
    }

    const rawType = (rawToolCall as { type?: unknown }).type;
    const rawFunction = (rawToolCall as { function?: unknown }).function;

    if ((rawType !== undefined && rawType !== 'function') || !rawFunction || typeof rawFunction !== 'object') {
      continue;
    }

    const functionName = (rawFunction as { name?: unknown }).name;
    if (typeof functionName !== 'string' || !functionName.trim()) {
      continue;
    }

    parsed.push({
      id: typeof (rawToolCall as { id?: unknown }).id === 'string' ? (rawToolCall as { id: string }).id : undefined,
      type: 'function',
      function: {
        name: functionName,
        arguments: normalizeToolCallArguments((rawFunction as { arguments?: unknown }).arguments),
      },
    });
  }

  return parsed;
}

function callTelemetry(fn: (() => void) | undefined): void {
  if (!fn) {
    return;
  }

  try {
    fn();
  } catch {
    // Telemetry should never change runtime behavior.
  }
}

type OpenRouterCompletionCommandResult = {
  response_payload: unknown;
  output_text: string;
  usage: TokenUsage;
  resolved_model: string | null;
  status: number;
  duration_ms: number;
  response_headers: Record<string, string>;
  stream_chunk_count: number;
};

type OpenRouterCompletionCommandError = {
  message: string;
  status: number | null;
  response_payload: unknown;
};

type OpenRouterStreamEventPayload = {
  type: 'token';
  token: string;
};

function normalizeCommandError(error: unknown): OpenRouterCompletionCommandError {
  if (typeof error === 'object' && error !== null) {
    const objectError = error as {
      message?: unknown;
      status?: unknown;
      response_payload?: unknown;
    };
    return {
      message:
        typeof objectError.message === 'string'
          ? objectError.message
          : 'OpenRouter request failed.',
      status:
        typeof objectError.status === 'number' && Number.isFinite(objectError.status)
          ? objectError.status
          : null,
      response_payload:
        objectError.response_payload !== undefined ? objectError.response_payload : null,
    };
  }

  if (typeof error === 'string') {
    return {
      message: error,
      status: null,
      response_payload: null,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      status: null,
      response_payload: null,
    };
  }

  return {
    message: 'OpenRouter request failed.',
    status: null,
    response_payload: null,
  };
}

async function invokeOpenRouterCompletion(
  requestPayload: OpenRouterChatRequestPayload,
  onToken: (token: string) => void,
  options: OpenRouterRequestOptions | undefined,
  stream: boolean,
): Promise<{ requestPayload: OpenRouterChatRequestPayload; result: OpenRouterCompletionCommandResult }> {
  const validatedRequestPayload = OpenRouterChatRequestSchema.parse(requestPayload) as OpenRouterChatRequestPayload;
  const commandRequestPayload: OpenRouterChatRequestPayload = {
    ...validatedRequestPayload,
    stream,
  };

  const startedAt = Date.now();
  let streamedChunkCount = 0;

  callTelemetry(() => {
    options?.telemetry?.onHttpRequestStart?.({
      timestamp_ms: startedAt,
      request_payload: commandRequestPayload,
      message_count: commandRequestPayload.messages.length,
      stream,
    });
  });

  const onEvent = new Channel<OpenRouterStreamEventPayload>();
  onEvent.onmessage = (event) => {
    if (event.type !== 'token' || !event.token) {
      return;
    }

    streamedChunkCount += 1;
    callTelemetry(() => {
      options?.telemetry?.onStreamChunk?.(streamedChunkCount);
    });
    onToken(event.token);
  };

  try {
    const result = await invoke<OpenRouterCompletionCommandResult>('stream_openrouter_completion', {
      requestPayload: commandRequestPayload,
      onEvent,
    });

    const chunkCount = Math.max(result.stream_chunk_count ?? 0, streamedChunkCount);
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestEnd?.({
        timestamp_ms: Date.now(),
        duration_ms: result.duration_ms,
        status: result.status,
        response_headers: result.response_headers ?? {},
        request_payload: commandRequestPayload,
        response_payload: result.response_payload,
        stream,
        stream_chunk_count: stream ? chunkCount : undefined,
      });
    });

    return {
      requestPayload: commandRequestPayload,
      result: {
        ...result,
        stream_chunk_count: chunkCount,
      },
    };
  } catch (error) {
    const parsed = normalizeCommandError(error);
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - startedAt,
        status: parsed.status ?? undefined,
        error_message: parsed.message,
        request_payload: commandRequestPayload,
        response_payload: parsed.response_payload,
        stream,
        stack: error instanceof Error ? error.stack : undefined,
      });
    });
    throw new OpenRouterRequestError(parsed.message, commandRequestPayload, parsed.response_payload);
  }
}

function isToolResultSuccess(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    return typeof parsed !== 'object' || parsed === null || parsed.error === undefined;
  } catch {
    return true;
  }
}

export function buildOpenRouterPayload(values: RunFormValues): OpenRouterRequestPayload {
  const messages: OpenRouterRequestPayload['messages'] = [];

  if (values.systemPrompt.trim()) {
    messages.push({ role: 'system', content: values.systemPrompt.trim() });
  }

  messages.push({ role: 'user', content: values.userPrompt.trim() });

  return OpenRouterRequestSchema.parse({
    model: values.model,
    messages,
    temperature: values.temperature,
    max_tokens: values.maxTokens,
  });
}

export async function runOpenRouterChatCompletion(
  requestPayload: OpenRouterChatRequestPayload,
  options?: OpenRouterRequestOptions,
): Promise<OpenRouterChatRunResult> {
  const { result } = await invokeOpenRouterCompletion(requestPayload, () => {}, options, false);
  const responsePayload = result.response_payload;
  const parsed = OpenRouterResponseSchema.safeParse(responsePayload);
  if (!parsed.success) {
    throw new OpenRouterRequestError('OpenRouter response validation failed.', requestPayload, responsePayload);
  }
  const message = parsed.data.choices[0].message;
  const toolCalls = parseToolCalls(message.tool_calls);
  const normalizedContent = message.content ?? null;

  return {
    responsePayload,
    outputText: result.output_text,
    usage: result.usage,
    resolvedModel: result.resolved_model,
    assistantMessage: {
      content: normalizedContent,
      toolCalls,
    },
  };
}

export async function runOpenRouterCompletion(
  requestPayload: OpenRouterRequestPayload,
  options?: OpenRouterRequestOptions,
): Promise<OpenRouterRunResult> {
  const completion = await runOpenRouterChatCompletion(requestPayload, options);

  return {
    responsePayload: completion.responsePayload,
    outputText: completion.outputText,
    usage: completion.usage,
    resolvedModel: completion.resolvedModel,
  };
}

export async function runToolUseLoop(
  campId: string,
  messages: OpenRouterChatMessage[],
  tools: OpenRouterToolSpec[],
  onToken: (token: string) => void,
  options: OpenRouterToolLoopOptions,
): Promise<OpenRouterToolLoopResult> {
  const requestPayloads: OpenRouterChatRequestPayload[] = [];
  const transcriptMessages: OpenRouterChatMessage[] = [];
  const conversationMessages: OpenRouterChatMessage[] = [...messages];
  const maxIterations = options.maxIterations ?? 8;

  let usage: TokenUsage = {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  };
  let resolvedModel: string | null = null;
  let responsePayload: unknown = null;
  let outputText = '';

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const requestPayload: OpenRouterChatRequestPayload = {
      model: options.model,
      messages: [...conversationMessages],
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools,
      tool_choice: 'auto',
    };
    requestPayloads.push(requestPayload);

    const completion = await runOpenRouterChatCompletion(requestPayload, {
      correlationId: options.correlationId,
      telemetry: options.telemetry,
    });
    responsePayload = completion.responsePayload;
    usage = completion.usage;
    resolvedModel = completion.resolvedModel ?? resolvedModel;

    const normalizedToolCalls = normalizeToolCallIds(completion.assistantMessage.toolCalls, iteration);
    const assistantText = normalizeMessageContent(completion.assistantMessage.content).trim();
    const assistantConversationMessage: OpenRouterChatMessage = {
      role: 'assistant',
      content: completion.assistantMessage.content ?? assistantText,
      tool_calls: normalizedToolCalls.length > 0 ? normalizedToolCalls : undefined,
    };
    const assistantTranscriptMessage: OpenRouterChatMessage = {
      role: 'assistant',
      content: assistantText,
      tool_calls: normalizedToolCalls.length > 0 ? normalizedToolCalls : undefined,
    };

    conversationMessages.push(assistantConversationMessage);
    transcriptMessages.push(assistantTranscriptMessage);

    if (normalizedToolCalls.length === 0) {
      outputText = assistantText;
      if (outputText) {
        onToken(outputText);
      }

      return {
        responsePayload,
        outputText,
        usage,
        resolvedModel,
        transcriptMessages,
        requestPayloads,
      };
    }

    for (const toolCall of normalizedToolCalls) {
      const toolStartedAt = Date.now();
      callTelemetry(() => {
        options.telemetry?.onToolCallStart?.({
          timestamp_ms: toolStartedAt,
          tool_call_id: toolCall.id,
          tool_name: toolCall.function.name,
          arguments_json: toolCall.function.arguments ?? '{}',
        });
      });

      const toolResult = await options.executeToolCall({
        campId,
        toolCall,
      });

      callTelemetry(() => {
        options.telemetry?.onToolCallEnd?.({
          timestamp_ms: Date.now(),
          duration_ms: Date.now() - toolStartedAt,
          tool_call_id: toolCall.id,
          tool_name: toolCall.function.name,
          success: isToolResultSuccess(toolResult),
          result: toolResult,
        });
      });

      const toolMessage: OpenRouterChatMessage = {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResult,
      };

      conversationMessages.push(toolMessage);
      transcriptMessages.push(toolMessage);
    }
  }

  throw new Error(`Tool-use loop exceeded ${maxIterations} iterations.`);
}

export async function streamOpenRouterChatCompletion(
  requestPayload: OpenRouterChatRequestPayload,
  onToken: (token: string) => void,
  options?: OpenRouterRequestOptions,
): Promise<OpenRouterRunResult> {
  const { result } = await invokeOpenRouterCompletion(requestPayload, onToken, options, true);
  return {
    responsePayload: result.response_payload,
    outputText: result.output_text,
    usage: result.usage,
    resolvedModel: result.resolved_model,
  };
}
