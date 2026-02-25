use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
};

use base64::{engine::general_purpose, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::providers::{registry, BasecampChatMetadata, BasecampChatRequest, ProviderUsage};
use crate::{
    ensure_camps_root, now_timestamp_ms, parse_model_reference, read_camp_config,
    read_provider_runtime_settings, write_camp_config, write_json_file, AppState, CampConfig,
};

const TEAM_FILE_NAME: &str = "team.json";
const TEAM_BUS_FILE_NAME: &str = "team_bus.jsonl";
const SUPERVISOR_DIR_NAME: &str = "supervisor";
const AGENTS_DIR_NAME: &str = "agents";
const TEAM_ARTIFACTS_DIR_NAME: &str = "artifacts";
const TEAM_DRAFTS_DIR_NAME: &str = "drafts";
const TEAM_PROMOTED_DIR_NAME: &str = "promoted";
const TEAM_DEFAULT_MAX_REFLECTION_ROUNDS: u8 = 2;
const TEAM_MAX_AGENTS: usize = 8;
const TEAM_MAX_TOOL_LOOPS: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamAgentConfig {
    pub id: String,
    pub role: String,
    pub model: String,
    #[serde(default)]
    pub tool_subset: Vec<String>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamConfig {
    #[serde(default = "default_true")]
    pub is_team: bool,
    pub supervisor_model: String,
    #[serde(default)]
    pub agents: Vec<TeamAgentConfig>,
    #[serde(default = "default_true")]
    pub reflection_loops: bool,
    #[serde(default = "default_reflection_rounds")]
    pub max_reflection_rounds: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamAgentCreateInput {
    pub id: String,
    pub role: String,
    pub model: String,
    #[serde(default)]
    pub tool_subset: Vec<String>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamSettingsUpdateInput {
    pub supervisor_model: String,
    pub reflection_loops: bool,
    pub max_reflection_rounds: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMeta {
    pub id: String,
    pub role: String,
    pub model: String,
    pub tool_subset: Vec<String>,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationStep {
    pub step_id: String,
    pub assigned_to: String,
    pub instruction: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub expected_output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecompositionPlan {
    pub task_summary: String,
    #[serde(default)]
    pub steps: Vec<DelegationStep>,
    #[serde(default)]
    pub reflection_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BusTokenUsage {
    pub input: i64,
    pub output: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BusEntryType {
    Decomposition,
    Delegation,
    Result,
    Critique,
    Promotion,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusEntry {
    pub id: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub entry_type: BusEntryType,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub content: Value,
    pub token_usage: BusTokenUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStepResult {
    pub step_id: String,
    pub agent_id: String,
    pub output_text: String,
    pub draft_path: String,
    #[serde(default)]
    pub context_writes: Vec<String>,
    pub token_usage: BusTokenUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CritiqueResult {
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub suggestions: Vec<String>,
    #[serde(default)]
    pub pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReflectionSummary {
    pub artifact_path: String,
    pub promoted_path: String,
    pub rounds_completed: u8,
    pub pass: bool,
    pub critiques: Vec<CritiqueResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamStepStatus {
    pub step_id: String,
    pub assigned_to: String,
    pub expected_output: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamAgentStatus {
    pub id: String,
    pub role: String,
    pub model: String,
    #[serde(default)]
    pub tool_subset: Vec<String>,
    pub status: String,
    pub token_usage: BusTokenUsage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TeamArtifactsStatus {
    #[serde(default)]
    pub drafts: Vec<String>,
    #[serde(default)]
    pub promoted: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamStatus {
    pub is_team: bool,
    #[serde(default)]
    pub supervisor_model: String,
    #[serde(default)]
    pub reflection_loops: bool,
    pub max_reflection_rounds: u8,
    #[serde(default)]
    pub agents: Vec<TeamAgentStatus>,
    #[serde(default)]
    pub steps: Vec<TeamStepStatus>,
    pub bus_entries: usize,
    pub artifacts: TeamArtifactsStatus,
}

#[derive(Debug)]
struct AgentRunOutput {
    output_text: String,
    token_usage: BusTokenUsage,
    context_writes: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn default_reflection_rounds() -> u8 {
    TEAM_DEFAULT_MAX_REFLECTION_ROUNDS
}

fn team_json_path(camp_dir: &Path) -> PathBuf {
    camp_dir.join(TEAM_FILE_NAME)
}

fn team_bus_path(camp_dir: &Path) -> PathBuf {
    camp_dir.join(TEAM_BUS_FILE_NAME)
}

fn supervisor_dir(camp_dir: &Path) -> PathBuf {
    camp_dir.join(SUPERVISOR_DIR_NAME)
}

fn agents_root(camp_dir: &Path) -> PathBuf {
    camp_dir.join(AGENTS_DIR_NAME)
}

fn agent_dir(camp_dir: &Path, agent_id: &str) -> PathBuf {
    agents_root(camp_dir).join(agent_id)
}

fn agent_prompt_path(camp_dir: &Path, agent_id: &str) -> PathBuf {
    agent_dir(camp_dir, agent_id).join("system_prompt.md")
}

fn agent_transcript_path(camp_dir: &Path, agent_id: &str) -> PathBuf {
    agent_dir(camp_dir, agent_id).join("transcript.jsonl")
}

fn agent_tools_path(camp_dir: &Path, agent_id: &str) -> PathBuf {
    agent_dir(camp_dir, agent_id).join("tools.json")
}

fn agent_context_dir(camp_dir: &Path, agent_id: &str) -> PathBuf {
    agent_dir(camp_dir, agent_id).join("context")
}

fn supervisor_prompt_path(camp_dir: &Path) -> PathBuf {
    supervisor_dir(camp_dir).join("system_prompt.md")
}

fn supervisor_transcript_path(camp_dir: &Path) -> PathBuf {
    supervisor_dir(camp_dir).join("transcript.jsonl")
}

fn supervisor_tools_path(camp_dir: &Path) -> PathBuf {
    supervisor_dir(camp_dir).join("tools.json")
}

fn team_artifacts_dir(camp_dir: &Path) -> PathBuf {
    camp_dir.join(TEAM_ARTIFACTS_DIR_NAME)
}

fn team_drafts_dir(camp_dir: &Path) -> PathBuf {
    team_artifacts_dir(camp_dir).join(TEAM_DRAFTS_DIR_NAME)
}

fn team_promoted_dir(camp_dir: &Path) -> PathBuf {
    team_artifacts_dir(camp_dir).join(TEAM_PROMOTED_DIR_NAME)
}

fn now_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| format!("{}", now_timestamp_ms()))
}

fn validate_simple_identifier(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} is required."));
    }

    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!(
            "{field_name} must not contain path separators or traversal segments."
        ));
    }

    Ok(trimmed.to_string())
}

fn normalize_tool_subset(values: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in values {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.clone()) {
            result.push(normalized);
        }
    }
    result
}

fn default_supervisor_prompt() -> String {
    "You are the Supervisor of a local agent team running inside Basecamp.

Your team:
{{agent_roster}}

Your job is to decompose the user's task into a delegation plan.
Output ONLY valid JSON matching this schema:

{
  \"task_summary\": \"string\",
  \"steps\": [
    {
      \"step_id\": \"string\",
      \"assigned_to\": \"agent_id\",
      \"instruction\": \"string — precise task for this agent\",
      \"depends_on\": [\"step_id\"] | [],
      \"expected_output\": \"string — what artifact or file to produce\"
    }
  ],
  \"reflection_required\": true | false
}

Rules:
- Assign each step to exactly one agent by their id
- Respect dependencies — don't assign a step if its dependency isn't complete
- Be precise in instructions — agents only read what you write here
- If quality matters, set reflection_required: true"
        .to_string()
}

fn default_agent_prompt(agent: &TeamAgentConfig) -> String {
    format!(
        "You are {role} ({id}) in a local Basecamp team.

Role summary: {description}

Rules:
- Follow the supervisor delegation exactly.
- Use only available tools.
- Write outputs that are deterministic and reproducible.
- If asked for structured output, return valid JSON only.
- Keep answers concise and implementation-focused.",
        role = agent.role,
        id = agent.id,
        description = if agent.description.trim().is_empty() {
            "Specialized contributor"
        } else {
            agent.description.trim()
        }
    )
}

fn write_text_if_missing(path: &Path, contents: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Unable to create folder {}: {err}",
                parent.to_string_lossy()
            )
        })?;
    }

    fs::write(path, contents)
        .map_err(|err| format!("Unable to write file {}: {err}", path.to_string_lossy()))
}

fn resolve_camp_dir(state: &State<'_, AppState>, camp_id: &str) -> Result<PathBuf, String> {
    let validated = validate_simple_identifier(camp_id, "camp_id")?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = camps_root.join(validated);
    if !camp_dir.exists() || !camp_dir.is_dir() {
        return Err("Camp not found.".to_string());
    }
    Ok(camp_dir)
}

fn default_team_config(camp_config: &CampConfig) -> TeamConfig {
    TeamConfig {
        is_team: true,
        supervisor_model: camp_config.model.clone(),
        agents: Vec::new(),
        reflection_loops: true,
        max_reflection_rounds: TEAM_DEFAULT_MAX_REFLECTION_ROUNDS,
    }
}

fn normalize_team_config(mut team_config: TeamConfig, camp_config: &CampConfig) -> TeamConfig {
    if team_config.supervisor_model.trim().is_empty() {
        team_config.supervisor_model = camp_config.model.clone();
    }
    if team_config.max_reflection_rounds == 0 {
        team_config.max_reflection_rounds = TEAM_DEFAULT_MAX_REFLECTION_ROUNDS;
    }
    team_config.max_reflection_rounds = team_config.max_reflection_rounds.min(8);

    for agent in &mut team_config.agents {
        if agent.model.trim().is_empty() {
            agent.model = camp_config.model.clone();
        }
        agent.tool_subset = normalize_tool_subset(&agent.tool_subset);
    }

    team_config.is_team = true;
    team_config
}

fn ensure_team_scaffold(camp_dir: &Path, team_config: &TeamConfig) -> Result<(), String> {
    fs::create_dir_all(supervisor_dir(camp_dir))
        .map_err(|err| format!("Unable to create supervisor folder: {err}"))?;
    fs::create_dir_all(agents_root(camp_dir))
        .map_err(|err| format!("Unable to create agents folder: {err}"))?;
    fs::create_dir_all(team_drafts_dir(camp_dir))
        .map_err(|err| format!("Unable to create drafts folder: {err}"))?;
    fs::create_dir_all(team_promoted_dir(camp_dir))
        .map_err(|err| format!("Unable to create promoted folder: {err}"))?;

    write_text_if_missing(
        &supervisor_prompt_path(camp_dir),
        &default_supervisor_prompt(),
    )?;
    write_text_if_missing(&supervisor_transcript_path(camp_dir), "")?;
    if !supervisor_tools_path(camp_dir).exists() {
        write_json_file(&supervisor_tools_path(camp_dir), &Vec::<String>::new())?;
    }

    if !team_bus_path(camp_dir).exists() {
        write_text_if_missing(&team_bus_path(camp_dir), "")?;
    }

    for agent in &team_config.agents {
        ensure_agent_scaffold(camp_dir, agent)?;
    }

    Ok(())
}

fn ensure_agent_scaffold(camp_dir: &Path, agent: &TeamAgentConfig) -> Result<(), String> {
    let dir = agent_dir(camp_dir, &agent.id);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Unable to create agent folder {}: {err}", agent.id))?;
    fs::create_dir_all(agent_context_dir(camp_dir, &agent.id))
        .map_err(|err| format!("Unable to create agent context folder {}: {err}", agent.id))?;

    write_text_if_missing(
        &agent_prompt_path(camp_dir, &agent.id),
        &default_agent_prompt(agent),
    )?;
    write_text_if_missing(&agent_transcript_path(camp_dir, &agent.id), "")?;

    let tools_path = agent_tools_path(camp_dir, &agent.id);
    if !tools_path.exists() {
        write_json_file(&tools_path, &normalize_tool_subset(&agent.tool_subset))?;
    }

    Ok(())
}

fn ensure_team_mode(camp_dir: &Path) -> Result<CampConfig, String> {
    let mut camp_config = read_camp_config(camp_dir)?;
    if !camp_config.is_team {
        camp_config.is_team = true;
        camp_config.updated_at = now_timestamp_ms();
        write_camp_config(camp_dir, &camp_config)?;
    }
    Ok(camp_config)
}

fn load_team_config(camp_dir: &Path) -> Result<TeamConfig, String> {
    let camp_config = ensure_team_mode(camp_dir)?;
    let path = team_json_path(camp_dir);

    let team_config = if path.exists() {
        let parsed: TeamConfig = crate::read_json_file(&path)?;
        normalize_team_config(parsed, &camp_config)
    } else {
        let defaulted = default_team_config(&camp_config);
        write_json_file(&path, &defaulted)?;
        defaulted
    };

    ensure_team_scaffold(camp_dir, &team_config)?;
    Ok(team_config)
}

fn save_team_config(camp_dir: &Path, team_config: &TeamConfig) -> Result<(), String> {
    let camp_config = read_camp_config(camp_dir)?;
    let normalized = normalize_team_config(team_config.clone(), &camp_config);
    write_json_file(&team_json_path(camp_dir), &normalized)?;
    ensure_team_scaffold(camp_dir, &normalized)?;

    let mut updated = camp_config;
    updated.is_team = true;
    updated.updated_at = now_timestamp_ms();
    write_camp_config(camp_dir, &updated)
}

fn read_team_bus_entries(camp_dir: &Path) -> Result<Vec<BusEntry>, String> {
    let path = team_bus_path(camp_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = fs::File::open(&path).map_err(|err| {
        format!(
            "Unable to open team bus file {}: {err}",
            path.to_string_lossy()
        )
    })?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Unable to read team bus line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let entry: BusEntry = serde_json::from_str(trimmed)
            .map_err(|err| format!("Unable to parse team bus entry: {err}"))?;
        entries.push(entry);
    }

    Ok(entries)
}

fn append_team_bus_entry(
    camp_dir: &Path,
    entry: &BusEntry,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let path = team_bus_path(camp_dir);
    let mut serialized = serde_json::to_string(entry)
        .map_err(|err| format!("Unable to serialize bus entry: {err}"))?;
    serialized.push('\n');

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| {
            format!(
                "Unable to open team bus file {}: {err}",
                path.to_string_lossy()
            )
        })?;

    file.write_all(serialized.as_bytes())
        .map_err(|err| format!("Unable to append team bus entry: {err}"))?;

    if let Some(handle) = app {
        let _ = handle.emit("team://bus_update", entry.clone());
    }

    Ok(())
}

fn make_bus_entry(
    entry_type: BusEntryType,
    from: &str,
    to: &str,
    step_id: Option<&str>,
    content: Value,
    token_usage: BusTokenUsage,
) -> BusEntry {
    BusEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: now_iso8601(),
        entry_type,
        from: from.to_string(),
        to: to.to_string(),
        step_id: step_id.map(ToString::to_string),
        content,
        token_usage,
    }
}

fn usage_to_bus(usage: &ProviderUsage) -> BusTokenUsage {
    BusTokenUsage {
        input: usage.prompt_tokens.unwrap_or(0),
        output: usage.completion_tokens.unwrap_or(0),
    }
}

fn accumulate_usage(into: &mut BusTokenUsage, usage: &ProviderUsage) {
    into.input += usage.prompt_tokens.unwrap_or(0);
    into.output += usage.completion_tokens.unwrap_or(0);
}

async fn run_chat_completion(
    state: &AppState,
    model_reference: &str,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    correlation_scope: Option<&str>,
) -> Result<crate::providers::ProviderChatResponse, String> {
    let (provider_kind, model_id) = parse_model_reference(model_reference);
    let has_tools = tools.as_ref().is_some_and(|items| !items.is_empty());
    let mut request = BasecampChatRequest {
        provider_kind,
        model_id: model_id.clone(),
        messages,
        tools,
        tool_choice: if has_tools {
            Some(serde_json::json!("auto"))
        } else {
            None
        },
        temperature: Some(0.2),
        max_tokens: Some(2_000),
        top_p: None,
        stream: false,
        metadata: BasecampChatMetadata {
            camp_id: correlation_scope.map(ToString::to_string),
            correlation_id: Some(format!("team-{}", Uuid::new_v4())),
            provider_kind: Some(provider_kind),
        },
    };

    let settings = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "Database lock error".to_string())?;

        let model_capabilities =
            registry::get_model_capabilities(&connection, provider_kind, &model_id)
                .map_err(|err| format!("Unable to load model capabilities: {err}"))?;

        let provider = state.provider_manager.get(provider_kind);
        let supports_tools = model_capabilities
            .as_ref()
            .map(|caps| caps.supports_tools)
            .unwrap_or_else(|| provider.supports_tools());

        if !supports_tools {
            request.tools = None;
            request.tool_choice = None;
        }

        read_provider_runtime_settings(&connection, provider_kind)?
    };

    if !settings.config.enabled {
        return Err(format!(
            "Provider `{}` is disabled in Settings.",
            provider_kind.as_str()
        ));
    }

    let provider = state.provider_manager.get(provider_kind);
    let response = provider
        .send_chat(&state.provider_client, &settings, &request, None)
        .await
        .map_err(|error| error.message)?;

    if let Ok(connection) = state.connection.lock() {
        let _ = registry::update_provider_health(&connection, provider_kind, true, None);
    }

    Ok(response)
}

fn parse_json_from_output<T: DeserializeOwned>(raw: &str) -> Result<T, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Model returned empty output where JSON was expected.".to_string());
    }

    if let Ok(parsed) = serde_json::from_str::<T>(trimmed) {
        return Ok(parsed);
    }

    let unwrapped = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(parsed) = serde_json::from_str::<T>(unwrapped) {
        return Ok(parsed);
    }

    if let (Some(start), Some(end)) = (unwrapped.find('{'), unwrapped.rfind('}')) {
        if start < end {
            let candidate = &unwrapped[start..=end];
            if let Ok(parsed) = serde_json::from_str::<T>(candidate) {
                return Ok(parsed);
            }
        }
    }

    Err("Unable to parse JSON payload from model output.".to_string())
}

