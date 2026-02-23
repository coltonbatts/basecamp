import { z } from 'zod';

import { searchRunsDb, writeNoteToWorkspace } from '../db';
import type { OpenRouterToolSpec } from '../openrouter';
import type {
  SearchRunsToolArgs,
  SearchRunsToolResult,
  ToolExecutor,
  ToolName,
  WriteNoteToolArgs,
  WriteNoteToolResult,
} from './types';

const MAX_EXCERPT_LENGTH = 180;

function toExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_EXCERPT_LENGTH
    ? `${normalized.slice(0, MAX_EXCERPT_LENGTH - 3)}...`
    : normalized;
}

export const searchRunsArgsSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional().default(5),
  model: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  since_ts: z.number().int().nonnegative().optional(),
  until_ts: z.number().int().nonnegative().optional(),
});

export const writeNoteArgsSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => value.endsWith('.md'), 'filename must end with .md')
    .refine((value) => !value.includes('/') && !value.includes('\\') && !value.includes('..'), {
      message: 'filename must not contain path separators or traversal segments',
    }),
  title: z.string().optional(),
  body: z.string(),
});

export const TOOL_SPECS: OpenRouterToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'search_runs',
      description: 'Search Basecamp run history.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term for user prompt or output text.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 5,
          },
          model: {
            type: 'string',
            description: 'Optional model substring filter against requested or resolved model.',
          },
          tag: {
            type: 'string',
            description: 'Optional tag filter.',
          },
          since_ts: {
            type: 'integer',
            description: 'Optional lower timestamp bound in Unix milliseconds.',
          },
          until_ts: {
            type: 'integer',
            description: 'Optional upper timestamp bound in Unix milliseconds.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description: 'Write a Markdown note to the configured Basecamp workspace folder.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description:
              'Markdown filename ending in .md. Must be a plain filename with no path separators and max length 120.',
          },
          title: {
            type: 'string',
            description: 'Optional markdown title.',
          },
          body: {
            type: 'string',
            description: 'Note body content.',
          },
        },
        required: ['filename', 'body'],
        additionalProperties: false,
      },
    },
  },
];

const searchRunsExecutor: ToolExecutor<SearchRunsToolArgs, SearchRunsToolResult> = async (args) => {
  const rows = await searchRunsDb({
    query: args.query,
    limit: args.limit,
    model: args.model,
    tag: args.tag,
    since_ts: args.since_ts,
    until_ts: args.until_ts,
  });

  return {
    results: rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      requested_model: row.requested_model,
      resolved_model: row.resolved_model,
      user_prompt_excerpt: toExcerpt(row.user_prompt),
      output_excerpt: toExcerpt(row.output_text),
      tags: row.tags,
      rating: row.rating,
    })),
  };
};

const writeNoteExecutor: ToolExecutor<WriteNoteToolArgs, WriteNoteToolResult> = async (args) => {
  return writeNoteToWorkspace({
    filename: args.filename,
    title: args.title,
    body: args.body,
  });
};

export const TOOL_EXECUTORS: Record<ToolName, ToolExecutor<unknown, unknown>> = {
  search_runs: async (args) => searchRunsExecutor(searchRunsArgsSchema.parse(args)),
  write_note: async (args) => writeNoteExecutor(writeNoteArgsSchema.parse(args)),
};

export const TOOL_ARG_VALIDATORS: Record<ToolName, z.ZodType<unknown>> = {
  search_runs: searchRunsArgsSchema,
  write_note: writeNoteArgsSchema,
};

export const toolSpecs = TOOL_SPECS;
export const toolExecutors = TOOL_EXECUTORS;
export const toolArgValidators = TOOL_ARG_VALIDATORS;

export function isToolName(value: string): value is ToolName {
  return value === 'search_runs' || value === 'write_note';
}

export function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Tool arguments must decode to a JSON object.');
      }

      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Tool arguments are not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
    }
  }

  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    throw new Error('Tool arguments must be a JSON object.');
  }

  return rawArguments as Record<string, unknown>;
}
