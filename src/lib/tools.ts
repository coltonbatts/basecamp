import { invoke } from '@tauri-apps/api/core';

import type { OpenRouterToolCall, OpenRouterToolSpec } from './openrouter';
import type { CampArtifact, CampArtifactMetadata, CampTranscriptSearchMatch } from './types';
import {
  campCreateArtifactArgsSchema,
  campGetArtifactArgsSchema,
  campListArtifactsArgsSchema,
  campListFilesArgsSchema,
  campReadFileArgsSchema,
  campSearchTranscriptArgsSchema,
  campToolSpecs,
  campUpdateArtifactArgsSchema,
  campUpdateMemoryArgsSchema,
  campUpdatePromptArgsSchema,
  campWriteFileArgsSchema,
  getCampToolKind,
  getMcpToolKind,
  getMcpToolSpecs,
  isCampToolName,
  isMcpToolName,
  parseToolArguments,
  type ToolKind,
} from './tools/registry';

export type CampToolHandlers = {
  readFile: (path: string) => Promise<string>;
  listFiles: (path?: string) => Promise<string[]>;
  writeFile: (path: string, content: string) => Promise<void>;
  listArtifacts: () => Promise<CampArtifactMetadata[]>;
  getArtifact: (artifactId: string) => Promise<CampArtifact>;
  createArtifact: (input: { sourceMessageId: string; title?: string; tags?: string[] }) => Promise<CampArtifact>;
  updateArtifact: (input: { artifactId: string; title?: string; body?: string; tags?: string[] }) => Promise<CampArtifact>;
  searchTranscript: (input: {
    query: string;
    limit: number;
    roles?: Array<'system' | 'user' | 'assistant' | 'tool'>;
  }) => Promise<CampTranscriptSearchMatch[]>;
  updateCampPrompt: (systemPrompt: string) => Promise<void>;
  updateCampMemory: (memory: Record<string, unknown>) => Promise<void>;
};

export const CAMP_TOOLS: OpenRouterToolSpec[] = campToolSpecs;
export const FILESYSTEM_TOOLS: OpenRouterToolSpec[] = campToolSpecs.filter((tool) =>
  tool.function.name === 'read_file' ||
  tool.function.name === 'list_files' ||
  tool.function.name === 'write_file'
);

/** Camp tools + any dynamically discovered MCP tools. */
export function getAllToolSpecs(): OpenRouterToolSpec[] {
  return [...campToolSpecs, ...getMcpToolSpecs()];
}

function toJsonString(value: unknown): string {
  return JSON.stringify(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeArtifactRows(rows: CampArtifactMetadata[]): CampArtifactMetadata[] {
  return [...rows].sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return left.created_at - right.created_at;
    }

    return left.id.localeCompare(right.id);
  });
}

export function getToolKind(name: string): ToolKind | null {
  return getCampToolKind(name) ?? getMcpToolKind(name);
}

export { isMcpToolName } from './tools/registry';

type McpToolResultPayload = {
  content: Array<{ type: string; text?: string }>;
  is_error: boolean;
};

export async function executeMcpToolCall(
  toolCall: OpenRouterToolCall,
): Promise<string> {
  const name = toolCall.function.name;
  const slashIndex = name.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid MCP tool name (expected serverId/toolName): ${name}`);
  }
  const serverId = name.slice(0, slashIndex);
  const toolName = name.slice(slashIndex + 1);
  const args = parseToolArguments(toolCall.function.arguments ?? '{}');

  const result = await invoke<McpToolResultPayload>('mcp_call_tool', {
    serverId,
    toolName,
    arguments: args,
  });

  if (result.is_error) {
    const errorText = result.content
      .map((c) => c.text ?? '')
      .join('\n')
      .trim();
    return JSON.stringify({ error: errorText || 'MCP tool returned an error' });
  }

  const text = result.content
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
  return text || JSON.stringify(result);
}

export async function executeCampToolCall(
  toolCall: OpenRouterToolCall,
  handlers: CampToolHandlers,
): Promise<string> {
  if (!isCampToolName(toolCall.function.name)) {
    throw new Error(`Unsupported tool: ${toolCall.function.name}`);
  }

  const rawArgs = parseToolArguments(toolCall.function.arguments ?? '{}');

  switch (toolCall.function.name) {
    case 'read_file': {
      const args = campReadFileArgsSchema.parse(rawArgs);
      const content = await handlers.readFile(args.path);
      return toJsonString({ path: args.path, content });
    }
    case 'list_files': {
      const args = campListFilesArgsSchema.parse(rawArgs);
      const normalizedPath = args.path.trim();
      const files = await handlers.listFiles(normalizedPath || undefined);
      return toJsonString({ path: normalizedPath, files });
    }
    case 'write_file': {
      const args = campWriteFileArgsSchema.parse(rawArgs);
      await handlers.writeFile(args.path, args.content);
      return toJsonString({ path: args.path, bytes_written: byteLength(args.content) });
    }
    case 'list_artifacts': {
      const args = campListArtifactsArgsSchema.parse(rawArgs);
      const artifacts = normalizeArtifactRows(await handlers.listArtifacts()).filter(
        (artifact) => args.include_archived || !artifact.archived,
      );
      return toJsonString({
        include_archived: args.include_archived,
        artifacts,
      });
    }
    case 'get_artifact': {
      const args = campGetArtifactArgsSchema.parse(rawArgs);
      const artifact = await handlers.getArtifact(args.artifact_id);
      return toJsonString({ artifact });
    }
    case 'create_artifact': {
      const args = campCreateArtifactArgsSchema.parse(rawArgs);
      const artifact = await handlers.createArtifact({
        sourceMessageId: args.source_message_id,
        title: args.title,
        tags: args.tags,
      });
      return toJsonString({ artifact });
    }
    case 'update_artifact': {
      const args = campUpdateArtifactArgsSchema.parse(rawArgs);
      const artifact = await handlers.updateArtifact({
        artifactId: args.artifact_id,
        title: args.title,
        body: args.body,
        tags: args.tags,
      });
      return toJsonString({ artifact });
    }
    case 'search_transcript': {
      const args = campSearchTranscriptArgsSchema.parse(rawArgs);
      const matches = await handlers.searchTranscript({
        query: args.query,
        limit: args.limit,
        roles: args.roles,
      });
      return toJsonString({
        query: args.query,
        limit: args.limit,
        roles: args.roles ?? [],
        matches,
      });
    }
    case 'update_camp_prompt': {
      const args = campUpdatePromptArgsSchema.parse(rawArgs);
      await handlers.updateCampPrompt(args.system_prompt);
      return toJsonString({ updated: true, system_prompt_bytes: byteLength(args.system_prompt) });
    }
    case 'update_camp_memory': {
      const args = campUpdateMemoryArgsSchema.parse(rawArgs);
      await handlers.updateCampMemory(args.memory);
      return toJsonString({
        updated: true,
        memory_keys: Object.keys(args.memory).sort((left, right) => left.localeCompare(right)),
      });
    }
    default: {
      throw new Error(`Unhandled tool: ${toolCall.function.name}`);
    }
  }
}
