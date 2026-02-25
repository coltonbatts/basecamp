import { z } from 'zod';

import { searchRunsDb, writeNoteToWorkspace } from '../db';
import type { OpenRouterToolSpec } from '../openrouter';
import type {
  SearchRunsToolArgs,
  SearchRunsToolResult,
  ToolExecutor,
  ToolName as RuntimeToolName,
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

export type ToolKind = 'read' | 'mutate';

export const searchRunsArgsSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional().default(5),
  model: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  since_ts: z.number().int().nonnegative().optional(),
  until_ts: z.number().int().nonnegative().optional(),
}).strict();

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
}).strict();

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

export const TOOL_EXECUTORS: Record<RuntimeToolName, ToolExecutor<unknown, unknown>> = {
  search_runs: async (args) => searchRunsExecutor(searchRunsArgsSchema.parse(args)),
  write_note: async (args) => writeNoteExecutor(writeNoteArgsSchema.parse(args)),
};

export const TOOL_ARG_VALIDATORS: Record<RuntimeToolName, z.ZodType<unknown>> = {
  search_runs: searchRunsArgsSchema,
  write_note: writeNoteArgsSchema,
};

export const toolSpecs = TOOL_SPECS;
export const toolExecutors = TOOL_EXECUTORS;
export const toolArgValidators = TOOL_ARG_VALIDATORS;

export function isToolName(value: string): value is RuntimeToolName {
  return value === 'search_runs' || value === 'write_note';
}

const roleEnum = z.enum(['system', 'user', 'assistant', 'tool']);

export type CampToolName =
  | 'read_file'
  | 'list_files'
  | 'write_file'
  | 'list_artifacts'
  | 'get_artifact'
  | 'create_artifact'
  | 'update_artifact'
  | 'search_transcript'
  | 'update_camp_prompt'
  | 'update_camp_memory';

export const campReadFileArgsSchema = z.object({
  path: z.string().trim().min(1),
}).strict();

export const campListFilesArgsSchema = z.object({
  path: z.string().optional().default(''),
}).strict();

export const campWriteFileArgsSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8'),
}).strict();

export const campListArtifactsArgsSchema = z.object({
  include_archived: z.boolean().optional().default(false),
}).strict();

export const campGetArtifactArgsSchema = z.object({
  artifact_id: z.string().trim().min(1),
}).strict();

export const campCreateArtifactArgsSchema = z.object({
  source_message_id: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
}).strict();

export const campUpdateArtifactArgsSchema = z.object({
  artifact_id: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
}).strict().superRefine((value, context) => {
  if (value.title === undefined && value.body === undefined && value.tags === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one of "title", "body", or "tags" must be provided.',
      path: [],
    });
  }
});

export const campSearchTranscriptArgsSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).optional().default(10),
  roles: z.array(roleEnum).max(4).optional(),
}).strict();

export const campUpdatePromptArgsSchema = z.object({
  system_prompt: z.string(),
}).strict();

export const campUpdateMemoryArgsSchema = z.object({
  memory: z.record(z.string(), z.unknown()),
}).strict();

type CampToolDefinition = {
  kind: ToolKind;
  spec: OpenRouterToolSpec;
  argsSchema: z.ZodType<unknown>;
};

const CAMP_TOOL_DEFINITIONS: Record<CampToolName, CampToolDefinition> = {
  read_file: {
    kind: 'read',
    argsSchema: campReadFileArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'read_file',
        description: "Read the contents of a file from the current Camp's context directory.",
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: "Relative path to the file within the Camp context directory.",
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
  },
  list_files: {
    kind: 'read',
    argsSchema: campListFilesArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'list_files',
        description: "List files in the Camp's context directory or a subdirectory of it.",
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Optional relative path to a subdirectory. Defaults to the root context directory.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  },
  write_file: {
    kind: 'mutate',
    argsSchema: campWriteFileArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'write_file',
        description: "Write or overwrite a file in the Camp's context directory. MUST be used for generating files like images or PDFs instead of outputting raw text dumps.",
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: "Relative path to the file within the Camp context directory.",
            },
            content: {
              type: 'string',
              description: 'The full content to write to the file. If binary like an image, provide the base64 encoded string.',
            },
            encoding: {
              type: 'string',
              enum: ['utf-8', 'base64'],
              description: 'Text encoding. Use base64 for images and binary files.',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
  },
  list_artifacts: {
    kind: 'read',
    argsSchema: campListArtifactsArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'list_artifacts',
        description: 'List artifacts for the current camp.',
        parameters: {
          type: 'object',
          properties: {
            include_archived: {
              type: 'boolean',
              description: 'Whether to include archived artifacts.',
              default: false,
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  },
  get_artifact: {
    kind: 'read',
    argsSchema: campGetArtifactArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'get_artifact',
        description: 'Get one artifact by id.',
        parameters: {
          type: 'object',
          properties: {
            artifact_id: {
              type: 'string',
              description: 'Artifact id.',
            },
          },
          required: ['artifact_id'],
          additionalProperties: false,
        },
      },
    },
  },
  create_artifact: {
    kind: 'mutate',
    argsSchema: campCreateArtifactArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'create_artifact',
        description: 'Create an artifact from an existing transcript message id.',
        parameters: {
          type: 'object',
          properties: {
            source_message_id: {
              type: 'string',
              description: 'Transcript message id used as artifact source.',
            },
            title: {
              type: 'string',
              description: 'Optional artifact title override.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional artifact tags.',
            },
          },
          required: ['source_message_id'],
          additionalProperties: false,
        },
      },
    },
  },
  update_artifact: {
    kind: 'mutate',
    argsSchema: campUpdateArtifactArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'update_artifact',
        description: 'Update artifact title/body/tags.',
        parameters: {
          type: 'object',
          properties: {
            artifact_id: {
              type: 'string',
              description: 'Artifact id.',
            },
            title: {
              type: 'string',
              description: 'Optional new title.',
            },
            body: {
              type: 'string',
              description: 'Optional full body replacement.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tag list replacement.',
            },
          },
          required: ['artifact_id'],
          additionalProperties: false,
        },
      },
    },
  },
  search_transcript: {
    kind: 'read',
    argsSchema: campSearchTranscriptArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'search_transcript',
        description: 'Search transcript text for matching messages.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Case-insensitive search term.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              default: 10,
            },
            roles: {
              type: 'array',
              items: { type: 'string', enum: roleEnum.options },
              description: 'Optional role filters.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
  },
  update_camp_prompt: {
    kind: 'mutate',
    argsSchema: campUpdatePromptArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'update_camp_prompt',
        description: 'Replace the camp system prompt.',
        parameters: {
          type: 'object',
          properties: {
            system_prompt: {
              type: 'string',
              description: 'New system prompt string.',
            },
          },
          required: ['system_prompt'],
          additionalProperties: false,
        },
      },
    },
  },
  update_camp_memory: {
    kind: 'mutate',
    argsSchema: campUpdateMemoryArgsSchema,
    spec: {
      type: 'function',
      function: {
        name: 'update_camp_memory',
        description: 'Replace camp memory object.',
        parameters: {
          type: 'object',
          properties: {
            memory: {
              type: 'object',
              description: 'JSON object to store as camp memory.',
            },
          },
          required: ['memory'],
          additionalProperties: false,
        },
      },
    },
  },
};