fn render_agent_roster(team_config: &TeamConfig) -> String {
    if team_config.agents.is_empty() {
        return "- No agents configured".to_string();
    }

    team_config
        .agents
        .iter()
        .map(|agent| {
            let tools = if agent.tool_subset.is_empty() {
                "none".to_string()
            } else {
                agent.tool_subset.join(", ")
            };
            format!(
                "- id: {id}, role: {role}, model: {model}, tools: [{tools}], description: {description}",
                id = agent.id,
                role = agent.role,
                model = agent.model,
                tools = tools,
                description = if agent.description.trim().is_empty() {
                    "No description"
                } else {
                    agent.description.trim()
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn validate_decomposition_plan(
    team_config: &TeamConfig,
    mut plan: DecompositionPlan,
) -> Result<DecompositionPlan, String> {
    if plan.task_summary.trim().is_empty() {
        plan.task_summary = "Task decomposition".to_string();
    }

    if plan.steps.is_empty() {
        return Err("Supervisor returned no steps in decomposition plan.".to_string());
    }

    let roster = team_config
        .agents
        .iter()
        .map(|agent| agent.id.clone())
        .collect::<BTreeSet<_>>();

    let mut step_ids = BTreeSet::new();
    for step in &mut plan.steps {
        step.step_id = validate_simple_identifier(&step.step_id, "step_id")?;
        if !step_ids.insert(step.step_id.clone()) {
            return Err(format!(
                "Duplicate step_id `{}` in decomposition plan.",
                step.step_id
            ));
        }

        step.assigned_to = validate_simple_identifier(&step.assigned_to, "assigned_to")?;
        if !roster.contains(&step.assigned_to) {
            return Err(format!(
                "Decomposition step `{}` assigned to unknown agent `{}`.",
                step.step_id, step.assigned_to
            ));
        }

        if step.instruction.trim().is_empty() {
            return Err(format!(
                "Decomposition step `{}` is missing instruction text.",
                step.step_id
            ));
        }

        if step.expected_output.trim().is_empty() {
            step.expected_output = format!("{}.md", step.step_id);
        }

        let mut unique_deps = Vec::new();
        let mut seen = BTreeSet::new();
        for dep in &step.depends_on {
            let normalized = validate_simple_identifier(dep, "depends_on")?;
            if seen.insert(normalized.clone()) {
                unique_deps.push(normalized);
            }
        }
        step.depends_on = unique_deps;
    }

    for step in &plan.steps {
        for dependency in &step.depends_on {
            if !step_ids.contains(dependency) {
                return Err(format!(
                    "Step `{}` depends on unknown step `{}`.",
                    step.step_id, dependency
                ));
            }
        }
    }

    Ok(plan)
}

fn tool_spec_for_name(name: &str) -> Option<Value> {
    match name {
        "read_file" => Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file from the current agent context directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        })),
        "list_files" => Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files from the current agent context directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": [],
                    "additionalProperties": false
                }
            }
        })),
        "write_file" => Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write a file in the current agent context directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" },
                        "encoding": { "type": "string", "enum": ["utf-8", "base64"] }
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        })),
        "web_search" => Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current information.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        })),
        _ => None,
    }
}

