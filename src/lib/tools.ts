import type { OpenRouterToolCall, OpenRouterToolSpec } from './openrouter';

export const FILESYSTEM_TOOLS: OpenRouterToolSpec[] = [
  {
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
      },
    },
  },
  {
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
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: "Write or overwrite a file in the Camp's context directory.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: "Relative path to the file within the Camp context directory.",
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
];

type FilesystemToolName = 'read_file' | 'list_files' | 'write_file';

type FilesystemToolHandlers = {
  readFile: (path: string) => Promise<string>;
  listFiles: (path?: string) => Promise<string[]>;
  writeFile: (path: string, content: string) => Promise<void>;
};

function parseArgumentObject(rawArguments: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (error) {
    throw new Error(`Tool arguments must be valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

function readRequiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Tool argument "${key}" must be a non-empty string.`);
  }

  return value;
}

function readOptionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Tool argument "${key}" must be a string when provided.`);
  }

  return value;
}

function assertFilesystemToolName(name: string): FilesystemToolName {
  if (name === 'read_file' || name === 'list_files' || name === 'write_file') {
    return name;
  }

  throw new Error(`Unsupported filesystem tool: ${name}`);
}

export async function executeFilesystemToolCall(
  toolCall: OpenRouterToolCall,
  handlers: FilesystemToolHandlers,
): Promise<string> {
  const toolName = assertFilesystemToolName(toolCall.function.name);
  const args = parseArgumentObject(toolCall.function.arguments ?? '{}');

  switch (toolName) {
    case 'read_file': {
      const path = readRequiredStringArg(args, 'path');
      const content = await handlers.readFile(path);
      return JSON.stringify({ path, content });
    }
    case 'list_files': {
      const path = readOptionalStringArg(args, 'path');
      const files = await handlers.listFiles(path);
      return JSON.stringify({ path: path ?? '', files });
    }
    case 'write_file': {
      const path = readRequiredStringArg(args, 'path');
      const content = readRequiredStringArg(args, 'content');
      await handlers.writeFile(path, content);
      return JSON.stringify({ path, bytes_written: new TextEncoder().encode(content).length });
    }
    default: {
      throw new Error(`Unhandled filesystem tool: ${toolName}`);
    }
  }
}
