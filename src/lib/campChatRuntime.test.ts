import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCampChatRuntime } from './campChatRuntime';
import { runToolUseLoop, streamOpenRouterChatCompletion } from './openrouter';
import type { Camp } from './types';

vi.mock('./openrouter', async () => {
  const actual = await vi.importActual<typeof import('./openrouter')>('./openrouter');
  return {
    ...actual,
    runToolUseLoop: vi.fn(),
    streamOpenRouterChatCompletion: vi.fn(),
  };
});

const streamMock = vi.mocked(streamOpenRouterChatCompletion);
const toolLoopMock = vi.mocked(runToolUseLoop);

function makeCamp(toolsEnabled: boolean): Camp {
  return {
    config: {
      schema_version: '0.1',
      id: 'camp-1',
      name: 'Camp',
      model: 'openrouter/auto',
      tools_enabled: toolsEnabled,
      created_at: 1,
      updated_at: 1,
    },
    system_prompt: 'Stay concise.',
    memory: { project: 'basecamp' },
    transcript: [{ id: 'u1', role: 'user', content: 'hello', created_at: 1 }],
    context_path: '/tmp/context',
  };
}

describe('runCampChatRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses streaming path when tools are disabled', async () => {
    streamMock.mockResolvedValue({
      responsePayload: { ok: true },
      outputText: 'final answer',
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      resolvedModel: 'openrouter/auto',
    });

    const onToken = vi.fn();
    const result = await runCampChatRuntime({
      campId: 'camp-1',
      camp: makeCamp(false),
      selectedArtifacts: [],
      temperature: 0.3,
      maxTokens: 200,
      onToken,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
    });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(toolLoopMock).not.toHaveBeenCalled();
    expect(result.usingTools).toBe(false);
    expect(result.requestPayload.tools).toBeUndefined();
    expect(result.transcriptMessages).toEqual([{ role: 'assistant', content: 'final answer' }]);
  });

  it('uses tool loop when tools are enabled and normalizes transcript messages', async () => {
    toolLoopMock.mockResolvedValue({
      responsePayload: { ok: true },
      outputText: 'done',
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      resolvedModel: 'openrouter/auto',
      requestPayloads: [
        {
          model: 'openrouter/auto',
          messages: [{ role: 'user', content: 'hello' }],
          temperature: 0.3,
          max_tokens: 200,
          tools: [],
          tool_choice: 'auto',
        },
      ],
      transcriptMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Planning' }],
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
            {
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"b.txt"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'read_file',
          tool_call_id: 'call-1',
          content: '{"path":"a.txt","content":"x"}',
        },
      ],
    });

    const executeToolCall = vi.fn(async () => '{"ok":true}');
    const result = await runCampChatRuntime({
      campId: 'camp-1',
      camp: makeCamp(true),
      selectedArtifacts: [],
      temperature: 0.3,
      maxTokens: 200,
      onToken: vi.fn(),
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
      executeToolCall,
    });

    expect(toolLoopMock).toHaveBeenCalledTimes(1);
    expect(streamMock).not.toHaveBeenCalled();
    expect(result.usingTools).toBe(true);
    expect(result.transcriptMessages).toEqual([
      {
        role: 'assistant',
        content: 'Planning',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      {
        role: 'tool',
        name: 'read_file',
        tool_call_id: 'call-1',
        content: '{"path":"a.txt","content":"x"}',
      },
    ]);
  });

  it('throws when tools are enabled but no tool executor is provided', async () => {
    await expect(
      runCampChatRuntime({
        campId: 'camp-1',
        camp: makeCamp(true),
        selectedArtifacts: [],
        temperature: 0.3,
        maxTokens: 200,
        onToken: vi.fn(),
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read file',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
        ],
      }),
    ).rejects.toThrow('Tool executor is not configured.');
  });

  it('throws when runtime returns empty output', async () => {
    streamMock.mockResolvedValue({
      responsePayload: { ok: true },
      outputText: '   ',
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
      resolvedModel: null,
    });

    await expect(
      runCampChatRuntime({
        campId: 'camp-1',
        camp: makeCamp(false),
        selectedArtifacts: [],
        temperature: 0.3,
        maxTokens: 200,
        onToken: vi.fn(),
      }),
    ).rejects.toThrow('Model returned an empty response.');
  });
});
