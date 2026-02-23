import { describe, expect, it } from 'vitest';

import { composeCampMessages, composeCampOpenRouterRequest } from './campRequest';
import type { Camp, CampArtifact, CampMessage } from './types';

function makeCamp(transcript: CampMessage[] = []): Camp {
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
    system_prompt: '  Be precise.  ',
    memory: { z: 3, a: 1 },
    transcript,
    context_path: '/tmp/context',
  };
}

function makeArtifact(id: string, title: string, body: string): CampArtifact {
  return {
    metadata: {
      id,
      title,
      filename: `${id}.md`,
      source_message_id: 'm1',
      source_role: 'assistant',
      tags: [],
      created_at: 1,
      updated_at: 1,
      usage_count: 0,
      archived: false,
    },
    body,
  };
}

describe('campRequest composition', () => {
  it('should preserve assistant tool calls and tool messages across transcript roundtrip composition', () => {
    const transcript: CampMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '  read the notes  ',
        created_at: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: 2,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"notes.md"}',
            },
          },
        ],
      },
      {
        id: 't1',
        role: 'tool',
        content: '{"path":"notes.md","content":"ok"}',
        created_at: 3,
        name: 'read_file',
        tool_call_id: 'call-1',
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '  Summary complete. ',
        created_at: 4,
      },
    ];

    const payload = composeCampOpenRouterRequest({
      camp: makeCamp(transcript),
      userMessage: '  continue  ',
      temperature: 0.4,
      maxTokens: 900,
      selectedArtifacts: [
        makeArtifact('b', 'Beta', 'beta body'),
        makeArtifact('a', 'Alpha', 'alpha body'),
      ],
    });

    expect(payload.messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'system',
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);

    expect(payload.messages[0]).toMatchObject({ role: 'system', content: 'Be precise.' });
    expect(payload.messages[1]).toMatchObject({
      role: 'system',
      content: 'Structured memory (JSON):\n{"a":1,"z":3}',
    });

    expect(payload.messages[2]).toMatchObject({
      role: 'system',
      content: 'Artifact: Alpha (id: a)\n\nalpha body',
    });
    expect(payload.messages[3]).toMatchObject({
      role: 'system',
      content: 'Artifact: Beta (id: b)\n\nbeta body',
    });

    expect(payload.messages[5]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"notes.md"}',
          },
        },
      ],
    });

    expect(payload.messages[6]).toMatchObject({
      role: 'tool',
      name: 'read_file',
      tool_call_id: 'call-1',
      content: '{"path":"notes.md","content":"ok"}',
    });

    expect(payload.messages[8]).toMatchObject({ role: 'user', content: 'continue' });
  });

  it('should skip incomplete transcript messages while keeping valid assistant tool-call entries', () => {
    const transcript: CampMessage[] = [
      { id: 'u-empty', role: 'user', content: '   ', created_at: 1 },
      {
        id: 'assistant-tools',
        role: 'assistant',
        content: '   ',
        created_at: 2,
        tool_calls: [
          {
            id: 'call-2',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: '{}',
            },
          },
        ],
      },
      {
        id: 'tool-missing-name',
        role: 'tool',
        content: 'x',
        created_at: 3,
        tool_call_id: 'call-2',
      },
      {
        id: 'tool-missing-call-id',
        role: 'tool',
        content: 'x',
        created_at: 4,
        name: 'list_files',
      },
      {
        id: 'tool-empty-content',
        role: 'tool',
        content: '   ',
        created_at: 5,
        name: 'list_files',
        tool_call_id: 'call-2',
      },
      {
        id: 'tool-valid',
        role: 'tool',
        content: '{"files":[]}',
        created_at: 6,
        name: 'list_files',
        tool_call_id: 'call-2',
      },
    ];

    const messages = composeCampMessages({
      camp: makeCamp(transcript),
      userMessage: '',
    });

    const replayedRoles = messages
      .filter((message) => message.role === 'assistant' || message.role === 'tool')
      .map((message) => message.role);

    expect(replayedRoles).toEqual(['assistant', 'tool']);
    expect(messages.find((message) => message.role === 'tool')).toMatchObject({
      name: 'list_files',
      tool_call_id: 'call-2',
      content: '{"files":[]}',
    });
  });

  it('should only set tool_choice when tools are provided', () => {
    const camp = makeCamp([]);

    const withoutTools = composeCampOpenRouterRequest({
      camp,
      userMessage: 'hello',
      temperature: 0.3,
      maxTokens: 500,
      tools: [],
    });

    expect(withoutTools.tools).toBeUndefined();
    expect(withoutTools.tool_choice).toBeUndefined();

    const withTools = composeCampOpenRouterRequest({
      camp,
      userMessage: 'hello',
      temperature: 0.3,
      maxTokens: 500,
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

    expect(withTools.tools).toHaveLength(1);
    expect(withTools.tool_choice).toBe('auto');
  });

  it('should sort artifacts deterministically and enforce truncation limits', () => {
    const oversizedBody = 'x'.repeat(8_100);
    const selectedArtifacts = Array.from({ length: 6 }, (_, index) => {
      const title = `Artifact ${String.fromCharCode(70 - index)}`;
      const id = `id-${index}`;
      return makeArtifact(id, title, oversizedBody);
    });

    const messages = composeCampMessages({
      camp: makeCamp([]),
      userMessage: '',
      selectedArtifacts,
    });

    const artifactMessages = messages.filter(
      (message) =>
        message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('Artifact: '),
    );

    expect(artifactMessages).toHaveLength(5);
    expect(artifactMessages[0].content).toContain('Artifact: Artifact A');
    expect(artifactMessages[4].content).toContain('Artifact: Artifact E');

    for (const artifactMessage of artifactMessages) {
      expect(typeof artifactMessage.content === 'string' && artifactMessage.content.endsWith('[TRUNCATED]')).toBe(true);
    }
  });
});

