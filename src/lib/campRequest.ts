import type { Camp, CampArtifact } from './types';
import type { OpenRouterChatMessage, OpenRouterChatRequestPayload, OpenRouterToolSpec } from './openrouter';

const MAX_ARTIFACT_CHARS_PER_ITEM = 8_000;
const MAX_ARTIFACT_CHARS_TOTAL = 40_000;
const TRUNCATION_MARKER = '[TRUNCATED]';

function stableJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function toMemorySystemMessage(memory: unknown): string {
  const serialized = stableJsonStringify(memory);
  return `Structured memory (JSON):\n${serialized}`;
}

function normalizeTranscript(messages: Camp['transcript']): OpenRouterChatMessage[] {
  const normalized: OpenRouterChatMessage[] = [];

  for (const message of messages) {
    const trimmedContent = message.content.trim();

    if (message.role === 'tool') {
      if (!message.tool_call_id || !message.name || !trimmedContent) {
        continue;
      }

      normalized.push({
        role: 'tool',
        content: trimmedContent,
        tool_call_id: message.tool_call_id,
        name: message.name,
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      normalized.push({
        role: 'assistant',
        content: trimmedContent,
        tool_calls: message.tool_calls,
      });
      continue;
    }

    if (!trimmedContent) {
      continue;
    }

    normalized.push({
      role: message.role,
      content: trimmedContent,
    });
  }

  return normalized;
}

function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const suffix = `\n${TRUNCATION_MARKER}`;
  if (maxChars <= suffix.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }

  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

function toArtifactSystemMessages(artifacts: CampArtifact[]): OpenRouterChatMessage[] {
  const sortedArtifacts = [...artifacts].sort((left, right) => {
    const titleCompare = left.metadata.title.localeCompare(right.metadata.title);
    if (titleCompare !== 0) {
      return titleCompare;
    }

    return left.metadata.id.localeCompare(right.metadata.id);
  });

  const messages: OpenRouterChatMessage[] = [];
  let remainingChars = MAX_ARTIFACT_CHARS_TOTAL;

  for (const artifact of sortedArtifacts) {
    if (remainingChars <= 0) {
      break;
    }

    const perArtifactLimit = Math.min(MAX_ARTIFACT_CHARS_PER_ITEM, remainingChars);
    const truncatedBody = truncateWithMarker(artifact.body, perArtifactLimit);
    remainingChars -= truncatedBody.length;

    messages.push({
      role: 'system',
      content: `Artifact: ${artifact.metadata.title} (id: ${artifact.metadata.id})\n\n${truncatedBody}`,
    });
  }

  return messages;
}

export function composeCampMessages(input: {
  camp: Camp;
  userMessage: string;
  selectedArtifacts?: CampArtifact[];
}): OpenRouterChatMessage[] {
  const messages: OpenRouterChatMessage[] = [];

  if (input.camp.system_prompt.trim()) {
    messages.push({
      role: 'system',
      content: input.camp.system_prompt.trim(),
    });
  }

  messages.push({
    role: 'system',
    content: toMemorySystemMessage(input.camp.memory),
  });

  messages.push(...toArtifactSystemMessages(input.selectedArtifacts ?? []));

  messages.push(...normalizeTranscript(input.camp.transcript));

  const trimmedUserMessage = input.userMessage.trim();
  if (trimmedUserMessage) {
    messages.push({
      role: 'user',
      content: trimmedUserMessage,
    });
  }

  return messages;
}

export function composeCampOpenRouterRequest(input: {
  camp: Camp;
  userMessage: string;
  selectedArtifacts?: CampArtifact[];
  temperature: number;
  maxTokens: number;
  tools?: OpenRouterToolSpec[];
}): OpenRouterChatRequestPayload {
  const tools = input.tools && input.tools.length > 0 ? input.tools : undefined;

  return {
    model: input.camp.config.model,
    messages: composeCampMessages({
      camp: input.camp,
      userMessage: input.userMessage,
      selectedArtifacts: input.selectedArtifacts,
    }),
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    tools,
    tool_choice: tools ? 'auto' : undefined,
  };
}