fn tool_specs_for_subset(subset: &[String]) -> Vec<Value> {
    subset
        .iter()
        .filter_map(|name| tool_spec_for_name(name))
        .collect()
}

fn validate_relative_path(
    path: &str,
    field_name: &str,
    allow_empty: bool,
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(PathBuf::new());
        }
        return Err(format!("{field_name} is required."));
    }

    let relative = PathBuf::from(trimmed);
    if relative.is_absolute() {
        return Err(format!("{field_name} must be a relative path."));
    }

    for component in relative.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "{field_name} must not contain traversal segments or absolute path markers."
                ))
            }
        }
    }

    Ok(relative)
}

fn ensure_within_root(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err("Path escapes the agent context directory.".to_string())
    }
}

fn resolve_existing_agent_target(
    root: &Path,
    relative: &str,
    field_name: &str,
    allow_empty: bool,
) -> Result<PathBuf, String> {
    let rel = validate_relative_path(relative, field_name, allow_empty)?;
    let joined = root.join(rel);
    let canonical = fs::canonicalize(&joined)
        .map_err(|err| format!("Unable to resolve path `{relative}`: {err}"))?;
    ensure_within_root(root, &canonical)?;
    Ok(canonical)
}

fn resolve_write_agent_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = validate_relative_path(relative, "path", false)?;
    let target = root.join(rel);
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid path; parent directory missing.".to_string())?;

    fs::create_dir_all(parent)
        .map_err(|err| format!("Unable to create parent directories: {err}"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|err| format!("Unable to resolve parent directory: {err}"))?;
    ensure_within_root(root, &canonical_parent)?;

    Ok(target)
}

