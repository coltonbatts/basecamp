export type ToolName = 'search_runs' | 'write_note';

export type SearchRunsToolArgs = {
  query: string;
  limit?: number;
  model?: string;
  tag?: string;
  since_ts?: number;
  until_ts?: number;
};

export type SearchRunsToolResult = {
  results: Array<{
    id: string;
    timestamp: number;
    requested_model?: string | null;
    resolved_model?: string | null;
    user_prompt_excerpt: string;
    output_excerpt: string;
    tags?: string | null;
    rating?: number | null;
  }>;
};

export type WriteNoteToolArgs = {
  filename: string;
  title?: string;
  body: string;
};

export type WriteNoteToolResult = {
  path: string;
  bytes_written: number;
};

export type ToolErrorResult = {
  error: string;
};

export type ToolExecutor<TArgs, TResult> = (args: TArgs) => Promise<TResult>;
