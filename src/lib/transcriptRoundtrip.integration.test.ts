import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composeCampOpenRouterRequest } from './campRequest';
import { runCampChatRuntime } from './campChatRuntime';
import { runToolUseLoop, streamOpenRouterChatCompletion } from './openrouter';
import type { Camp, CampAppendMessagePayload, CampMessage } from './types';

vi.mock('./openrouter', async () => {
  const actual = await vi.importActual<typeof import('./openrouter')>('./openrouter');
  return {
    ...actual,
    runToolUseLoop: vi.fn(),
    streamOpenRouterChatCompletion: vi.fn(),
  };
});

const toolLoopMock = vi.mocked(runToolUseLoop);
const streamMock = vi.mocked(streamOpenRouterChatCompletion);

const TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read file',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

function makeCamp(): Camp {
  return {
    config: {
      schema_version: '0.1',
      id: 'camp-1',
      name: 'Camp',
      model: 'openrouter/auto',
      tools_enabled: true,
      created_at: 1,
      updated_at: 1,
    },
    system_prompt: 'Stay precise.',
    memory: { project: 'basecamp' },
    transcript: [
      {
        id: 'u-initial',
        role: 'user',
        content: 'Analyze a.md',
        created_at: 1,
      },
    ],
    context_path: '/tmp/context',
  };
}

function persistRuntimeMessages(
  baseTranscript: CampMessage[],
  messages: Array<Omit<CampAppendMessagePayload, 'camp_id' | 'included_artifact_ids'>>,
): CampMessage[] {
  return [
    ...baseTranscript,
    ...messages.map((message, index) => ({
      id: `persisted-${index + 1}`,
      role: message.role,
      content: message.content,
      created_at: 1_000 + index,
      name: message.name,
      tool_call_id: message.tool_call_id,
      tool_calls: message.tool_calls,
    })),
  ];
}

describe('transcript replay roundtrip integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should replay assistant/tool transcript entries across turns after multi-iteration tool runtime', async () => {
    toolLoopMock.mockResolvedValue({
      responsePayload: { ok: true },
      outputText: 'Final answer',
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      resolvedModel: 'openrouter/auto',
      requestPayloads: [
        {
          model: 'openrouter/auto',
          messages: [{ role: 'user', content: 'Analyze a.md' }],
          temperature: 0.3,
          max_tokens: 500,
          tools: TOOL_SPECS,
          tool_choice: 'auto',
        },
        {
          model: 'openrouter/auto',
          messages: [
            { role: 'user', content: 'Analyze a.md' },
            {
              role: 'assistant',
              content: 'Planning pass 1',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'list_files', arguments: '{}' },
                },
              ],
            },
          ],
          temperature: 0.3,
          max_tokens: 500,
          tools: TOOL_SPECS,
          tool_choice: 'auto',
        },
      ],
      transcriptMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Planning pass 1' }],
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'list_files', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'list_files',
          tool_call_id: 'call-1',
          content: '{"files":["a.md"]}',
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-2',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.md"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'read_file',
          tool_call_id: 'call-2',
          content: '{"path":"a.md","content":"A"}',
        },
        {
          role: 'assistant',
          content: 'Final answer',
        },
      ],
    });

    const runtimeCamp = makeCamp();
    const runtimeResult = await runCampChatRuntime({
      campId: 'camp-1',
      camp: runtimeCamp,
      selectedArtifacts: [],
      apiKey: 'key',
      temperature: 0.3,
      maxTokens: 500,
      onToken: vi.fn(),
      tools: TOOL_SPECS,
      executeToolCall: vi.fn(async () => '{"ok":true}'),
    });

    expect(streamMock).not.toHaveBeenCalled();
    expect(runtimeResult.usingTools).toBe(true);
    expect(runtimeResult.transcriptMessages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);

    const roundTrippedCamp: Camp = {
      ...runtimeCamp,
      transcript: persistRuntimeMessages(runtimeCamp.transcript, runtimeResult.transcriptMessages),
    };

    const nextTurnPayload = composeCampOpenRouterRequest({
      camp: roundTrippedCamp,
      userMessage: 'Follow-up question',
      temperature: 0.2,
      maxTokens: 400,
      tools: TOOL_SPECS,
    });

    const replayedConversation = nextTurnPayload.messages.filter(
      (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
    );

    expect(replayedConversation.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);

    expect(replayedConversation[1]).toMatchObject({
      role: 'assistant',
      content: 'Planning pass 1',
      tool_calls: [
        {
          id: 'call-1',
          function: { name: 'list_files', arguments: '{}' },
        },
      ],
    });

    expect(replayedConversation[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'list_files',
      content: '{"files":["a.md"]}',
    });

    expect(replayedConversation[3]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-2',
          function: { name: 'read_file', arguments: '{"path":"a.md"}' },
        },
      ],
    });

    expect(replayedConversation[4]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-2',
      name: 'read_file',
      content: '{"path":"a.md","content":"A"}',
    });

    expect(replayedConversation[5]).toMatchObject({
      role: 'assistant',
      content: 'Final answer',
    });

    expect(nextTurnPayload.tool_choice).toBe('auto');
    expect(nextTurnPayload.tools).toHaveLength(1);
  });
});