fn to_relative_display(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Resolved path is outside root.".to_string())?;
    let mut display = relative.to_string_lossy().replace('\\', "/");
    if path.is_dir() && !display.is_empty() && !display.ends_with('/') {
        display.push('/');
    }
    Ok(display)
}

fn list_files_recursive(root: &Path, current: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in
        fs::read_dir(current).map_err(|err| format!("Unable to read context dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Unable to read context entry: {err}"))?;
        let entry_path = entry.path();
        let canonical = fs::canonicalize(&entry_path)
            .map_err(|err| format!("Unable to resolve context entry: {err}"))?;
        ensure_within_root(root, &canonical)?;

        if canonical.is_dir() {
            list_files_recursive(root, &canonical, out)?;
            continue;
        }

        if canonical.is_file() {
            out.push(to_relative_display(root, &canonical)?);
        }
    }
    Ok(())
}

fn agent_context_root(camp_dir: &Path, agent_id: &str) -> Result<PathBuf, String> {
    let context_dir = agent_context_dir(camp_dir, agent_id);
    fs::create_dir_all(&context_dir)
        .map_err(|err| format!("Unable to create agent context directory: {err}"))?;

    fs::canonicalize(&context_dir)
        .map_err(|err| format!("Unable to resolve agent context directory: {err}"))
}

fn parse_tool_call_name(tool_call: &Value) -> Option<String> {
    tool_call
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn parse_tool_call_args(tool_call: &Value) -> Result<Value, String> {
    let raw_args = tool_call
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("arguments"))
        .and_then(Value::as_str)
        .unwrap_or("{}");

    serde_json::from_str(raw_args).map_err(|err| format!("Invalid tool arguments JSON: {err}"))
}

fn read_file_tool(root: &Path, args: &Value) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "read_file requires `path` string argument.".to_string())?;

    let target = resolve_existing_agent_target(root, path, "path", false)?;
    if !target.is_file() {
        return Err("Requested path is not a file.".to_string());
    }

    let content = fs::read_to_string(&target)
        .map_err(|err| format!("Unable to read file `{}`: {err}", path))?;
    Ok(serde_json::json!({
        "path": path,
        "content": content
    })
    .to_string())
}

fn list_files_tool(root: &Path, args: &Value) -> Result<String, String> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or_default();

    let target = resolve_existing_agent_target(root, path, "path", true)?;
    if !target.is_dir() {
        return Err("Requested path is not a directory.".to_string());
    }

    let mut files = Vec::new();
    list_files_recursive(root, &target, &mut files)?;
    files.sort();

    Ok(serde_json::json!({
        "path": path,
        "files": files
    })
    .to_string())
}

fn write_file_tool(root: &Path, args: &Value, writes: &mut Vec<String>) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "write_file requires `path` string argument.".to_string())?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "write_file requires `content` string argument.".to_string())?;
    let encoding = args
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("utf-8")
        .to_ascii_lowercase();

    let target = resolve_write_agent_target(root, path)?;

    let bytes = if encoding == "base64" {
        general_purpose::STANDARD
            .decode(content)
            .map_err(|err| format!("Invalid base64 content: {err}"))?
    } else {
        content.as_bytes().to_vec()
    };

    fs::write(&target, &bytes).map_err(|err| format!("Unable to write file `{}`: {err}", path))?;

    let canonical = fs::canonicalize(&target)
        .map_err(|err| format!("Unable to resolve destination path: {err}"))?;
    ensure_within_root(root, &canonical)?;
    let relative = to_relative_display(root, &canonical)?;
    writes.push(relative.clone());

    Ok(serde_json::json!({
        "path": path,
        "bytes_written": bytes.len()
    })
    .to_string())
}

fn execute_team_tool_call(root: &Path, tool_call: &Value, writes: &mut Vec<String>) -> String {
    let id = tool_call
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("tool-call")
        .to_string();

    let name = match parse_tool_call_name(tool_call) {
        Some(name) => name,
        None => {
            return serde_json::json!({
                "error": "Tool call missing function.name",
                "tool_call_id": id,
            })
            .to_string()
        }
    };

    let args = match parse_tool_call_args(tool_call) {
        Ok(args) => args,
        Err(error) => {
            return serde_json::json!({
                "error": error,
                "tool_call_id": id,
                "tool": name,
            })
            .to_string()
        }
    };

    let result = match name.as_str() {
        "read_file" => read_file_tool(root, &args),
        "list_files" => list_files_tool(root, &args),
        "write_file" => write_file_tool(root, &args, writes),
        "web_search" => {
            Err("web_search is not available in local deterministic team mode.".to_string())
        }
        _ => Err(format!("Unsupported tool `{name}`.")),
    };

    match result {
        Ok(content) => content,
        Err(error) => serde_json::json!({
            "error": error,
            "tool": name,
            "tool_call_id": id,
        })
        .to_string(),
    }
}

