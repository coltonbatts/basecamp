export type ProviderKind = 'openrouter' | 'lmstudio' | 'ollama' | 'llama_cpp';

export type StreamProtocol = 'sse' | 'ndjson' | 'none';

export type ProviderCapabilities = {
  supports_tools: boolean;
  supports_images: boolean;
  supports_json_schema: boolean;
  max_context_tokens?: number | null;
  stream_protocol: StreamProtocol;
};

export type ProviderRegistryRow = {
  provider_kind: ProviderKind;
  base_url: string;
  enabled: boolean;
  last_ok_at: number | null;
  last_error: string | null;
};

export type ProviderModelsRefreshItem = {
  provider_kind: string;
  count: number;
};

export type ProviderModelsRefreshResult = {
  refreshed: ProviderModelsRefreshItem[];
  total_count: number;
};

export type ModelOption = {
  id: string;
  label: string;
  contextLength?: number;
};

export type ModelRow = {
  provider_kind: string;
  model_id: string;
  id: string;
  name: string | null;
  description: string | null;
  context_length: number | null;
  pricing_json: string | null;
  capabilities_json: string;
  raw_json: string;
  updated_at: number;
};

export type ModelRowPayload = {
  provider_kind: string;
  model_id: string;
  id: string;
  name: string | null;
  description: string | null;
  context_length: number | null;
  pricing_json: string | null;
  capabilities_json: string;
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
  provider_kind?: string;
  model_id?: string;
  model_overrides?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
  } | null;
  tools_enabled: boolean;
  is_team?: boolean;
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
  attachments?: CampMessageAttachment[];
};

export type CampMessageAttachment = {
  type: 'image_url';
  image_url: { url: string };
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
  attachments?: CampMessageAttachment[];
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

// ── Agent Run State ──────────────────────────────────────────────

export type RunEventKind =
  | 'run_started'
  | 'tool_proposed'
  | 'tool_approved'
  | 'tool_rejected'
  | 'tool_executing'
  | 'tool_result'
  | 'run_completed'
  | 'run_cancelled'
  | 'run_failed';

export type RunStateEvent = {
  run_id: string;
  event: RunEventKind;
  timestamp_ms: number;
  tool_name?: string;
  tool_call_id?: string;
  args_json?: string;
  result_json?: string;
  error?: string;
  config?: Record<string, unknown>;
};

export type RunStartConfig = {
  max_iterations?: number;
  tool_timeout_secs?: number;
  approval_policy?: ApprovalPolicy;
};

export type RunStartResult = {
  run_id: string;
  camp_id: string;
  config: Record<string, unknown>;
  timestamp_ms: number;
};

export type ApprovalPolicy = 'manual' | 'auto-safe' | 'full-auto';

export type TeamAgentConfig = {
  id: string;
  role: string;
  model: string;
  tool_subset: string[];
  description: string;
};

export type TeamAgentCreateInput = {
  id: string;
  role: string;
  model: string;
  tool_subset: string[];
  description?: string;
};

export type TeamSettingsUpdateInput = {
  supervisor_model: string;
  reflection_loops: boolean;
  max_reflection_rounds: number;
};

export type DelegationStep = {
  step_id: string;
  assigned_to: string;
  instruction: string;
  depends_on: string[];
  expected_output: string;
};

export type DecompositionPlan = {
  task_summary: string;
  steps: DelegationStep[];
  reflection_required: boolean;
};

export type BusTokenUsage = {
  input: number;
  output: number;
};

export type TeamBusEntryType =
  | 'decomposition'
  | 'delegation'
  | 'result'
  | 'critique'
  | 'promotion'
  | 'error';

export type TeamBusEntry = {
  id: string;
  timestamp: string;
  type: TeamBusEntryType;
  from: string;
  to: string;
  step_id?: string | null;
  content: unknown;
  token_usage: BusTokenUsage;
};

export type AgentStepResult = {
  step_id: string;
  agent_id: string;
  output_text: string;
  draft_path: string;
  context_writes: string[];
  token_usage: BusTokenUsage;
};

export type ReflectionSummary = {
  artifact_path: string;
  promoted_path: string;
  rounds_completed: number;
  pass: boolean;
  critiques: Array<{
    issues: string[];
    suggestions: string[];
    pass: boolean;
  }>;
};

export type TeamStepStatus = {
  step_id: string;
  assigned_to: string;
  expected_output: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | string;
};

export type TeamAgentStatus = {
  id: string;
  role: string;
  model: string;
  tool_subset: string[];
  status: 'idle' | 'working' | 'reflecting' | string;
  token_usage: BusTokenUsage;
  last_output_preview?: string | null;
};

export type TeamArtifactsStatus = {
  drafts: string[];
  promoted: string[];
};

export type TeamStatus = {
  is_team: boolean;
  supervisor_model: string;
  reflection_loops: boolean;
  max_reflection_rounds: number;
  agents: TeamAgentStatus[];
  steps: TeamStepStatus[];
  bus_entries: number;
  artifacts: TeamArtifactsStatus;
};
