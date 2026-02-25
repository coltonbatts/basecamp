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

export const OpenRouterKeyInfoSchema = z.object({
  data: z.object({
    label: z.string().nullable(),
    limit: z.number().nullable(),
    usage: z.number(),
    limit_remaining: z.number().nullable(),
    is_free_tier: z.boolean(),
    rate_limit: z.object({
      requests: z.number(),
      interval: z.string()
    })
  })
});

export type OpenRouterKeyInfo = z.infer<typeof OpenRouterKeyInfoSchema>;

export async function fetchOpenRouterKeyInfo(apiKey: string): Promise<OpenRouterKeyInfo["data"]> {
  const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OpenRouter key info with status ${response.status}`);
  }

  const payload = await response.json();
  const parsed = OpenRouterKeyInfoSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error('Failed to parse OpenRouter key info response.');
  }

  return parsed.data.data;
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

function mapUsage(usage: z.infer<typeof OpenRouterResponseSchema>['usage']): TokenUsage {
  return {
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
  };
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

function pickSafeResponseHeaders(response: Response): Record<string, string> {
  const blocked = new Set(['set-cookie', 'cookie', 'authorization', 'proxy-authorization']);
  const safe: Record<string, string> = {};
  const headersValue = response.headers as Headers | undefined;

  if (!headersValue || typeof headersValue.entries !== 'function') {
    return safe;
  }

  for (const [key, value] of headersValue.entries()) {
    if (blocked.has(key.toLowerCase())) {
      continue;
    }

    safe[key] = value;
  }

  return safe;
}

function buildOpenRouterHeaders(apiKey: string, correlationId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost',
    'X-Title': 'Basecamp',
  };

  if (correlationId) {
    headers['X-Basecamp-Correlation-Id'] = correlationId;
  }

  return headers;
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
  apiKey: string,
  requestPayload: OpenRouterChatRequestPayload,
  options?: OpenRouterRequestOptions,
): Promise<OpenRouterChatRunResult> {
  const validatedRequestPayload = OpenRouterChatRequestSchema.parse(requestPayload) as OpenRouterChatRequestPayload;
  const startedAt = Date.now();

  callTelemetry(() => {
    options?.telemetry?.onHttpRequestStart?.({
      timestamp_ms: startedAt,
      request_payload: validatedRequestPayload,
      message_count: validatedRequestPayload.messages.length,
      stream: false,
    });
  });

  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: buildOpenRouterHeaders(apiKey, options?.correlationId),
      body: JSON.stringify(validatedRequestPayload),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        error_message: error instanceof Error ? error.message : 'OpenRouter network request failed.',
        request_payload: validatedRequestPayload,
        response_payload: null,
        stream: false,
        stack: error instanceof Error ? error.stack : undefined,
      });
    });
    throw error;
  }

  let responsePayload: unknown = null;

  try {
    responsePayload = await response.json();
  } catch {
    responsePayload = null;
  }

  const durationMs = Date.now() - startedAt;
  const safeHeaders = pickSafeResponseHeaders(response);

  if (!response.ok) {
    const responseMessage =
      typeof responsePayload === 'object' &&
        responsePayload !== null &&
        'error' in responsePayload &&
        typeof (responsePayload as { error?: { message?: unknown } }).error?.message === 'string'
        ? (responsePayload as { error: { message: string } }).error.message
        : `OpenRouter request failed with status ${response.status}`;

    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        status: response.status,
        error_message: responseMessage,
        request_payload: validatedRequestPayload,
        response_payload: responsePayload,
        stream: false,
      });
    });

    throw new OpenRouterRequestError(responseMessage, validatedRequestPayload, responsePayload);
  }

  const parsed = OpenRouterResponseSchema.safeParse(responsePayload);
  if (!parsed.success) {
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        status: response.status,
        error_message: 'OpenRouter response validation failed.',
        request_payload: validatedRequestPayload,
        response_payload: responsePayload,
        stream: false,
      });
    });
    throw new OpenRouterRequestError('OpenRouter response validation failed.', validatedRequestPayload, responsePayload);
  }

  callTelemetry(() => {
    options?.telemetry?.onHttpRequestEnd?.({
      timestamp_ms: Date.now(),
      duration_ms: durationMs,
      status: response.status,
      response_headers: safeHeaders,
      request_payload: validatedRequestPayload,
      response_payload: responsePayload,
      stream: false,
    });
  });

  const message = parsed.data.choices[0].message;
  const toolCalls = parseToolCalls(message.tool_calls);
  const normalizedContent = message.content ?? null;

  return {
    responsePayload,
    outputText: normalizeMessageContent(normalizedContent).trim(),
    usage: mapUsage(parsed.data.usage),
    resolvedModel: parsed.data.model ?? null,
    assistantMessage: {
      content: normalizedContent,
      toolCalls,
    },
  };
}

export async function runOpenRouterCompletion(
  apiKey: string,
  requestPayload: OpenRouterRequestPayload,
  options?: OpenRouterRequestOptions,
): Promise<OpenRouterRunResult> {
  const completion = await runOpenRouterChatCompletion(apiKey, requestPayload, options);

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
  apiKey: string,
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

    const completion = await runOpenRouterChatCompletion(apiKey, requestPayload, {
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

function parseOpenRouterErrorMessage(status: number, responsePayload: unknown): string {
  if (
    typeof responsePayload === 'object' &&
    responsePayload !== null &&
    'error' in responsePayload &&
    typeof (responsePayload as { error?: { message?: unknown } }).error?.message === 'string'
  ) {
    return (responsePayload as { error: { message: string } }).error.message;
  }

  return `OpenRouter request failed with status ${status}`;
}

export async function streamOpenRouterChatCompletion(
  apiKey: string,
  requestPayload: OpenRouterChatRequestPayload,
  onToken: (token: string) => void,
  options?: OpenRouterRequestOptions,
): Promise<OpenRouterRunResult> {
  const validatedRequestPayload = OpenRouterChatRequestSchema.parse(requestPayload) as OpenRouterChatRequestPayload;
  const streamRequestPayload: OpenRouterChatRequestPayload = {
    ...validatedRequestPayload,
    stream: true,
  };
  const startedAt = Date.now();

  callTelemetry(() => {
    options?.telemetry?.onHttpRequestStart?.({
      timestamp_ms: startedAt,
      request_payload: streamRequestPayload,
      message_count: streamRequestPayload.messages.length,
      stream: true,
    });
  });

  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: buildOpenRouterHeaders(apiKey, options?.correlationId),
      body: JSON.stringify(streamRequestPayload),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        error_message: error instanceof Error ? error.message : 'OpenRouter network request failed.',
        request_payload: streamRequestPayload,
        response_payload: null,
        stream: true,
        stack: error instanceof Error ? error.stack : undefined,
      });
    });
    throw error;
  }

  if (!response.ok) {
    let responsePayload: unknown = null;
    try {
      responsePayload = await response.json();
    } catch {
      responsePayload = null;
    }

    const durationMs = Date.now() - startedAt;
    const errorMessage = parseOpenRouterErrorMessage(response.status, responsePayload);
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        status: response.status,
        error_message: errorMessage,
        request_payload: streamRequestPayload,
        response_payload: responsePayload,
        stream: true,
      });
    });

    throw new OpenRouterRequestError(
      errorMessage,
      streamRequestPayload,
      responsePayload,
    );
  }

  if (!response.body) {
    const durationMs = Date.now() - startedAt;
    callTelemetry(() => {
      options?.telemetry?.onHttpRequestError?.({
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        status: response.status,
        error_message: 'OpenRouter response stream is not available.',
        request_payload: streamRequestPayload,
        response_payload: null,
        stream: true,
      });
    });
    throw new OpenRouterRequestError('OpenRouter response stream is not available.', streamRequestPayload, null);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let outputText = '';
  let resolvedModel: string | null = null;
  let usage: TokenUsage = {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  };
  let chunksProcessed = 0;
  let buffer = '';

  const processSseChunk = (rawEvent: string) => {
    const lines = rawEvent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      let parsedChunk: unknown = null;
      try {
        parsedChunk = JSON.parse(data);
      } catch {
        continue;
      }

      chunksProcessed += 1;
      callTelemetry(() => {
        options?.telemetry?.onStreamChunk?.(chunksProcessed);
      });

      if (typeof parsedChunk === 'object' && parsedChunk !== null) {
        const maybeModel = (parsedChunk as { model?: unknown }).model;
        if (typeof maybeModel === 'string' && maybeModel.trim()) {
          resolvedModel = maybeModel;
        }

        const maybeUsage = (parsedChunk as { usage?: unknown }).usage;
        if (typeof maybeUsage === 'object' && maybeUsage !== null) {
          usage = {
            prompt_tokens:
              typeof (maybeUsage as { prompt_tokens?: unknown }).prompt_tokens === 'number'
                ? (maybeUsage as { prompt_tokens: number }).prompt_tokens
                : usage.prompt_tokens,
            completion_tokens:
              typeof (maybeUsage as { completion_tokens?: unknown }).completion_tokens === 'number'
                ? (maybeUsage as { completion_tokens: number }).completion_tokens
                : usage.completion_tokens,
            total_tokens:
              typeof (maybeUsage as { total_tokens?: unknown }).total_tokens === 'number'
                ? (maybeUsage as { total_tokens: number }).total_tokens
                : usage.total_tokens,
          };
        }

        const deltaContent =
          (parsedChunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
        const token = normalizeMessageContent(deltaContent);
        if (token) {
          outputText += token;
          onToken(token);
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      processSseChunk(rawEvent);
    }
  }

  if (buffer.trim()) {
    processSseChunk(buffer);
  }

  const streamResponsePayload = {
    chunks_processed: chunksProcessed,
    output_text: outputText,
    usage,
    resolved_model: resolvedModel,
  };

  callTelemetry(() => {
    options?.telemetry?.onHttpRequestEnd?.({
      timestamp_ms: Date.now(),
      duration_ms: Date.now() - startedAt,
      status: response.status,
      response_headers: pickSafeResponseHeaders(response),
      request_payload: streamRequestPayload,
      response_payload: streamResponsePayload,
      stream: true,
      stream_chunk_count: chunksProcessed,
    });
  });

  return {
    responsePayload: streamResponsePayload,
    outputText,
    usage,
    resolvedModel,
  };
}
