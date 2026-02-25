import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage: ((message: T) => void) | null = null;
  }

  return {
    invoke: vi.fn(),
    Channel: MockChannel,
  };
});

import { invoke } from '@tauri-apps/api/core';

import { runToolUseLoop, type OpenRouterToolSpec } from './openrouter';

const invokeMock = vi.mocked(invoke);

const TEST_TOOLS: OpenRouterToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
];

function makeCommandResult(payload: unknown, outputText: string) {
  return {
    response_payload: payload,
    output_text: outputText,
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
    resolved_model: 'openrouter/auto',
    status: 200,
    duration_ms: 10,
    response_headers: {},
    stream_chunk_count: 0,
  };
}

describe('runToolUseLoop', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('returns assistant output without tools on first iteration', async () => {
    invokeMock.mockResolvedValue(
      makeCommandResult(
        {
          model: 'openrouter/auto',
          choices: [
            {
              message: {
                content: 'hello world',
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        'hello world',
      ),
    );

    const onToken = vi.fn();
    const executeToolCall = vi.fn(async () => '{"ok":true}');

    const result = await runToolUseLoop(
      'camp-1',
      [{ role: 'user', content: 'hi' }],
      TEST_TOOLS,
      onToken,
      {
        model: 'openrouter/auto',
        temperature: 0.3,
        max_tokens: 300,
        executeToolCall,
      },
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(onToken).toHaveBeenCalledWith('hello world');
    expect(result.outputText).toBe('hello world');
    expect(result.transcriptMessages).toEqual([{ role: 'assistant', content: 'hello world', tool_calls: undefined }]);
  });

  it('executes tool call and then resolves final assistant output', async () => {
    invokeMock
      .mockResolvedValueOnce(
        makeCommandResult(
          {
            model: 'openrouter/auto',
            choices: [
              {
                message: {
                  content: 'checking files',
                  tool_calls: [
                    {
                      id: 'tool-1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"project.md"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 4,
              total_tokens: 9,
            },
          },
          'checking files',
        ),
      )
      .mockResolvedValueOnce(
        makeCommandResult(
          {
            model: 'openrouter/auto',
            choices: [
              {
                message: {
                  content: 'done',
                },
              },
            ],
            usage: {
              prompt_tokens: 6,
              completion_tokens: 5,
              total_tokens: 11,
            },
          },
          'done',
        ),
      );

    const executeToolCall = vi.fn(async () => '{"path":"project.md","content":"ok"}');

    const result = await runToolUseLoop(
      'camp-1',
      [{ role: 'user', content: 'read project.md' }],
      TEST_TOOLS,
      vi.fn(),
      {
        model: 'openrouter/auto',
        temperature: 0.3,
        max_tokens: 300,
        executeToolCall,
      },
    );

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(result.outputText).toBe('done');
    expect(result.requestPayloads).toHaveLength(2);
    expect(result.transcriptMessages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('throws when max iterations are exceeded', async () => {
    invokeMock.mockResolvedValue(
      makeCommandResult(
        {
          model: 'openrouter/auto',
          choices: [
            {
              message: {
                content: 'still working',
                tool_calls: [
                  {
                    id: 'tool-1',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"loop.md"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        'still working',
      ),
    );

    const executeToolCall = vi.fn(async () => '{"ok":true}');

    await expect(
      runToolUseLoop(
        'camp-1',
        [{ role: 'user', content: 'loop forever' }],
        TEST_TOOLS,
        vi.fn(),
        {
          model: 'openrouter/auto',
          temperature: 0.3,
          max_tokens: 300,
          executeToolCall,
          maxIterations: 2,
        },
      ),
    ).rejects.toThrow('Tool-use loop exceeded 2 iterations.');

    expect(executeToolCall).toHaveBeenCalledTimes(2);
  });
});
