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
): Promise<OpenRouterChatRunResult> {
  const validatedRequestPayload = OpenRouterChatRequestSchema.parse(requestPayload) as OpenRouterChatRequestPayload;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Basecamp',
    },
    body: JSON.stringify(validatedRequestPayload),
  });

  let responsePayload: unknown = null;

  try {
    responsePayload = await response.json();
  } catch {
    responsePayload = null;
  }

  if (!response.ok) {
    const responseMessage =
      typeof responsePayload === 'object' &&
      responsePayload !== null &&
      'error' in responsePayload &&
      typeof (responsePayload as { error?: { message?: unknown } }).error?.message === 'string'
        ? (responsePayload as { error: { message: string } }).error.message
        : `OpenRouter request failed with status ${response.status}`;

    throw new OpenRouterRequestError(responseMessage, validatedRequestPayload, responsePayload);
  }

  const parsed = OpenRouterResponseSchema.safeParse(responsePayload);
  if (!parsed.success) {
    throw new OpenRouterRequestError('OpenRouter response validation failed.', validatedRequestPayload, responsePayload);
  }

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
): Promise<OpenRouterRunResult> {
  const completion = await runOpenRouterChatCompletion(apiKey, requestPayload);

  return {
    responsePayload: completion.responsePayload,
    outputText: completion.outputText,
    usage: completion.usage,
    resolvedModel: completion.resolvedModel,
  };
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
): Promise<OpenRouterRunResult> {
  const validatedRequestPayload = OpenRouterChatRequestSchema.parse(requestPayload) as OpenRouterChatRequestPayload;
  const streamRequestPayload: OpenRouterChatRequestPayload = {
    ...validatedRequestPayload,
    stream: true,
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Basecamp',
    },
    body: JSON.stringify(streamRequestPayload),
  });

  if (!response.ok) {
    let responsePayload: unknown = null;
    try {
      responsePayload = await response.json();
    } catch {
      responsePayload = null;
    }

    throw new OpenRouterRequestError(
      parseOpenRouterErrorMessage(response.status, responsePayload),
      streamRequestPayload,
      responsePayload,
    );
  }

  if (!response.body) {
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

  return {
    responsePayload: { chunks_processed: chunksProcessed },
    outputText,
    usage,
    resolvedModel,
  };
}