async fn run_agent_inference_loop(
    state: &AppState,
    camp_id: &str,
    model_reference: &str,
    mut messages: Vec<Value>,
    tool_subset: &[String],
    context_root: &Path,
) -> Result<AgentRunOutput, String> {
    let tools = tool_specs_for_subset(tool_subset);
    let mut total_usage = BusTokenUsage::default();
    let mut final_output = String::new();
    let mut writes = Vec::new();

    for _ in 0..TEAM_MAX_TOOL_LOOPS {
        let response = run_chat_completion(
            state,
            model_reference,
            messages.clone(),
            if tools.is_empty() {
                None
            } else {
                Some(tools.clone())
            },
            Some(camp_id),
        )
        .await?;

        accumulate_usage(&mut total_usage, &response.usage);

        let assistant_content = response
            .assistant_message
            .content
            .clone()
            .unwrap_or_else(|| Value::String(response.output_text.clone()));
        let assistant_tool_calls = response.assistant_message.tool_calls.clone();

        let mut assistant_message = serde_json::Map::new();
        assistant_message.insert("role".to_string(), Value::String("assistant".to_string()));
        assistant_message.insert("content".to_string(), assistant_content);
        if !assistant_tool_calls.is_empty() {
            assistant_message.insert(
                "tool_calls".to_string(),
                Value::Array(assistant_tool_calls.clone()),
            );
        }
        messages.push(Value::Object(assistant_message));

        final_output = response.output_text.trim().to_string();

        if assistant_tool_calls.is_empty() {
            break;
        }

        for tool_call in assistant_tool_calls {
            let tool_name =
                parse_tool_call_name(&tool_call).unwrap_or_else(|| "unknown_tool".to_string());
            let tool_call_id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4()));
            let result = execute_team_tool_call(context_root, &tool_call, &mut writes);

            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_name,
                "content": result,
            }));
        }
    }

    Ok(AgentRunOutput {
        output_text: final_output,
        token_usage: total_usage,
        context_writes: writes,
    })
}

fn sanitize_filename(raw: &str, fallback: &str) -> String {
    let leaf = Path::new(raw.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback)
        .trim();

    let mut normalized = leaf
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();

    while normalized.contains("--") {
        normalized = normalized.replace("--", "-");
    }

    normalized = normalized.trim_matches('.').trim_matches('-').to_string();
    if normalized.is_empty() {
        return fallback.to_string();
    }

    if !normalized.contains('.') {
        normalized.push_str(".md");
    }

    normalized
}

fn write_step_draft(
    camp_dir: &Path,
    step: &DelegationStep,
    agent_id: &str,
    output_text: &str,
) -> Result<String, String> {
    fs::create_dir_all(team_drafts_dir(camp_dir))
        .map_err(|err| format!("Unable to create draft folder: {err}"))?;

    let default_name = format!("{}-{}.md", step.step_id, agent_id);
    let mut filename = sanitize_filename(&step.expected_output, &default_name);
    let mut target = team_drafts_dir(camp_dir).join(&filename);
    if target.exists() {
        filename = format!(
            "{}-{}.md",
            sanitize_filename(&step.step_id, "step").trim_end_matches(".md"),
            now_timestamp_ms()
        );
        target = team_drafts_dir(camp_dir).join(&filename);
    }

    fs::write(&target, output_text)
        .map_err(|err| format!("Unable to write draft artifact: {err}"))?;

    Ok(format!(
        "{}/{}/{}",
        TEAM_ARTIFACTS_DIR_NAME, TEAM_DRAFTS_DIR_NAME, filename
    ))
}

fn parse_agent_tools_file(camp_dir: &Path, agent: &TeamAgentConfig) -> Vec<String> {
    let tools_path = agent_tools_path(camp_dir, &agent.id);
    if !tools_path.exists() {
        return normalize_tool_subset(&agent.tool_subset);
    }

    match crate::read_json_file::<Vec<String>>(&tools_path) {
        Ok(values) => normalize_tool_subset(&values),
        Err(_) => normalize_tool_subset(&agent.tool_subset),
    }
}

fn find_agent<'a>(team_config: &'a TeamConfig, agent_id: &str) -> Option<&'a TeamAgentConfig> {
    team_config.agents.iter().find(|agent| agent.id == agent_id)
}

fn find_agent_by_role<'a>(
    team_config: &'a TeamConfig,
    role_name: &str,
) -> Option<&'a TeamAgentConfig> {
    team_config.agents.iter().find(|agent| {
        agent.role.eq_ignore_ascii_case(role_name) || agent.id.eq_ignore_ascii_case(role_name)
    })
}

fn parse_draft_path(camp_dir: &Path, artifact_path: &str) -> Result<PathBuf, String> {
    let trimmed = artifact_path.trim();
    if trimmed.is_empty() {
        return Err("artifact_path is required.".to_string());
    }

    let relative = if let Some(stripped) = trimmed.strip_prefix("artifacts/drafts/") {
        stripped
    } else if let Some(stripped) = trimmed.strip_prefix("artifacts\\drafts\\") {
        stripped
    } else {
        trimmed
    };

    let relative_path = validate_relative_path(relative, "artifact_path", false)?;
    let drafts_root = fs::canonicalize(team_drafts_dir(camp_dir))
        .map_err(|err| format!("Unable to resolve drafts folder: {err}"))?;
    let full_path = drafts_root.join(relative_path);
    let canonical = fs::canonicalize(&full_path)
        .map_err(|err| format!("Unable to resolve draft artifact path: {err}"))?;
    ensure_within_root(&drafts_root, &canonical)?;

    if !canonical.is_file() {
        return Err("artifact_path must point to a draft file.".to_string());
    }

    Ok(canonical)
}