const CAMP_TOOL_NAME_ORDER: CampToolName[] = [
  'read_file',
  'list_files',
  'write_file',
  'list_artifacts',
  'get_artifact',
  'create_artifact',
  'update_artifact',
  'search_transcript',
  'update_camp_prompt',
  'update_camp_memory',
];

export const campToolSpecs: OpenRouterToolSpec[] = CAMP_TOOL_NAME_ORDER.map((name) => CAMP_TOOL_DEFINITIONS[name].spec);

export const campToolKinds: Record<CampToolName, ToolKind> = CAMP_TOOL_NAME_ORDER.reduce(
  (acc, name) => ({
    ...acc,
    [name]: CAMP_TOOL_DEFINITIONS[name].kind,
  }),
  {} as Record<CampToolName, ToolKind>,
);

export const campToolArgValidators: Record<CampToolName, z.ZodType<unknown>> = CAMP_TOOL_NAME_ORDER.reduce(
  (acc, name) => ({
    ...acc,
    [name]: CAMP_TOOL_DEFINITIONS[name].argsSchema,
  }),
  {} as Record<CampToolName, z.ZodType<unknown>>,
);

export function isCampToolName(value: string): value is CampToolName {
  return CAMP_TOOL_NAME_ORDER.includes(value as CampToolName);
}

export function getCampToolKind(value: string): ToolKind | null {
  return isCampToolName(value) ? campToolKinds[value] : null;
}

// ---------------------------------------------------------------------------
// MCP runtime registry — populated at startup via mcp_discover_tools
// ---------------------------------------------------------------------------

export type McpToolEntry = {
  serverId: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  spec: OpenRouterToolSpec;
};

let mcpToolRegistry: McpToolEntry[] = [];

export function setMcpTools(tools: McpToolEntry[]): void {
  mcpToolRegistry = tools;
}

export function getMcpTools(): McpToolEntry[] {
  return mcpToolRegistry;
}

export function getMcpToolSpecs(): OpenRouterToolSpec[] {
  return mcpToolRegistry.map((entry) => entry.spec);
}

export function getMcpToolKind(qualifiedName: string): ToolKind | null {
  const entry = mcpToolRegistry.find((t) => t.qualifiedName === qualifiedName);
  return entry?.kind ?? null;
}

export function isMcpToolName(name: string): boolean {
  return mcpToolRegistry.some((t) => t.qualifiedName === name);
}

export function buildMcpToolSpec(entry: {
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): OpenRouterToolSpec {
  return {
    type: 'function',
    function: {
      name: entry.qualifiedName,
      description: entry.description,
      parameters: entry.inputSchema as OpenRouterToolSpec['function']['parameters'],
    },
  };
}

export function buildMcpToolEntry(raw: {
  server_id: string;
  name: string;
  qualified_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
}): McpToolEntry {
  const kind: ToolKind = raw.read_only ? 'read' : 'mutate';
  return {
    serverId: raw.server_id,
    name: raw.name,
    qualifiedName: raw.qualified_name,
    description: raw.description,
    inputSchema: raw.input_schema,
    kind,
    spec: buildMcpToolSpec({
      qualifiedName: raw.qualified_name,
      description: raw.description,
      inputSchema: raw.input_schema,
    }),
  };
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
