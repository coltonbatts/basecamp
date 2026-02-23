import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runToolUseLoop, type OpenRouterToolSpec } from './openrouter';

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

function makeOkResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

describe('runToolUseLoop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns assistant output without tools on first iteration', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeOkResponse({
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
      }),
    );

    const onToken = vi.fn();
    const executeToolCall = vi.fn(async () => '{"ok":true}');

    const result = await runToolUseLoop(
      'camp-1',
      [{ role: 'user', content: 'hi' }],
      TEST_TOOLS,
      'api-key',
      onToken,
      {
        model: 'openrouter/auto',
        temperature: 0.3,
        max_tokens: 300,
        executeToolCall,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(onToken).toHaveBeenCalledWith('hello world');
    expect(result.outputText).toBe('hello world');
    expect(result.transcriptMessages).toEqual([{ role: 'assistant', content: 'hello world', tool_calls: undefined }]);
  });

  it('executes tool call and then resolves final assistant output', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeOkResponse({
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
        }),
      )
      .mockResolvedValueOnce(
        makeOkResponse({
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
        }),
      );

    const executeToolCall = vi.fn(async () => '{"path":"project.md","content":"ok"}');

    const result = await runToolUseLoop(
      'camp-1',
      [{ role: 'user', content: 'read project.md' }],
      TEST_TOOLS,
      'api-key',
      vi.fn(),
      {
        model: 'openrouter/auto',
        temperature: 0.3,
        max_tokens: 300,
        executeToolCall,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(result.outputText).toBe('done');
    expect(result.requestPayloads).toHaveLength(2);
    expect(result.transcriptMessages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('throws when max iterations are exceeded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeOkResponse({
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
      }),
    );

    const executeToolCall = vi.fn(async () => '{"ok":true}');

    await expect(
      runToolUseLoop(
        'camp-1',
        [{ role: 'user', content: 'loop forever' }],
        TEST_TOOLS,
        'api-key',
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