fn unique_promoted_target(camp_dir: &Path, source_filename: &str) -> PathBuf {
    let promoted_dir = team_promoted_dir(camp_dir);
    let initial = promoted_dir.join(source_filename);
    if !initial.exists() {
        return initial;
    }

    let stem = Path::new(source_filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact");
    let extension = Path::new(source_filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    promoted_dir.join(format!("{}-{}.{}", stem, now_timestamp_ms(), extension))
}

fn move_draft_to_promoted(
    camp_dir: &Path,
    draft_full_path: &Path,
) -> Result<(String, String), String> {
    fs::create_dir_all(team_promoted_dir(camp_dir))
        .map_err(|err| format!("Unable to create promoted folder: {err}"))?;

    let drafts_root = fs::canonicalize(team_drafts_dir(camp_dir))
        .map_err(|err| format!("Unable to resolve drafts folder: {err}"))?;
    let source = fs::canonicalize(draft_full_path)
        .map_err(|err| format!("Unable to resolve draft artifact path: {err}"))?;
    ensure_within_root(&drafts_root, &source)?;

    let source_filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid draft filename.".to_string())?;

    let target = unique_promoted_target(camp_dir, source_filename);
    fs::rename(&source, &target).map_err(|err| format!("Unable to promote artifact: {err}"))?;

    let promoted_root = fs::canonicalize(team_promoted_dir(camp_dir))
        .map_err(|err| format!("Unable to resolve promoted folder: {err}"))?;
    let canonical_target = fs::canonicalize(&target)
        .map_err(|err| format!("Unable to resolve promoted artifact path: {err}"))?;
    ensure_within_root(&promoted_root, &canonical_target)?;

    let draft_relative = to_relative_display(&drafts_root, &source)?;
    let promoted_relative = to_relative_display(&promoted_root, &canonical_target)?;

    Ok((
        format!(
            "{}/{}/{}",
            TEAM_ARTIFACTS_DIR_NAME, TEAM_DRAFTS_DIR_NAME, draft_relative
        ),
        format!(
            "{}/{}/{}",
            TEAM_ARTIFACTS_DIR_NAME, TEAM_PROMOTED_DIR_NAME, promoted_relative
        ),
    ))
}

fn collect_files(root: &Path, current: &Path, out: &mut Vec<String>) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(current).map_err(|err| format!("Unable to read directory: {err}"))? {
        let entry = entry.map_err(|err| format!("Unable to read directory entry: {err}"))?;
        let path = entry.path();
        let canonical = fs::canonicalize(&path)
            .map_err(|err| format!("Unable to resolve artifact path: {err}"))?;
        ensure_within_root(root, &canonical)?;

        if canonical.is_dir() {
            collect_files(root, &canonical, out)?;
            continue;
        }

        if canonical.is_file() {
            out.push(to_relative_display(root, &canonical)?);
        }
    }

    Ok(())
}

fn preview_from_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        let normalized = text.replace('\n', " ").trim().to_string();
        if normalized.is_empty() {
            return None;
        }
        return Some(normalized.chars().take(200).collect());
    }

    if let Some(object) = content.as_object() {
        if let Some(output_text) = object.get("output_text").and_then(Value::as_str) {
            let normalized = output_text.replace('\n', " ").trim().to_string();
            if normalized.is_empty() {
                return None;
            }
            return Some(normalized.chars().take(200).collect());
        }
    }

    None
}

#[tauri::command]
pub fn create_team_agent(
    camp_id: String,
    agent_config: TeamAgentCreateInput,
    state: State<'_, AppState>,
) -> Result<AgentMeta, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let mut team_config = load_team_config(&camp_dir)?;

    let agent_id = validate_simple_identifier(&agent_config.id, "agent_config.id")?;
    if team_config.agents.len() >= TEAM_MAX_AGENTS
        && !team_config.agents.iter().any(|agent| agent.id == agent_id)
    {
        return Err(format!(
            "A team can have at most {TEAM_MAX_AGENTS} agents. Remove one before adding another."
        ));
    }

    let role = agent_config.role.trim();
    if role.is_empty() {
        return Err("agent_config.role is required.".to_string());
    }

    let model = agent_config.model.trim();
    if model.is_empty() {
        return Err("agent_config.model is required.".to_string());
    }

    let normalized = TeamAgentConfig {
        id: agent_id.clone(),
        role: role.to_string(),
        model: model.to_string(),
        tool_subset: normalize_tool_subset(&agent_config.tool_subset),
        description: agent_config.description.trim().to_string(),
    };

    if let Some(existing) = team_config
        .agents
        .iter_mut()
        .find(|agent| agent.id == agent_id)
    {
        *existing = normalized.clone();
    } else {
        team_config.agents.push(normalized.clone());
    }

    team_config
        .agents
        .sort_by(|left, right| left.id.to_lowercase().cmp(&right.id.to_lowercase()));

    save_team_config(&camp_dir, &team_config)?;
    ensure_agent_scaffold(&camp_dir, &normalized)?;

    Ok(AgentMeta {
        id: normalized.id.clone(),
        role: normalized.role.clone(),
        model: normalized.model.clone(),
        tool_subset: normalized.tool_subset.clone(),
        description: normalized.description.clone(),
        path: agent_dir(&camp_dir, &normalized.id)
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command]
pub fn remove_team_agent(
    camp_id: String,
    agent_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let mut team_config = load_team_config(&camp_dir)?;
    let normalized_id = validate_simple_identifier(&agent_id, "agent_id")?;

    let original_len = team_config.agents.len();
    team_config.agents.retain(|agent| agent.id != normalized_id);

    if team_config.agents.len() == original_len {
        return Err("Agent not found in team roster.".to_string());
    }

    let target_dir = agent_dir(&camp_dir, &normalized_id);
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir)
            .map_err(|err| format!("Unable to remove agent folder: {err}"))?;
    }

    save_team_config(&camp_dir, &team_config)
}

#[tauri::command]
pub fn update_team_settings(
    camp_id: String,
    settings: TeamSettingsUpdateInput,
    state: State<'_, AppState>,
) -> Result<TeamStatus, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let mut team_config = load_team_config(&camp_dir)?;

    let supervisor_model = settings.supervisor_model.trim();
    if supervisor_model.is_empty() {
        return Err("supervisor_model is required.".to_string());
    }

    team_config.supervisor_model = supervisor_model.to_string();
    team_config.reflection_loops = settings.reflection_loops;
    team_config.max_reflection_rounds = settings.max_reflection_rounds.clamp(1, 8);

    save_team_config(&camp_dir, &team_config)?;
    get_team_status(camp_id, state)
}

#[tauri::command]
pub async fn decompose_task(
    camp_id: String,
    user_task: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DecompositionPlan, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let team_config = load_team_config(&camp_dir)?;

    if team_config.agents.is_empty() {
        return Err("Team has no agents. Add at least one agent before decomposition.".to_string());
    }

    let user_task_trimmed = user_task.trim();
    if user_task_trimmed.is_empty() {
        return Err("user_task is required.".to_string());
    }

    let supervisor_prompt = fs::read_to_string(supervisor_prompt_path(&camp_dir))
        .unwrap_or_else(|_| default_supervisor_prompt());
    let agent_roster = render_agent_roster(&team_config);
    let rendered_prompt = supervisor_prompt.replace("{{agent_roster}}", &agent_roster);

    let message_payload = format!(
        "User task:\n{task}\n\nReturn ONLY valid JSON. Do not wrap in markdown fences.",
        task = user_task_trimmed
    );

    let response = run_chat_completion(
        state.inner(),
        &team_config.supervisor_model,
        vec![
            serde_json::json!({ "role": "system", "content": rendered_prompt }),
            serde_json::json!({ "role": "user", "content": message_payload }),
        ],
        None,
        Some(&camp_id),
    )
    .await?;

    let parsed: DecompositionPlan = parse_json_from_output(&response.output_text)?;
    let plan = validate_decomposition_plan(&team_config, parsed)?;

    let decomposition_entry = make_bus_entry(
        BusEntryType::Decomposition,
        "supervisor",
        "all",
        None,
        serde_json::to_value(&plan).map_err(|err| format!("Unable to serialize plan: {err}"))?,
        usage_to_bus(&response.usage),
    );
    append_team_bus_entry(&camp_dir, &decomposition_entry, Some(&app))?;

    for step in &plan.steps {
        let delegation_entry = make_bus_entry(
            BusEntryType::Delegation,
            "supervisor",
            &step.assigned_to,
            Some(&step.step_id),
            serde_json::json!({
                "instruction": step.instruction,
                "depends_on": step.depends_on,
                "expected_output": step.expected_output,
            }),
            BusTokenUsage::default(),
        );
        append_team_bus_entry(&camp_dir, &delegation_entry, Some(&app))?;
    }

    Ok(plan)
}

