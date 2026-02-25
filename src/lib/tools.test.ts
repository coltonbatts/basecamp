import { describe, expect, it, vi } from 'vitest';

import { executeCampToolCall, getToolKind, type CampToolHandlers } from './tools';
import type { CampArtifact, CampArtifactMetadata, CampTranscriptSearchMatch } from './types';

const ACTIVE_ARTIFACT: CampArtifactMetadata = {
  id: 'artifact-active',
  title: 'Design Notes',
  filename: 'design-notes.md',
  source_message_id: 'msg-1',
  source_role: 'assistant',
  tags: ['design'],
  created_at: 10,
  updated_at: 20,
  usage_count: 2,
  archived: false,
};

const ARCHIVED_ARTIFACT: CampArtifactMetadata = {
  id: 'artifact-archived',
  title: 'Old Draft',
  filename: 'old-draft.md',
  source_message_id: 'msg-2',
  source_role: 'assistant',
  tags: ['archive'],
  created_at: 5,
  updated_at: 5,
  usage_count: 0,
  archived: true,
};

const FULL_ARTIFACT: CampArtifact = {
  metadata: ACTIVE_ARTIFACT,
  body: 'Artifact body',
};

const TRANSCRIPT_MATCH: CampTranscriptSearchMatch = {
  id: 'msg-3',
  role: 'assistant',
  created_at: 42,
  excerpt: 'Found matching content',
  match_count: 3,
};

function makeHandlers(overrides: Partial<CampToolHandlers> = {}): CampToolHandlers {
  return {
    readFile: vi.fn(async () => 'file-content'),
    listFiles: vi.fn(async () => ['alpha.md', 'beta.md']),
    writeFile: vi.fn(async () => {}),
    listArtifacts: vi.fn(async () => [ACTIVE_ARTIFACT, ARCHIVED_ARTIFACT]),
    getArtifact: vi.fn(async () => FULL_ARTIFACT),
    createArtifact: vi.fn(async () => FULL_ARTIFACT),
    updateArtifact: vi.fn(async () => FULL_ARTIFACT),
    searchTranscript: vi.fn(async () => [TRANSCRIPT_MATCH]),
    updateCampPrompt: vi.fn(async () => {}),
    updateCampMemory: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('executeCampToolCall', () => {
  it('executes list_artifacts with deterministic filtering', async () => {
    const handlers = makeHandlers();
    const result = await executeCampToolCall(
      {
        type: 'function',
        function: {
          name: 'list_artifacts',
          arguments: '{}',
        },
      },
      handlers,
    );

    expect(JSON.parse(result)).toEqual({
      include_archived: false,
      artifacts: [ACTIVE_ARTIFACT],
    });
  });

  it('parses strict update_artifact args and requires at least one update field', async () => {
    const handlers = makeHandlers();
    await expect(
      executeCampToolCall(
        {
          type: 'function',
          function: {
            name: 'update_artifact',
            arguments: JSON.stringify({ artifact_id: 'artifact-active' }),
          },
        },
        handlers,
      ),
    ).rejects.toThrow('must be provided');
  });

  it('rejects additional properties deterministically', async () => {
    const handlers = makeHandlers();
    await expect(
      executeCampToolCall(
        {
          type: 'function',
          function: {
            name: 'get_artifact',
            arguments: JSON.stringify({ artifact_id: 'artifact-active', extra: 'nope' }),
          },
        },
        handlers,
      ),
    ).rejects.toThrow('Unrecognized key');
  });

  it('executes update_camp_memory and returns sorted memory keys', async () => {
    const handlers = makeHandlers();
    const result = await executeCampToolCall(
      {
        type: 'function',
        function: {
          name: 'update_camp_memory',
          arguments: JSON.stringify({
            memory: {
              zebra: true,
              alpha: 1,
            },
          }),
        },
      },
      handlers,
    );

    expect(handlers.updateCampMemory).toHaveBeenCalledWith({
      zebra: true,
      alpha: 1,
    });
    expect(JSON.parse(result)).toEqual({
      updated: true,
      memory_keys: ['alpha', 'zebra'],
    });
  });

  it('executes search_transcript with validated args', async () => {
    const handlers = makeHandlers();
    const result = await executeCampToolCall(
      {
        type: 'function',
        function: {
          name: 'search_transcript',
          arguments: JSON.stringify({
            query: 'matching',
            limit: 4,
            roles: ['assistant'],
          }),
        },
      },
      handlers,
    );

    expect(handlers.searchTranscript).toHaveBeenCalledWith({
      query: 'matching',
      limit: 4,
      roles: ['assistant'],
    });
    expect(JSON.parse(result)).toEqual({
      query: 'matching',
      limit: 4,
      roles: ['assistant'],
      matches: [TRANSCRIPT_MATCH],
    });
  });
});

describe('getToolKind', () => {
  it('returns read or mutate classification for known tools', () => {
    expect(getToolKind('read_file')).toBe('read');
    expect(getToolKind('update_camp_prompt')).toBe('mutate');
    expect(getToolKind('unknown_tool')).toBeNull();
  });
});
