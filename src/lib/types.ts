export type ModelOption = {
  id: string;
  label: string;
  contextLength?: number;
};

export type ModelRow = {
  id: string;
  name: string | null;
  description: string | null;
  context_length: number | null;
  pricing_json: string | null;
  raw_json: string;
  updated_at: number;
};

export type ModelRowPayload = {
  id: string;
  name: string | null;
  description: string | null;
  context_length: number | null;
  pricing_json: string | null;
  raw_json: string;
  updated_at: number;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: unknown;
  [key: string]: unknown;
};

export type Run = {
  id: string;
  timestamp: number;
  model: string;
  requested_model: string;
  resolved_model: string | null;
  system_prompt: string;
  user_prompt: string;
  temperature: number;
  max_tokens: number;
  request_json: string;
  response_json: string;
  output_text: string;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error: string | null;
  rating: number | null;
  tags: string | null;
};

export type RunInsertPayload = {
  id: string;
  timestamp: number;
  model: string;
  requested_model: string;
  resolved_model: string | null;
  system_prompt: string;
  user_prompt: string;
  temperature: number;
  max_tokens: number;
  request_json: string;
  response_json: string;
  output_text: string;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error: string | null;
  rating: number | null;
  tags: string | null;
};

export type RunUpdatePayload = {
  id: string;
  rating: number | null;
  tags: string | null;
};

export type RunFormValues = {
  model: string;
  fallbackModel: string | null;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
};

export type TokenUsage = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
};

export type ToolCallRow = {
  id: string;
  run_id: string;
  step_index: number;
  tool_name: string;
  args_json: string;
  result_json: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

export type ToolCallStartPayload = {
  run_id: string;
  step_index: number;
  tool_name: string;
  args_json: string;
  started_at: number;
};

export type RunSearchDbArgs = {
  query: string;
  limit?: number;
  model?: string;
  tag?: string;
  since_ts?: number;
  until_ts?: number;
};

export type RunSearchDbRow = {
  id: string;
  timestamp: number;
  requested_model: string | null;
  resolved_model: string | null;
  user_prompt: string;
  output_text: string;
  tags: string | null;
  rating: number | null;
  latency_ms: number | null;
  total_tokens: number | null;
};

export type WriteNotePayload = {
  filename: string;
  title?: string;
  body: string;
};

export type WriteNoteResult = {
  path: string;
  bytes_written: number;
};

export type CampConfig = {
  schema_version: string;
  id: string;
  name: string;
  model: string;
  tools_enabled: boolean;
  created_at: number;
  updated_at: number;
};

export type CampSummary = {
  id: string;
  name: string;
  model: string;
  updated_at: number;
  path: string;
};

export type CampMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  created_at: number;
  name?: string;
  tool_call_id?: string;
  tool_calls?: CampToolCall[];
  included_artifact_ids?: string[];
};

export type CampMessageRole = CampMessage['role'];

export type CampToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type Camp = {
  config: CampConfig;
  system_prompt: string;
  memory: unknown;
  transcript: CampMessage[];
  context_path: string;
};

export type CampCreatePayload = {
  name: string;
  model: string;
  system_prompt: string;
  memory?: unknown;
  tools_enabled?: boolean;
};

export type CampUpdateConfigPayload = {
  camp_id: string;
  name: string;
  model: string;
  tools_enabled: boolean;
};

export type CampUpdateSystemPromptPayload = {
  camp_id: string;
  system_prompt: string;
};

export type CampUpdateMemoryPayload = {
  camp_id: string;
  memory: unknown;
};

export type CampSearchTranscriptPayload = {
  query: string;
  limit?: number;
  roles?: CampMessageRole[];
};

export type CampTranscriptSearchMatch = {
  id: string;
  role: CampMessageRole;
  created_at: number;
  excerpt: string;
  match_count: number;
  name?: string;
  tool_call_id?: string;
};

export type CampAppendMessagePayload = {
  camp_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: CampToolCall[];
  included_artifact_ids?: string[];
};

export type CampArtifactMetadata = {
  id: string;
  title: string;
  filename: string;
  source_message_id: string;
  source_role: 'system' | 'user' | 'assistant' | string;
  tags: string[];
  created_at: number;
  updated_at: number;
  usage_count: number;
  archived: boolean;
};

export type CampArtifact = {
  metadata: CampArtifactMetadata;
  body: string;
};

export type CampCreateArtifactFromMessagePayload = {
  camp_id: string;
  message_id: string;
  title?: string;
  tags?: string[];
};

export type CampUpdateArtifactPayload = {
  camp_id: string;
  artifact_id: string;
  title?: string;
  body?: string;
  tags?: string[];
};

export type CampToggleArtifactArchivePayload = {
  camp_id: string;
  artifact_id: string;
  archived: boolean;
};