#[tauri::command]
pub async fn execute_agent_step(
    camp_id: String,
    agent_id: String,
    step: DelegationStep,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<AgentStepResult, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let team_config = load_team_config(&camp_dir)?;

    let normalized_agent_id = validate_simple_identifier(&agent_id, "agent_id")?;
    let agent = find_agent(&team_config, &normalized_agent_id)
        .ok_or_else(|| "Agent not found in team roster.".to_string())?;

    if step.assigned_to != normalized_agent_id {
        return Err("Requested agent does not match step.assigned_to.".to_string());
    }

    let step_id = validate_simple_identifier(&step.step_id, "step.step_id")?;
    let prompt = fs::read_to_string(agent_prompt_path(&camp_dir, &agent.id))
        .unwrap_or_else(|_| default_agent_prompt(agent));
    let tool_subset = parse_agent_tools_file(&camp_dir, agent);
    let context_root = agent_context_root(&camp_dir, &agent.id)?;

    let user_instruction = format!(
        "Delegation step id: {step_id}\nAssigned role: {role}\n\nInstruction:\n{instruction}\n\nDependencies: {depends_on}\n\nExpected output:\n{expected_output}\n\nWhen complete, provide the final result text for this step.",
        step_id = step_id,
        role = agent.role,
        instruction = step.instruction.trim(),
        depends_on = if step.depends_on.is_empty() {
            "none".to_string()
        } else {
            step.depends_on.join(", ")
        },
        expected_output = step.expected_output.trim(),
    );

    let run_output = run_agent_inference_loop(
        state.inner(),
        &camp_id,
        &agent.model,
        vec![
            serde_json::json!({ "role": "system", "content": prompt }),
            serde_json::json!({ "role": "user", "content": user_instruction }),
        ],
        &tool_subset,
        &context_root,
    )
    .await?;

    let draft_path = write_step_draft(&camp_dir, &step, &agent.id, &run_output.output_text)?;

    let result = AgentStepResult {
        step_id: step_id.clone(),
        agent_id: agent.id.clone(),
        output_text: run_output.output_text.clone(),
        draft_path: draft_path.clone(),
        context_writes: run_output.context_writes.clone(),
        token_usage: run_output.token_usage.clone(),
    };

    let bus_entry = make_bus_entry(
        BusEntryType::Result,
        &agent.id,
        "supervisor",
        Some(&step_id),
        serde_json::json!({
            "output_text": run_output.output_text,
            "draft_path": draft_path,
            "context_writes": run_output.context_writes,
        }),
        run_output.token_usage,
    );
    append_team_bus_entry(&camp_dir, &bus_entry, Some(&app))?;

    let _ = app.emit("team://step_complete", result.clone());
    let _ = crate::touch_camp_updated_at(&camp_dir);

    Ok(result)
}

async fn run_agent_single_prompt(
    state: &AppState,
    camp_id: &str,
    model_reference: &str,
    system_prompt: String,
    user_prompt: String,
) -> Result<(String, BusTokenUsage), String> {
    let response = run_chat_completion(
        state,
        model_reference,
        vec![
            serde_json::json!({ "role": "system", "content": system_prompt }),
            serde_json::json!({ "role": "user", "content": user_prompt }),
        ],
        None,
        Some(camp_id),
    )
    .await?;

    Ok((
        response.output_text.trim().to_string(),
        usage_to_bus(&response.usage),
    ))
}

#[tauri::command]
pub async fn run_reflection_loop(
    camp_id: String,
    artifact_path: String,
    rounds: u8,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ReflectionSummary, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let team_config = load_team_config(&camp_dir)?;

    let writer = find_agent_by_role(&team_config, "writer").ok_or_else(|| {
        "Team is missing a Writer agent required for reflection loop.".to_string()
    })?;
    let critic = find_agent_by_role(&team_config, "critic").ok_or_else(|| {
        "Team is missing a Critic agent required for reflection loop.".to_string()
    })?;

    let max_rounds = team_config.max_reflection_rounds.max(1);
    let requested_rounds = if rounds == 0 {
        max_rounds
    } else {
        rounds.min(max_rounds)
    };

    let draft_path = parse_draft_path(&camp_dir, &artifact_path)?;
    let mut artifact_body = fs::read_to_string(&draft_path)
        .map_err(|err| format!("Unable to read draft artifact: {err}"))?;

    let writer_prompt = fs::read_to_string(agent_prompt_path(&camp_dir, &writer.id))
        .unwrap_or_else(|_| default_agent_prompt(writer));
    let critic_prompt = fs::read_to_string(agent_prompt_path(&camp_dir, &critic.id))
        .unwrap_or_else(|_| default_agent_prompt(critic));

    let mut critiques = Vec::new();
    let mut pass = false;
    let mut rounds_completed: u8 = 0;

    for round in 1..=requested_rounds {
        rounds_completed = round;

        let critic_request = format!(
            "Review this artifact. Output structured critique as JSON with fields: issues: string[], suggestions: string[], pass: boolean.\n\nArtifact:\n\n{}",
            artifact_body
        );
        let (critique_raw, critique_usage) = run_agent_single_prompt(
            state.inner(),
            &camp_id,
            &critic.model,
            critic_prompt.clone(),
            critic_request,
        )
        .await?;

        let critique = parse_json_from_output::<CritiqueResult>(&critique_raw)?;
        critiques.push(critique.clone());

        let critique_entry = make_bus_entry(
            BusEntryType::Critique,
            &critic.id,
            "supervisor",
            None,
            serde_json::json!({
                "round": round,
                "issues": critique.issues,
                "suggestions": critique.suggestions,
                "pass": critique.pass,
            }),
            critique_usage,
        );
        append_team_bus_entry(&camp_dir, &critique_entry, Some(&app))?;

        let _ = app.emit(
            "team://reflection_round",
            serde_json::json!({
                "round": round,
                "artifact_path": artifact_path,
                "critique": critique,
            }),
        );

        if critique.pass {
            pass = true;
            break;
        }

        if !team_config.reflection_loops || round >= requested_rounds {
            break;
        }

        let writer_request = format!(
            "Revise this artifact based on the critique. Output only the revised artifact text.\n\nCurrent artifact:\n\n{artifact}\n\nCritique JSON:\n{critique}",
            artifact = artifact_body,
            critique = serde_json::to_string_pretty(&critiques.last()).unwrap_or_else(|_| "{}".to_string())
        );

        let (writer_output, writer_usage) = run_agent_single_prompt(
            state.inner(),
            &camp_id,
            &writer.model,
            writer_prompt.clone(),
            writer_request,
        )
        .await?;

        artifact_body = writer_output.clone();
        fs::write(&draft_path, &artifact_body)
            .map_err(|err| format!("Unable to update draft during reflection: {err}"))?;

        let writer_entry = make_bus_entry(
            BusEntryType::Result,
            &writer.id,
            &critic.id,
            None,
            serde_json::json!({
                "round": round,
                "artifact_path": artifact_path,
                "output_text": writer_output,
            }),
            writer_usage,
        );
        append_team_bus_entry(&camp_dir, &writer_entry, Some(&app))?;
    }

    let (from_path, promoted_path) = move_draft_to_promoted(&camp_dir, &draft_path)?;
    let promotion_entry = make_bus_entry(
        BusEntryType::Promotion,
        "supervisor",
        "all",
        None,
        serde_json::json!({
            "from": from_path,
            "to": promoted_path,
            "pass": pass,
            "rounds_completed": rounds_completed,
        }),
        BusTokenUsage::default(),
    );
    append_team_bus_entry(&camp_dir, &promotion_entry, Some(&app))?;

    let _ = app.emit(
        "team://artifact_promoted",
        serde_json::json!({
            "from": from_path,
            "to": promoted_path,
            "pass": pass,
            "rounds_completed": rounds_completed,
        }),
    );

    let _ = crate::touch_camp_updated_at(&camp_dir);

    Ok(ReflectionSummary {
        artifact_path: from_path,
        promoted_path,
        rounds_completed,
        pass,
        critiques,
    })
}

#[tauri::command]
pub fn get_team_bus(camp_id: String, state: State<'_, AppState>) -> Result<Vec<BusEntry>, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    load_team_config(&camp_dir)?;
    read_team_bus_entries(&camp_dir)
}

#[tauri::command]
pub fn promote_artifact(
    camp_id: String,
    draft_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    load_team_config(&camp_dir)?;

    let source = parse_draft_path(&camp_dir, &draft_path)?;
    let (from_path, promoted_path) = move_draft_to_promoted(&camp_dir, &source)?;

    let entry = make_bus_entry(
        BusEntryType::Promotion,
        "supervisor",
        "all",
        None,
        serde_json::json!({
            "from": from_path,
            "to": promoted_path,
        }),
        BusTokenUsage::default(),
    );
    append_team_bus_entry(&camp_dir, &entry, Some(&app))?;

    let _ = app.emit(
        "team://artifact_promoted",
        serde_json::json!({
            "from": from_path,
            "to": promoted_path,
        }),
    );

    let _ = crate::touch_camp_updated_at(&camp_dir);

    Ok(promoted_path)
}

#[tauri::command]
pub fn get_team_status(camp_id: String, state: State<'_, AppState>) -> Result<TeamStatus, String> {
    let camp_dir = resolve_camp_dir(&state, &camp_id)?;
    let camp_config = read_camp_config(&camp_dir)?;

    if !camp_config.is_team {
        return Ok(TeamStatus {
            is_team: false,
            supervisor_model: String::new(),
            reflection_loops: false,
            max_reflection_rounds: TEAM_DEFAULT_MAX_REFLECTION_ROUNDS,
            agents: Vec::new(),
            steps: Vec::new(),
            bus_entries: 0,
            artifacts: TeamArtifactsStatus::default(),
        });
    }

    let team_config = load_team_config(&camp_dir)?;
    let bus_entries = read_team_bus_entries(&camp_dir)?;

    let latest_plan = bus_entries
        .iter()
        .rev()
        .find(|entry| matches!(entry.entry_type, BusEntryType::Decomposition))
        .and_then(|entry| serde_json::from_value::<DecompositionPlan>(entry.content.clone()).ok());

    let mut step_status_map: HashMap<String, String> = HashMap::new();
    if let Some(plan) = &latest_plan {
        for step in &plan.steps {
            step_status_map.insert(step.step_id.clone(), "pending".to_string());
        }
    }

    let mut agent_usage = BTreeMap::<String, BusTokenUsage>::new();
    let mut agent_last_output = BTreeMap::<String, String>::new();

    for entry in &bus_entries {
        if entry.from != "supervisor" {
            let usage = agent_usage.entry(entry.from.clone()).or_default();
            usage.input += entry.token_usage.input;
            usage.output += entry.token_usage.output;

            if matches!(entry.entry_type, BusEntryType::Result) {
                if let Some(preview) = preview_from_content(&entry.content) {
                    agent_last_output.insert(entry.from.clone(), preview);
                }
            }
        }

        if let Some(step_id) = &entry.step_id {
            match entry.entry_type {
                BusEntryType::Delegation => {
                    step_status_map.insert(step_id.clone(), "running".to_string());
                }
                BusEntryType::Result => {
                    step_status_map.insert(step_id.clone(), "complete".to_string());
                }
                BusEntryType::Error => {
                    step_status_map.insert(step_id.clone(), "failed".to_string());
                }
                _ => {}
            }
        }
    }

    let mut steps = Vec::new();
    if let Some(plan) = latest_plan {
        for step in plan.steps {
            let status = step_status_map
                .get(&step.step_id)
                .cloned()
                .unwrap_or_else(|| "pending".to_string());
            steps.push(TeamStepStatus {
                step_id: step.step_id,
                assigned_to: step.assigned_to,
                expected_output: step.expected_output,
                status,
            });
        }
    }

    let mut agents = Vec::new();
    for agent in &team_config.agents {
        let usage = agent_usage.get(&agent.id).cloned().unwrap_or_default();
        let last_output_preview = agent_last_output.get(&agent.id).cloned();

        let status = if steps
            .iter()
            .any(|step| step.assigned_to == agent.id && step.status == "running")
        {
            "working"
        } else if bus_entries.iter().rev().any(|entry| {
            entry.from == agent.id && matches!(entry.entry_type, BusEntryType::Critique)
        }) {
            "reflecting"
        } else {
            "idle"
        };

        agents.push(TeamAgentStatus {
            id: agent.id.clone(),
            role: agent.role.clone(),
            model: agent.model.clone(),
            tool_subset: agent.tool_subset.clone(),
            status: status.to_string(),
            token_usage: usage,
            last_output_preview,
        });
    }

    let drafts_root = team_drafts_dir(&camp_dir);
    let promoted_root = team_promoted_dir(&camp_dir);
    let mut draft_files = Vec::new();
    let mut promoted_files = Vec::new();

    if drafts_root.exists() {
        let canonical = fs::canonicalize(&drafts_root)
            .map_err(|err| format!("Unable to resolve drafts folder: {err}"))?;
        collect_files(&canonical, &canonical, &mut draft_files)?;
    }

    if promoted_root.exists() {
        let canonical = fs::canonicalize(&promoted_root)
            .map_err(|err| format!("Unable to resolve promoted folder: {err}"))?;
        collect_files(&canonical, &canonical, &mut promoted_files)?;
    }

    draft_files.sort();
    promoted_files.sort();

    Ok(TeamStatus {
        is_team: true,
        supervisor_model: team_config.supervisor_model,
        reflection_loops: team_config.reflection_loops,
        max_reflection_rounds: team_config.max_reflection_rounds,
        agents,
        steps,
        bus_entries: bus_entries.len(),
        artifacts: TeamArtifactsStatus {
            drafts: draft_files,
            promoted: promoted_files,
        },
    })
}
