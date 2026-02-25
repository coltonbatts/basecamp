use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use keyring::{Entry, Error as KeyringError};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tauri::{App, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

mod inspect;

const KEYRING_SERVICE: &str = "com.basecamp.app";
const KEYRING_ACCOUNT: &str = "openrouter_api_key";
const DB_FILE_NAME: &str = "basecamp.db";
const SETTING_WORKSPACE_PATH: &str = "workspace_path";
const SETTING_TOOLS_ENABLED: &str = "tools_enabled";
const SETTING_DEFAULT_MODEL: &str = "default_model";
const SETTING_DEVELOPER_INSPECT: &str = "developer_inspect_mode";
const LEGACY_CAMP_SCHEMA_VERSION: &str = "0.0";
const CAMP_SCHEMA_VERSION: &str = "0.1";
const CAMPS_DIR_NAME: &str = "camps";
const WORKSPACE_CONTEXT_DIR: &str = "context";
const CAMP_CONFIG_FILE: &str = "camp.json";
const CAMP_SYSTEM_PROMPT_FILE: &str = "system_prompt.md";
const CAMP_MEMORY_FILE: &str = "memory.json";
const CAMP_TRANSCRIPT_FILE: &str = "transcript.jsonl";
const CAMP_CONTEXT_DIR: &str = "context";
const CAMP_ARTIFACTS_DIR: &str = "artifacts";
const CAMP_ARTIFACTS_INDEX_FILE: &str = "index.json";
const CAMP_ARTIFACTS_SCHEMA_VERSION: &str = "0.1";
const DEFAULT_CAMP_NAME: &str = "Untitled Camp";
const DEFAULT_CAMP_MODEL: &str = "openrouter/auto";

struct AppState {
    connection: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ModelRow {
    id: String,
    name: Option<String>,
    description: Option<String>,
    context_length: Option<i64>,
    pricing_json: Option<String>,
    raw_json: String,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Run {
    id: String,
    timestamp: i64,
    model: String,
    requested_model: String,
    resolved_model: Option<String>,
    system_prompt: String,
    user_prompt: String,
    temperature: f64,
    max_tokens: i64,
    request_json: String,
    response_json: String,
    output_text: String,
    latency_ms: i64,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
    error: Option<String>,
    rating: Option<i64>,
    tags: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolCallRow {
    id: String,
    run_id: String,
    step_index: i64,
    tool_name: String,
    args_json: String,
    result_json: Option<String>,
    error: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SearchRunsDbRow {
    id: String,
    timestamp: i64,
    requested_model: Option<String>,
    resolved_model: Option<String>,
    user_prompt: String,
    output_text: String,
    tags: Option<String>,
    rating: Option<i64>,
    latency_ms: Option<i64>,
    total_tokens: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WriteNoteResult {
    path: String,
    bytes_written: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct CampConfig {
    schema_version: String,
    id: String,
    name: String,
    model: String,
    #[serde(default = "default_tools_enabled")]
    tools_enabled: bool,
    created_at: i64,
    updated_at: i64,
}

fn default_tools_enabled() -> bool {
    false
}

#[derive(Debug, Serialize, Deserialize)]
struct CampSummary {
    id: String,
    name: String,
    model: String,
    updated_at: i64,
    path: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CampMessage {
    id: String,
    role: String,
    content: String,
    created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<CampToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    included_artifact_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CampToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CampToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    function: CampToolFunction,
}

#[derive(Debug, Serialize, Deserialize)]
struct Camp {
    config: CampConfig,
    system_prompt: String,
    memory: Value,
    transcript: Vec<CampMessage>,
    context_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CampArtifactMetadata {
    id: String,
    title: String,
    filename: String,
    source_message_id: String,
    source_role: String,
    tags: Vec<String>,
    created_at: i64,
    updated_at: i64,
    usage_count: i64,
    #[serde(default)]
    archived: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct CampArtifactsIndex {
    schema_version: String,
    artifacts: Vec<CampArtifactMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CampArtifact {
    metadata: CampArtifactMetadata,
    body: String,
}

#[derive(Debug, Deserialize)]
struct RunInsertPayload {
    id: String,
    timestamp: i64,
    model: String,
    requested_model: String,
    resolved_model: Option<String>,
    system_prompt: String,
    user_prompt: String,
    temperature: f64,
    max_tokens: i64,
    request_json: String,
    response_json: String,
    output_text: String,
    latency_ms: i64,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
    error: Option<String>,
    rating: Option<i64>,
    tags: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RunUpdatePayload {
    id: String,
    rating: Option<i64>,
    tags: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelRowPayload {
    id: String,
    name: Option<String>,
    description: Option<String>,
    context_length: Option<i64>,
    pricing_json: Option<String>,
    raw_json: String,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct ToolCallStartPayload {
    run_id: String,
    step_index: i64,
    tool_name: String,
    args_json: String,
    started_at: i64,
}

#[derive(Debug, Deserialize)]
struct SearchRunsDbArgs {
    query: String,
    limit: Option<i64>,
    model: Option<String>,
    tag: Option<String>,
    since_ts: Option<i64>,
    until_ts: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct WriteNotePayload {
    filename: String,
    title: Option<String>,
    body: String,
}

#[derive(Debug, Deserialize)]
struct CampCreatePayload {
    name: String,
    model: String,
    system_prompt: String,
    memory: Option<Value>,
    tools_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct CampUpdateConfigPayload {
    camp_id: String,
    name: String,
    model: String,
    tools_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct CampUpdateSystemPromptPayload {
    camp_id: String,
    system_prompt: String,
}

#[derive(Debug, Deserialize)]
struct CampUpdateMemoryPayload {
    camp_id: String,
    memory: Value,
}

#[derive(Debug, Deserialize)]
struct CampAppendMessagePayload {
    camp_id: String,
    role: String,
    content: String,
    name: Option<String>,
    tool_call_id: Option<String>,
    tool_calls: Option<Vec<CampToolCall>>,
    included_artifact_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct CampCreateArtifactFromMessagePayload {
    camp_id: String,
    message_id: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct CampUpdateArtifactPayload {
    camp_id: String,
    artifact_id: String,
    title: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct CampToggleArtifactArchivePayload {
    camp_id: String,
    artifact_id: String,
    archived: bool,
}

#[derive(Debug, Deserialize)]
struct InspectEmitEventPayload {
    camp_id: String,
    correlation_id: String,
    event_type: String,
    timestamp_ms: Option<i64>,
    duration_ms: Option<i64>,
    summary: String,
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct InspectWriteTurnPayload {
    camp_id: String,
    correlation_id: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct InspectCampFileMetaPayload {
    camp_id: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
struct InspectCampFileMeta {
    path: String,
    exists: bool,
    size_bytes: Option<u64>,
    modified_at_ms: Option<i64>,
    absolute_path: String,
}

fn map_model_row(row: &Row<'_>) -> rusqlite::Result<ModelRow> {
    Ok(ModelRow {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        context_length: row.get("context_length")?,
        pricing_json: row.get("pricing_json")?,
        raw_json: row.get("raw_json")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_run_row(row: &Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get("id")?,
        timestamp: row.get("timestamp")?,
        model: row.get("model")?,
        requested_model: row.get("requested_model")?,
        resolved_model: row.get("resolved_model")?,
        system_prompt: row.get("system_prompt")?,
        user_prompt: row.get("user_prompt")?,
        temperature: row.get("temperature")?,
        max_tokens: row.get("max_tokens")?,
        request_json: row.get("request_json")?,
        response_json: row.get("response_json")?,
        output_text: row.get("output_text")?,
        latency_ms: row.get("latency_ms")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
        total_tokens: row.get("total_tokens")?,
        error: row.get("error")?,
        rating: row.get("rating")?,
        tags: row.get("tags")?,
    })
}

fn map_tool_call_row(row: &Row<'_>) -> rusqlite::Result<ToolCallRow> {
    Ok(ToolCallRow {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        step_index: row.get("step_index")?,
        tool_name: row.get("tool_name")?,
        args_json: row.get("args_json")?,
        result_json: row.get("result_json")?,
        error: row.get("error")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
    })
}

fn map_search_runs_db_row(row: &Row<'_>) -> rusqlite::Result<SearchRunsDbRow> {
    Ok(SearchRunsDbRow {
        id: row.get("id")?,
        timestamp: row.get("timestamp")?,
        requested_model: row.get("requested_model")?,
        resolved_model: row.get("resolved_model")?,
        user_prompt: row.get("user_prompt")?,
        output_text: row.get("output_text")?,
        tags: row.get("tags")?,
        rating: row.get("rating")?,
        latency_ms: row.get("latency_ms")?,
        total_tokens: row.get("total_tokens")?,
    })
}

fn has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, rusqlite::Error> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut rows = statement.query([])?;

    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn migrate_runs_table(connection: &Connection) -> Result<(), rusqlite::Error> {
    if !has_column(connection, "runs", "requested_model")? {
        connection.execute("ALTER TABLE runs ADD COLUMN requested_model TEXT", [])?;
    }

    if !has_column(connection, "runs", "resolved_model")? {
        connection.execute("ALTER TABLE runs ADD COLUMN resolved_model TEXT", [])?;
    }

    connection.execute(
        "
    UPDATE runs
    SET requested_model = model
    WHERE requested_model IS NULL OR requested_model = ''
    ",
        [],
    )?;

    connection.execute(
        "
    UPDATE runs
    SET resolved_model = model
    WHERE resolved_model IS NULL OR resolved_model = ''
    ",
        [],
    )?;

    Ok(())
}

fn create_tables(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      model TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      system_prompt TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      temperature REAL NOT NULL,
      max_tokens INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      output_text TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      error TEXT,
      rating INTEGER,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      context_length INTEGER,
      pricing_json TEXT,
      raw_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_started_at ON tool_calls(started_at);
    ",
    )?;

    Ok(())
}

fn migrate_database(connection: &Connection) -> Result<(), rusqlite::Error> {
    migrate_runs_table(connection)?;
    Ok(())
}

fn init_database(app: &App) -> Result<Connection, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    let db_path = app_data_dir.join(DB_FILE_NAME);
    let connection = Connection::open(db_path)?;

    create_tables(&connection)?;
    migrate_database(&connection)?;

    Ok(connection)
}

fn set_setting_value(
    connection: &Connection,
    key: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    connection.execute(
        "
    INSERT INTO settings (key, value)
    VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ",
        params![key, value],
    )?;

    Ok(())
}

fn get_setting_value(
    connection: &Connection,
    key: &str,
) -> Result<Option<String>, rusqlite::Error> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
}

fn validate_workspace_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Workspace path cannot be empty.".to_string());
    }

    let workspace_path = PathBuf::from(trimmed);
    if !workspace_path.exists() {
        return Err("Workspace path does not exist.".to_string());
    }

    if !workspace_path.is_dir() {
        return Err("Workspace path must be a directory.".to_string());
    }

    fs::canonicalize(workspace_path)
        .map_err(|err| format!("Unable to resolve workspace path: {err}"))
}

fn validate_note_filename(filename: &str) -> Result<String, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return Err("filename is required.".to_string());
    }

    if trimmed.len() > 120 {
        return Err("filename must be 120 characters or less.".to_string());
    }

    if !trimmed.ends_with(".md") {
        return Err("filename must end with .md".to_string());
    }

    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("filename must not contain path separators or traversal segments.".to_string());
    }

    Ok(trimmed.to_string())
}

fn resolve_note_path(workspace_path: &Path, filename: &str) -> PathBuf {
    workspace_path.join(filename)
}

fn format_note_contents(title: Option<&str>, body: &str) -> String {
    let normalized_title = title.map(str::trim).filter(|value| !value.is_empty());

    match normalized_title {
        Some(title_text) => format!("# {title_text}\n\n{body}"),
        None => body.to_string(),
    }
}

fn now_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn require_workspace_path(connection: &Connection) -> Result<PathBuf, String> {
    let workspace_path_value = get_setting_value(connection, SETTING_WORKSPACE_PATH)
        .map_err(|err| format!("Unable to load workspace path: {err}"))?
        .ok_or_else(|| "Workspace folder is not set. Pick one in Settings first.".to_string())?;

    validate_workspace_path(&workspace_path_value)
}

fn default_workspace_path() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Basecamp");
    }

    if let Ok(cwd) = std::env::current_dir() {
        return cwd.join("Basecamp");
    }

    PathBuf::from("Basecamp")
}

fn ensure_camps_root(connection: &Connection) -> Result<PathBuf, String> {
    let workspace_path = require_workspace_path(connection)?;
    let camps_root = workspace_path.join(CAMPS_DIR_NAME);

    fs::create_dir_all(&camps_root)
        .map_err(|err| format!("Unable to create camps folder: {err}"))?;
    Ok(camps_root)
}

#[tauri::command]
fn ensure_default_workspace(state: State<'_, AppState>) -> Result<String, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    if let Some(saved_path) = get_setting_value(&connection, SETTING_WORKSPACE_PATH)
        .map_err(|err| format!("Unable to load workspace path: {err}"))?
    {
        if let Ok(valid) = validate_workspace_path(&saved_path) {
            return Ok(valid.to_string_lossy().into_owned());
        }
    }

    let default_path = default_workspace_path();
    fs::create_dir_all(&default_path)
        .map_err(|err| format!("Unable to create default Basecamp folder: {err}"))?;
    let validated_default = validate_workspace_path(default_path.to_string_lossy().as_ref())?;

    set_setting_value(
        &connection,
        SETTING_WORKSPACE_PATH,
        validated_default.to_string_lossy().as_ref(),
    )
    .map_err(|err| format!("Unable to save default workspace path: {err}"))?;

    Ok(validated_default.to_string_lossy().into_owned())
}

fn validate_camp_identifier(camp_id: &str) -> Result<String, String> {
    let trimmed = camp_id.trim();
    if trimmed.is_empty() {
        return Err("camp_id is required.".to_string());
    }

    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("camp_id must not contain path separators or traversal segments.".to_string());
    }

    Ok(trimmed.to_string())
}

fn resolve_existing_camp_dir(camps_root: &Path, camp_id: &str) -> Result<PathBuf, String> {
    let validated_id = validate_camp_identifier(camp_id)?;
    let camp_dir = camps_root.join(validated_id);

    if !camp_dir.exists() || !camp_dir.is_dir() {
        return Err("Camp not found.".to_string());
    }

    Ok(camp_dir)
}

fn camp_config_path(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_CONFIG_FILE)
}

fn camp_system_prompt_path(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_SYSTEM_PROMPT_FILE)
}

fn camp_memory_path(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_MEMORY_FILE)
}

fn camp_transcript_path(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_TRANSCRIPT_FILE)
}

fn camp_context_dir(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_CONTEXT_DIR)
}

fn workspace_context_dir(workspace_path: &Path) -> PathBuf {
    workspace_path.join(WORKSPACE_CONTEXT_DIR)
}

fn camp_artifacts_dir(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_ARTIFACTS_DIR)
}

fn camp_artifacts_index_path(camp_dir: &Path) -> PathBuf {
    camp_artifacts_dir(camp_dir).join(CAMP_ARTIFACTS_INDEX_FILE)
}

fn validate_context_relative_path(
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

fn validate_camp_relative_path(path: &str, field_name: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
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

fn canonicalize_context_root(context_dir: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(context_dir)
        .map_err(|err| format!("Unable to resolve camp context directory: {err}"))
}

fn ensure_path_within_root(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        return Ok(());
    }

    Err("Path escapes the camp context directory.".to_string())
}

fn resolve_existing_context_target(
    context_root: &Path,
    relative_path: &str,
    field_name: &str,
    allow_empty: bool,
) -> Result<PathBuf, String> {
    let relative = validate_context_relative_path(relative_path, field_name, allow_empty)?;
    let joined = context_root.join(relative);
    let canonical_target =
        fs::canonicalize(&joined).map_err(|err| format!("Unable to resolve path: {err}"))?;
    ensure_path_within_root(context_root, &canonical_target)?;
    Ok(canonical_target)
}

fn resolve_write_context_target(
    context_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = validate_context_relative_path(relative_path, "path", false)?;
    let target = context_root.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid path; parent directory is missing.".to_string())?;

    fs::create_dir_all(parent)
        .map_err(|err| format!("Unable to create parent directory: {err}"))?;

    let canonical_parent = fs::canonicalize(parent)
        .map_err(|err| format!("Unable to resolve parent directory: {err}"))?;
    ensure_path_within_root(context_root, &canonical_parent)?;

    Ok(target)
}

fn to_context_relative_display(context_root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(context_root)
        .map_err(|_| "Resolved path is not inside context root.".to_string())?;
    let mut display = relative.to_string_lossy().replace('\\', "/");

    if path.is_dir() && !display.is_empty() && !display.ends_with('/') {
        display.push('/');
    }

    Ok(display)
}

fn list_context_files_recursive(
    context_root: &Path,
    current_dir: &Path,
    entries: &mut Vec<String>,
) -> Result<(), String> {
    for entry_result in fs::read_dir(current_dir)
        .map_err(|err| format!("Unable to list context directory: {err}"))?
    {
        let entry = entry_result.map_err(|err| format!("Unable to read context entry: {err}"))?;
        let entry_path = entry.path();
        let canonical_entry = fs::canonicalize(&entry_path)
            .map_err(|err| format!("Unable to resolve context entry: {err}"))?;
        ensure_path_within_root(context_root, &canonical_entry)?;

        if canonical_entry.is_dir() {
            list_context_files_recursive(context_root, &canonical_entry, entries)?;
            continue;
        }

        if canonical_entry.is_file() {
            entries.push(to_context_relative_display(context_root, &canonical_entry)?);
        }
    }

    Ok(())
}

fn prune_empty_context_parents(context_root: &Path, start_dir: &Path) -> Result<(), String> {
    let mut current = start_dir.to_path_buf();

    while current != context_root {
        if !current.starts_with(context_root) {
            break;
        }

        let mut entries = fs::read_dir(&current)
            .map_err(|err| format!("Unable to inspect context directory: {err}"))?;
        if entries.next().is_some() {
            break;
        }

        fs::remove_dir(&current)
            .map_err(|err| format!("Unable to remove context directory: {err}"))?;

        let Some(parent) = current.parent() else {
            break;
        };

        current = parent.to_path_buf();
    }

    Ok(())
}

fn validate_identifier(value: &str, field_name: &str) -> Result<String, String> {
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

fn validate_artifact_filename(filename: &str) -> Result<String, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return Err("artifact filename is required.".to_string());
    }

    if !trimmed.ends_with(".md") {
        return Err("artifact filename must end with .md.".to_string());
    }

    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(
            "artifact filename must not contain path separators or traversal segments.".to_string(),
        );
    }

    Ok(trimmed.to_string())
}

fn normalize_artifact_tags(tags: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(ToString::to_string)
        .collect();
    normalized.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    normalized.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    normalized
}

fn sort_artifacts_for_write(artifacts: &mut [CampArtifactMetadata]) {
    artifacts.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn empty_artifacts_index() -> CampArtifactsIndex {
    CampArtifactsIndex {
        schema_version: CAMP_ARTIFACTS_SCHEMA_VERSION.to_string(),
        artifacts: Vec::new(),
    }
}

fn write_artifacts_index(camp_dir: &Path, index: &CampArtifactsIndex) -> Result<(), String> {
    let artifacts_dir = camp_artifacts_dir(camp_dir);
    fs::create_dir_all(&artifacts_dir)
        .map_err(|err| format!("Unable to create artifacts folder: {err}"))?;

    let mut normalized = CampArtifactsIndex {
        schema_version: CAMP_ARTIFACTS_SCHEMA_VERSION.to_string(),
        artifacts: index.artifacts.clone(),
    };
    sort_artifacts_for_write(&mut normalized.artifacts);
    for artifact in &mut normalized.artifacts {
        artifact.tags = normalize_artifact_tags(&artifact.tags);
    }

    write_json_file(&camp_artifacts_index_path(camp_dir), &normalized)
}

fn ensure_artifacts_index(camp_dir: &Path) -> Result<CampArtifactsIndex, String> {
    let index_path = camp_artifacts_index_path(camp_dir);
    if index_path.exists() {
        let mut index: CampArtifactsIndex = read_json_file(&index_path)?;
        if index.schema_version.trim().is_empty() {
            index.schema_version = CAMP_ARTIFACTS_SCHEMA_VERSION.to_string();
        }
        sort_artifacts_for_write(&mut index.artifacts);
        for artifact in &mut index.artifacts {
            artifact.tags = normalize_artifact_tags(&artifact.tags);
        }
        return Ok(index);
    }

    let index = empty_artifacts_index();
    write_artifacts_index(camp_dir, &index)?;
    Ok(index)
}

fn artifact_markdown_path(camp_dir: &Path, filename: &str) -> Result<PathBuf, String> {
    let validated_filename = validate_artifact_filename(filename)?;
    Ok(camp_artifacts_dir(camp_dir).join(validated_filename))
}

fn read_artifact_body(camp_dir: &Path, metadata: &CampArtifactMetadata) -> Result<String, String> {
    let path = artifact_markdown_path(camp_dir, &metadata.filename)?;
    read_text_file(&path)
}

fn write_artifact_body(
    camp_dir: &Path,
    metadata: &CampArtifactMetadata,
    body: &str,
) -> Result<(), String> {
    let path = artifact_markdown_path(camp_dir, &metadata.filename)?;
    fs::write(path, body).map_err(|err| format!("Unable to write artifact markdown: {err}"))
}

fn format_artifact_markdown(title: &str, body: &str) -> String {
    format!("# {}\n\n{}", title.trim(), body)
}

fn extract_default_artifact_title(content: &str, role: &str) -> String {
    let first_line = content
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .unwrap_or("");

    if !first_line.is_empty() {
        let truncated: String = first_line.chars().take(80).collect();
        return truncated;
    }

    format!("{} note", role.trim())
}

fn find_artifact_index_entry<'a>(
    index: &'a mut CampArtifactsIndex,
    artifact_id: &str,
) -> Result<&'a mut CampArtifactMetadata, String> {
    index
        .artifacts
        .iter_mut()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| "Artifact not found.".to_string())
}

fn parse_artifact_markdown(markdown: &str, fallback_title: &str) -> (String, String) {
    let trimmed = markdown.trim();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        let mut lines = rest.lines();
        let title = lines.next().unwrap_or("").trim();
        let body = lines
            .collect::<Vec<_>>()
            .join("\n")
            .trim_start()
            .to_string();

        if !title.is_empty() {
            return (title.to_string(), body);
        }
    }

    (fallback_title.to_string(), trimmed.to_string())
}

fn load_artifact(camp_dir: &Path, artifact_id: &str) -> Result<CampArtifact, String> {
    let validated_artifact_id = validate_identifier(artifact_id, "artifact_id")?;
    let mut index = ensure_artifacts_index(camp_dir)?;
    let metadata = find_artifact_index_entry(&mut index, &validated_artifact_id)?.clone();
    let body = read_artifact_body(camp_dir, &metadata)?;

    Ok(CampArtifact { metadata, body })
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Unable to serialize JSON: {err}"))?;
    fs::write(path, serialized)
        .map_err(|err| format!("Unable to write file {}: {err}", path.to_string_lossy()))
}

fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Unable to read file {}: {err}", path.to_string_lossy()))?;
    serde_json::from_str(&raw)
        .map_err(|err| format!("Unable to parse JSON {}: {err}", path.to_string_lossy()))
}

fn read_text_file(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|err| format!("Unable to read file {}: {err}", path.to_string_lossy()))
}

fn parse_non_empty_string_field(value: Option<&Value>) -> (Option<String>, bool) {
    let Some(raw_value) = value else {
        return (None, false);
    };

    match raw_value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return (None, true);
            }

            (Some(trimmed.to_string()), trimmed != text)
        }
        _ => (None, true),
    }
}

fn parse_bool_field(value: Option<&Value>) -> (Option<bool>, bool) {
    let Some(raw_value) = value else {
        return (None, false);
    };

    if let Some(parsed) = raw_value.as_bool() {
        return (Some(parsed), false);
    }

    if let Some(raw_text) = raw_value.as_str() {
        let trimmed = raw_text.trim().to_lowercase();
        if trimmed == "true" {
            return (Some(true), true);
        }
        if trimmed == "false" {
            return (Some(false), true);
        }
    }

    (None, true)
}

fn normalize_timestamp_ms(timestamp: i64) -> i64 {
    if (0..=9_999_999_999).contains(&timestamp) {
        timestamp.saturating_mul(1_000)
    } else {
        timestamp
    }
}

fn parse_timestamp_field(value: Option<&Value>) -> (Option<i64>, bool) {
    let Some(raw_value) = value else {
        return (None, false);
    };

    if let Some(parsed) = raw_value.as_i64() {
        let normalized = normalize_timestamp_ms(parsed);
        return (Some(normalized), normalized != parsed);
    }

    if let Some(parsed) = raw_value.as_u64() {
        let Ok(parsed_i64) = i64::try_from(parsed) else {
            return (None, true);
        };

        let normalized = normalize_timestamp_ms(parsed_i64);
        return (Some(normalized), normalized != parsed_i64);
    }

    if let Some(parsed) = raw_value.as_f64() {
        if !parsed.is_finite() || parsed.fract() != 0.0 {
            return (None, true);
        }

        let parsed_i64 = parsed as i64;
        let normalized = normalize_timestamp_ms(parsed_i64);
        return (Some(normalized), true);
    }

    if let Some(raw_text) = raw_value.as_str() {
        let trimmed = raw_text.trim();
        if trimmed.is_empty() {
            return (None, true);
        }

        if let Ok(parsed_i64) = trimmed.parse::<i64>() {
            let normalized = normalize_timestamp_ms(parsed_i64);
            return (Some(normalized), true);
        }
    }

    (None, true)
}

fn parse_string_list_field(value: Option<&Value>) -> Option<Vec<String>> {
    let array = value?.as_array()?;
    let mut normalized = Vec::new();

    for item in array {
        let Some(text) = item.as_str() else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }

        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }

    normalized.sort();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn parse_message_content_field(value: Option<&Value>) -> Option<String> {
    let raw_value = value?;

    match raw_value {
        Value::String(text) => Some(text.to_string()),
        Value::Array(parts) => {
            let mut normalized_parts = Vec::new();

            for part in parts {
                if let Some(text) = part.as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        normalized_parts.push(trimmed.to_string());
                    }
                    continue;
                }

                if let Some(object) = part.as_object() {
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            normalized_parts.push(trimmed.to_string());
                        }
                    }
                }
            }

            if normalized_parts.is_empty() {
                None
            } else {
                Some(normalized_parts.join("\n"))
            }
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn normalize_loaded_transcript_role(role_value: &str) -> Option<String> {
    let normalized = role_value.trim().to_lowercase();
    match normalized.as_str() {
        "system" => Some("system".to_string()),
        "user" | "human" => Some("user".to_string()),
        "assistant" | "model" | "bot" => Some("assistant".to_string()),
        "tool" | "function" => Some("tool".to_string()),
        _ => None,
    }
}

fn parse_tool_call_arguments(value: Option<&Value>) -> String {
    let Some(raw_value) = value else {
        return "{}".to_string();
    };

    match raw_value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                "{}".to_string()
            } else {
                trimmed.to_string()
            }
        }
        _ => serde_json::to_string(raw_value).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn parse_loaded_tool_calls(value: Option<&Value>, line_number: usize) -> Option<Vec<CampToolCall>> {
    let raw_value = value?;
    let raw_calls: Vec<&Value> = match raw_value {
        Value::Array(values) => values.iter().collect(),
        Value::Object(_) => vec![raw_value],
        _ => return None,
    };

    let mut parsed_calls = Vec::new();
    for (index, raw_call) in raw_calls.iter().enumerate() {
        let Some(call_object) = raw_call.as_object() else {
            continue;
        };

        let fallback_call_id = format!("legacy-tool-call-{}-{}", line_number + 1, index + 1);
        let call_id = parse_non_empty_string_field(
            call_object
                .get("id")
                .or_else(|| call_object.get("tool_call_id"))
                .or_else(|| call_object.get("call_id")),
        )
        .0
        .unwrap_or(fallback_call_id);

        let function_object = call_object.get("function").and_then(Value::as_object);
        let function_name = parse_non_empty_string_field(
            function_object
                .and_then(|function| function.get("name"))
                .or_else(|| call_object.get("name")),
        )
        .0;

        let Some(function_name) = function_name else {
            continue;
        };

        let function_arguments = parse_tool_call_arguments(
            function_object
                .and_then(|function| function.get("arguments"))
                .or_else(|| call_object.get("arguments")),
        );

        parsed_calls.push(CampToolCall {
            id: call_id,
            kind: "function".to_string(),
            function: CampToolFunction {
                name: function_name,
                arguments: function_arguments,
            },
        });
    }

    if parsed_calls.is_empty() {
        None
    } else {
        Some(parsed_calls)
    }
}

fn parse_loaded_transcript_message(
    value: &Value,
    line_number: usize,
) -> Result<CampMessage, String> {
    let Some(message_object) = value.as_object() else {
        return Err("Transcript entry must be a JSON object.".to_string());
    };

    let role_source = parse_non_empty_string_field(message_object.get("role"))
        .0
        .or_else(|| parse_non_empty_string_field(message_object.get("sender")).0)
        .unwrap_or_else(|| {
            if message_object.contains_key("tool_call_id")
                || message_object.contains_key("tool_name")
                || message_object.contains_key("call_id")
            {
                "tool".to_string()
            } else {
                "assistant".to_string()
            }
        });

    let role = normalize_loaded_transcript_role(&role_source).ok_or_else(|| {
        format!(
            "Unsupported transcript role `{}` at line {}.",
            role_source,
            line_number + 1
        )
    })?;

    let tool_calls = if role == "assistant" {
        parse_loaded_tool_calls(message_object.get("tool_calls"), line_number)
    } else {
        None
    };

    let content = parse_message_content_field(message_object.get("content"))
        .or_else(|| parse_message_content_field(message_object.get("message")))
        .unwrap_or_default();
    let trimmed_content = content.trim().to_string();
    let normalized_content =
        normalize_message_content(&role, &trimmed_content, tool_calls.is_some())
            .unwrap_or(trimmed_content);

    let message_id = parse_non_empty_string_field(message_object.get("id"))
        .0
        .or_else(|| parse_non_empty_string_field(message_object.get("message_id")).0)
        .unwrap_or_else(|| format!("legacy-message-{}", line_number + 1));

    let created_at = parse_timestamp_field(message_object.get("created_at"))
        .0
        .or_else(|| parse_timestamp_field(message_object.get("timestamp")).0)
        .or_else(|| parse_timestamp_field(message_object.get("ts")).0)
        .unwrap_or((line_number + 1) as i64);

    let name = if role == "tool" {
        parse_non_empty_string_field(
            message_object
                .get("name")
                .or_else(|| message_object.get("tool_name")),
        )
        .0
    } else {
        None
    };

    let tool_call_id = if role == "tool" {
        parse_non_empty_string_field(
            message_object
                .get("tool_call_id")
                .or_else(|| message_object.get("call_id")),
        )
        .0
    } else {
        None
    };

    let included_artifact_ids = parse_string_list_field(
        message_object
            .get("included_artifact_ids")
            .or_else(|| message_object.get("artifact_ids")),
    );

    Ok(CampMessage {
        id: message_id,
        role,
        content: normalized_content,
        created_at,
        name,
        tool_call_id,
        tool_calls,
        included_artifact_ids,
    })
}

fn parse_camp_config_from_json(
    camp_dir: &Path,
    raw_value: Value,
) -> Result<(CampConfig, bool), String> {
    let Some(config_object) = raw_value.as_object() else {
        return Err("camp.json must be a JSON object.".to_string());
    };

    let mut migrated = false;

    let schema_version = parse_non_empty_string_field(config_object.get("schema_version")).0;
    match schema_version.as_deref() {
        Some(CAMP_SCHEMA_VERSION) => {}
        Some(LEGACY_CAMP_SCHEMA_VERSION) | None => {
            migrated = true;
        }
        Some(other) => {
            return Err(format!(
                "Unsupported camp schema_version `{other}`. Supported versions: {LEGACY_CAMP_SCHEMA_VERSION}, {CAMP_SCHEMA_VERSION}."
            ));
        }
    }

    let fallback_id = camp_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Unable to derive camp id from folder name.".to_string())
        .and_then(validate_camp_identifier)?;

    let (id_value, id_migrated) = parse_non_empty_string_field(config_object.get("id"));
    migrated |= id_migrated;
    let id = match id_value {
        Some(raw_id) => {
            let validated = validate_camp_identifier(&raw_id)?;
            if validated != raw_id {
                migrated = true;
            }
            validated
        }
        None => {
            migrated = true;
            fallback_id
        }
    };

    let (name_value, name_migrated) = parse_non_empty_string_field(config_object.get("name"));
    migrated |= name_migrated;
    let name = match name_value {
        Some(value) => value,
        None => {
            migrated = true;
            DEFAULT_CAMP_NAME.to_string()
        }
    };

    let (model_value, model_migrated) = parse_non_empty_string_field(config_object.get("model"));
    migrated |= model_migrated;
    let model = match model_value {
        Some(value) => value,
        None => {
            migrated = true;
            DEFAULT_CAMP_MODEL.to_string()
        }
    };

    let (tools_enabled_value, tools_enabled_migrated) =
        parse_bool_field(config_object.get("tools_enabled"));
    migrated |= tools_enabled_migrated;
    let tools_enabled = match tools_enabled_value {
        Some(value) => value,
        None => {
            migrated = true;
            default_tools_enabled()
        }
    };

    let (created_at_value, created_at_migrated) =
        parse_timestamp_field(config_object.get("created_at"));
    migrated |= created_at_migrated;
    let (updated_at_value, updated_at_migrated) =
        parse_timestamp_field(config_object.get("updated_at"));
    migrated |= updated_at_migrated;

    let now = now_timestamp_ms();
    let created_at = match created_at_value {
        Some(value) => value,
        None => {
            migrated = true;
            updated_at_value.unwrap_or(now)
        }
    };

    let mut updated_at = match updated_at_value {
        Some(value) => value,
        None => {
            migrated = true;
            created_at
        }
    };

    if updated_at < created_at {
        updated_at = created_at;
        migrated = true;
    }

    Ok((
        CampConfig {
            schema_version: CAMP_SCHEMA_VERSION.to_string(),
            id,
            name,
            model,
            tools_enabled,
            created_at,
            updated_at,
        },
        migrated,
    ))
}

fn read_transcript(path: &Path) -> Result<Vec<CampMessage>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let file = fs::File::open(path).map_err(|err| format!("Unable to open transcript: {err}"))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for (line_number, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|err| format!("Unable to read transcript line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let parsed_value: Value = serde_json::from_str(trimmed).map_err(|err| {
            format!(
                "Unable to parse transcript entry at line {}: {err}",
                line_number + 1
            )
        })?;

        let parsed =
            parse_loaded_transcript_message(&parsed_value, line_number).map_err(|err| {
                format!(
                    "Unable to normalize transcript entry at line {}: {err}",
                    line_number + 1
                )
            })?;
        messages.push(parsed);
    }

    Ok(messages)
}

fn append_transcript_message(path: &Path, message: &CampMessage) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("Unable to open transcript for append: {err}"))?;

    let serialized = serde_json::to_string(message)
        .map_err(|err| format!("Unable to serialize message: {err}"))?;
    file.write_all(serialized.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("Unable to append transcript message: {err}"))
}

fn read_camp_config(camp_dir: &Path) -> Result<CampConfig, String> {
    let config_path = camp_config_path(camp_dir);
    let raw = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Unable to read file {}: {err}",
            config_path.to_string_lossy()
        )
    })?;
    let parsed_value: Value = serde_json::from_str(&raw).map_err(|err| {
        format!(
            "Unable to parse JSON {}: {err}",
            config_path.to_string_lossy()
        )
    })?;

    let (config, migrated) = parse_camp_config_from_json(camp_dir, parsed_value)?;
    if migrated {
        write_json_file(&config_path, &config)?;
    }

    Ok(config)
}

fn write_camp_config(camp_dir: &Path, config: &CampConfig) -> Result<(), String> {
    write_json_file(&camp_config_path(camp_dir), config)
}

fn touch_camp_updated_at(camp_dir: &Path) -> Result<(), String> {
    let mut config = read_camp_config(camp_dir)?;
    config.updated_at = now_timestamp_ms();
    write_camp_config(camp_dir, &config)
}

fn validate_non_empty(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} cannot be empty."));
    }
    Ok(trimmed.to_string())
}

fn validate_camp_role(role: &str) -> Result<String, String> {
    let normalized = role.trim().to_lowercase();
    match normalized.as_str() {
        "system" | "user" | "assistant" | "tool" => Ok(normalized),
        _ => Err("role must be one of: system, user, assistant, tool.".to_string()),
    }
}

fn normalize_message_content(
    role: &str,
    content: &str,
    has_tool_calls: bool,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        if role == "assistant" && has_tool_calls {
            return Ok(String::new());
        }

        return Err("content cannot be empty.".to_string());
    }

    Ok(trimmed.to_string())
}

fn normalize_camp_tool_calls(
    role: &str,
    tool_calls: Option<Vec<CampToolCall>>,
) -> Result<Option<Vec<CampToolCall>>, String> {
    let Some(calls) = tool_calls else {
        return Ok(None);
    };

    if role != "assistant" {
        return Err("tool_calls are only allowed for assistant messages.".to_string());
    }

    if calls.is_empty() {
        return Err("tool_calls cannot be empty when provided.".to_string());
    }

    let mut normalized = Vec::with_capacity(calls.len());
    for call in calls {
        let id = validate_non_empty(&call.id, "tool_call id")?;
        if call.kind.trim() != "function" {
            return Err("tool_call type must be function.".to_string());
        }
        let function_name = validate_non_empty(&call.function.name, "tool function name")?;
        let function_arguments = call.function.arguments.trim();
        if function_arguments.is_empty() {
            return Err("tool function arguments must be a JSON string.".to_string());
        }

        normalized.push(CampToolCall {
            id,
            kind: "function".to_string(),
            function: CampToolFunction {
                name: function_name,
                arguments: function_arguments.to_string(),
            },
        });
    }

    Ok(Some(normalized))
}

fn normalize_tool_message_name(role: &str, name: Option<String>) -> Result<Option<String>, String> {
    if role != "tool" {
        if name.is_some() {
            return Err("name is only allowed for tool messages.".to_string());
        }
        return Ok(None);
    }

    let value = name.ok_or_else(|| "name is required for tool messages.".to_string())?;
    Ok(Some(validate_non_empty(&value, "name")?))
}

fn normalize_tool_message_call_id(
    role: &str,
    tool_call_id: Option<String>,
) -> Result<Option<String>, String> {
    if role != "tool" {
        if tool_call_id.is_some() {
            return Err("tool_call_id is only allowed for tool messages.".to_string());
        }
        return Ok(None);
    }

    let value =
        tool_call_id.ok_or_else(|| "tool_call_id is required for tool messages.".to_string())?;
    Ok(Some(validate_non_empty(&value, "tool_call_id")?))
}

fn normalize_included_artifact_ids(
    artifact_ids: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, String> {
    let Some(ids) = artifact_ids else {
        return Ok(None);
    };

    let mut normalized = Vec::new();
    for id in ids {
        let validated = validate_identifier(&id, "artifact_id")?;
        if !normalized.iter().any(|existing| existing == &validated) {
            normalized.push(validated);
        }
    }

    normalized.sort();

    if normalized.is_empty() {
        Ok(None)
    } else {
        Ok(Some(normalized))
    }
}

fn load_camp_from_dir(camp_dir: &Path) -> Result<Camp, String> {
    let config = read_camp_config(camp_dir)?;
    let system_prompt = read_text_file(&camp_system_prompt_path(camp_dir))?;
    let memory: Value = read_json_file(&camp_memory_path(camp_dir))?;
    let transcript = read_transcript(&camp_transcript_path(camp_dir))?;
    let context_path = camp_context_dir(camp_dir).to_string_lossy().into_owned();

    Ok(Camp {
        config,
        system_prompt,
        memory,
        transcript,
        context_path,
    })
}

fn insert_tool_call_start_db(
    connection: &Connection,
    payload: &ToolCallStartPayload,
) -> Result<String, rusqlite::Error> {
    let tool_call_id = Uuid::new_v4().to_string();

    connection.execute(
        "
    INSERT INTO tool_calls (
      id,
      run_id,
      step_index,
      tool_name,
      args_json,
      started_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ",
        params![
            tool_call_id,
            payload.run_id,
            payload.step_index,
            payload.tool_name,
            payload.args_json,
            payload.started_at
        ],
    )?;

    Ok(tool_call_id)
}

fn update_tool_call_result_db(
    connection: &Connection,
    tool_call_id: &str,
    result_json: &str,
    finished_at: i64,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "
      UPDATE tool_calls
      SET result_json = ?2, error = NULL, finished_at = ?3
      WHERE id = ?1
      ",
            params![tool_call_id, result_json, finished_at],
        )
        .map_err(|err| format!("Unable to update tool call result: {err}"))?;

    if changed == 0 {
        return Err("Tool call row not found.".to_string());
    }

    Ok(())
}

fn update_tool_call_error_db(
    connection: &Connection,
    tool_call_id: &str,
    error: &str,
    finished_at: i64,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "
      UPDATE tool_calls
      SET error = ?2, result_json = NULL, finished_at = ?3
      WHERE id = ?1
      ",
            params![tool_call_id, error, finished_at],
        )
        .map_err(|err| format!("Unable to update tool call error: {err}"))?;

    if changed == 0 {
        return Err("Tool call row not found.".to_string());
    }

    Ok(())
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|err| format!("Keyring entry error: {err}"))
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    let entry = keyring_entry()?;
    entry
        .set_password(trimmed)
        .map_err(|err| format!("Unable to save API key: {err}"))
}

#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;

    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("Unable to read API key: {err}")),
    }
}

#[tauri::command]
fn has_api_key() -> Result<bool, String> {
    Ok(get_api_key()?.is_some())
}

#[tauri::command]
fn insert_run(state: State<'_, AppState>, payload: RunInsertPayload) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    connection
        .execute(
            "
      INSERT INTO runs (
        id,
        timestamp,
        model,
        requested_model,
        resolved_model,
        system_prompt,
        user_prompt,
        temperature,
        max_tokens,
        request_json,
        response_json,
        output_text,
        latency_ms,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        error,
        rating,
        tags
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
      ",
            params![
                payload.id,
                payload.timestamp,
                payload.model,
                payload.requested_model,
                payload.resolved_model,
                payload.system_prompt,
                payload.user_prompt,
                payload.temperature,
                payload.max_tokens,
                payload.request_json,
                payload.response_json,
                payload.output_text,
                payload.latency_ms,
                payload.prompt_tokens,
                payload.completion_tokens,
                payload.total_tokens,
                payload.error,
                payload.rating,
                payload.tags,
            ],
        )
        .map_err(|err| format!("Unable to insert run: {err}"))?;

    Ok(())
}

#[tauri::command]
fn list_runs(state: State<'_, AppState>) -> Result<Vec<Run>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let mut statement = connection
        .prepare(
            "
      SELECT
        id,
        timestamp,
        model,
        COALESCE(requested_model, model) AS requested_model,
        COALESCE(resolved_model, model) AS resolved_model,
        system_prompt,
        user_prompt,
        temperature,
        max_tokens,
        request_json,
        response_json,
        output_text,
        latency_ms,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        error,
        rating,
        tags
      FROM runs
      ORDER BY timestamp DESC
      ",
        )
        .map_err(|err| format!("Unable to prepare list query: {err}"))?;

    let rows = statement
        .query_map([], map_run_row)
        .map_err(|err| format!("Unable to query runs: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Unable to map run rows: {err}"))
}

#[tauri::command]
fn get_run_by_id(state: State<'_, AppState>, id: String) -> Result<Option<Run>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    connection
        .query_row(
            "
      SELECT
        id,
        timestamp,
        model,
        COALESCE(requested_model, model) AS requested_model,
        COALESCE(resolved_model, model) AS resolved_model,
        system_prompt,
        user_prompt,
        temperature,
        max_tokens,
        request_json,
        response_json,
        output_text,
        latency_ms,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        error,
        rating,
        tags
      FROM runs
      WHERE id = ?1
      ",
            params![id],
            map_run_row,
        )
        .optional()
        .map_err(|err| format!("Unable to fetch run: {err}"))
}

#[tauri::command]
fn update_run_rating_and_tags(
    state: State<'_, AppState>,
    payload: RunUpdatePayload,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    connection
        .execute(
            "
      UPDATE runs
      SET rating = ?2, tags = ?3
      WHERE id = ?1
      ",
            params![payload.id, payload.rating, payload.tags],
        )
        .map_err(|err| format!("Unable to update run: {err}"))?;

    Ok(())
}

#[tauri::command]
fn db_upsert_models(
    state: State<'_, AppState>,
    models: Vec<ModelRowPayload>,
) -> Result<(), String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let transaction = connection
        .transaction()
        .map_err(|err| format!("Unable to start model transaction: {err}"))?;

    {
        let mut statement = transaction
            .prepare(
                "
        INSERT OR REPLACE INTO models (
          id,
          name,
          description,
          context_length,
          pricing_json,
          raw_json,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
            )
            .map_err(|err| format!("Unable to prepare model upsert statement: {err}"))?;

        for model in models {
            statement
                .execute(params![
                    model.id,
                    model.name,
                    model.description,
                    model.context_length,
                    model.pricing_json,
                    model.raw_json,
                    model.updated_at,
                ])
                .map_err(|err| format!("Unable to upsert model row: {err}"))?;
        }
    }

    transaction
        .commit()
        .map_err(|err| format!("Unable to commit model transaction: {err}"))?;

    Ok(())
}

#[tauri::command]
fn db_list_models(state: State<'_, AppState>) -> Result<Vec<ModelRow>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let mut statement = connection
        .prepare(
            "
      SELECT
        id,
        name,
        description,
        context_length,
        pricing_json,
        raw_json,
        updated_at
      FROM models
      ORDER BY LOWER(COALESCE(NULLIF(name, ''), id)) ASC, LOWER(id) ASC
      ",
        )
        .map_err(|err| format!("Unable to prepare model list query: {err}"))?;

    let rows = statement
        .query_map([], map_model_row)
        .map_err(|err| format!("Unable to query model rows: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Unable to map model rows: {err}"))
}

#[tauri::command]
fn db_get_models_last_sync(state: State<'_, AppState>) -> Result<Option<i64>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'models_last_sync'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Unable to get models last sync: {err}"))
}

#[tauri::command]
fn db_set_models_last_sync(state: State<'_, AppState>, ts_ms: i64) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    connection
        .execute(
            "
      INSERT INTO meta (key, value)
      VALUES ('models_last_sync', ?1)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      ",
            params![ts_ms],
        )
        .map_err(|err| format!("Unable to set models last sync: {err}"))?;

    Ok(())
}

#[tauri::command]
fn set_workspace_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let normalized_path = validate_workspace_path(&path)?;

    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    set_setting_value(
        &connection,
        SETTING_WORKSPACE_PATH,
        normalized_path.to_string_lossy().as_ref(),
    )
    .map_err(|err| format!("Unable to save workspace path: {err}"))
}

#[tauri::command]
fn get_workspace_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    get_setting_value(&connection, SETTING_WORKSPACE_PATH)
        .map_err(|err| format!("Unable to load workspace path: {err}"))
}

#[tauri::command]
async fn pick_workspace_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<Option<String>, String>>(1);

    app.dialog()
        .file()
        .set_title("Select Workspace Folder")
        .pick_folder(move |selected_folder| {
            let result = match selected_folder {
                None => Ok(None),
                Some(folder_path) => {
                    let resolved_path = folder_path
                        .into_path()
                        .map_err(|err| format!("Unable to resolve selected folder: {err}"));

                    match resolved_path {
                        Ok(path) => validate_workspace_path(path.to_string_lossy().as_ref()).map(
                            |validated_path| Some(validated_path.to_string_lossy().into_owned()),
                        ),
                        Err(err) => Err(err),
                    }
                }
            };

            let _ = tx.blocking_send(result);
        });

    match rx.recv().await {
        Some(result) => result,
        None => Err("Workspace folder picker was interrupted.".to_string()),
    }
}

#[tauri::command]
fn set_tools_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let value = if enabled { "1" } else { "0" };
    set_setting_value(&connection, SETTING_TOOLS_ENABLED, value)
        .map_err(|err| format!("Unable to save tools setting: {err}"))
}

#[tauri::command]
fn get_tools_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let value = get_setting_value(&connection, SETTING_TOOLS_ENABLED)
        .map_err(|err| format!("Unable to load tools setting: {err}"))?;

    Ok(match value.as_deref() {
        Some("0") => false,
        Some("false") => false,
        Some("FALSE") => false,
        _ => true,
    })
}

#[tauri::command]
fn set_default_model(state: State<'_, AppState>, model: String) -> Result<(), String> {
    let normalized_model = validate_non_empty(&model, "model")?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    set_setting_value(&connection, SETTING_DEFAULT_MODEL, &normalized_model)
        .map_err(|err| format!("Unable to save default model setting: {err}"))
}

#[tauri::command]
fn get_default_model(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    get_setting_value(&connection, SETTING_DEFAULT_MODEL)
        .map_err(|err| format!("Unable to load default model setting: {err}"))
}

fn parse_setting_bool(value: Option<String>, default_value: bool) -> bool {
    match value.as_deref() {
        Some("1") => true,
        Some("0") => false,
        Some(raw) if raw.eq_ignore_ascii_case("true") => true,
        Some(raw) if raw.eq_ignore_ascii_case("false") => false,
        Some(_) => default_value,
        None => default_value,
    }
}

fn get_developer_inspect_mode_db(connection: &Connection) -> Result<bool, String> {
    let value = get_setting_value(connection, SETTING_DEVELOPER_INSPECT)
        .map_err(|err| format!("Unable to load developer inspect setting: {err}"))?;
    Ok(parse_setting_bool(value, false))
}

#[tauri::command]
fn set_developer_inspect_mode(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let value = if enabled { "1" } else { "0" };
    set_setting_value(&connection, SETTING_DEVELOPER_INSPECT, value)
        .map_err(|err| format!("Unable to save developer inspect setting: {err}"))
}

#[tauri::command]
fn get_developer_inspect_mode(state: State<'_, AppState>) -> Result<bool, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    get_developer_inspect_mode_db(&connection)
}

fn resolve_camp_dir_for_inspect(connection: &Connection, camp_id: &str) -> Result<PathBuf, String> {
    let camps_root = ensure_camps_root(connection)?;
    resolve_existing_camp_dir(&camps_root, camp_id)
}

#[tauri::command]
fn inspect_emit_event(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    payload: InspectEmitEventPayload,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    if !get_developer_inspect_mode_db(&connection)? {
        return Ok(());
    }

    let camp_dir = resolve_camp_dir_for_inspect(&connection, &payload.camp_id)?;
    let event = inspect::InspectEventRecord {
        timestamp_ms: payload.timestamp_ms.unwrap_or_else(now_timestamp_ms),
        correlation_id: payload.correlation_id,
        event_type: payload.event_type,
        duration_ms: payload.duration_ms,
        summary: payload.summary,
        payload: payload.payload,
    };

    inspect::emit_event(Some(&app), &camp_dir, event)?;
    Ok(())
}

#[tauri::command]
fn inspect_write_turn_request(
    state: State<'_, AppState>,
    payload: InspectWriteTurnPayload,
) -> Result<String, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    if !get_developer_inspect_mode_db(&connection)? {
        return Ok(String::new());
    }

    let camp_dir = resolve_camp_dir_for_inspect(&connection, &payload.camp_id)?;
    let path =
        inspect::write_turn_request_file(&camp_dir, &payload.correlation_id, &payload.payload)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn inspect_write_turn_response(
    state: State<'_, AppState>,
    payload: InspectWriteTurnPayload,
) -> Result<String, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    if !get_developer_inspect_mode_db(&connection)? {
        return Ok(String::new());
    }

    let camp_dir = resolve_camp_dir_for_inspect(&connection, &payload.camp_id)?;
    let path =
        inspect::write_turn_response_file(&camp_dir, &payload.correlation_id, &payload.payload)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn inspect_write_turn_bundle(
    state: State<'_, AppState>,
    payload: InspectWriteTurnPayload,
) -> Result<String, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    if !get_developer_inspect_mode_db(&connection)? {
        return Ok(String::new());
    }

    let camp_dir = resolve_camp_dir_for_inspect(&connection, &payload.camp_id)?;
    let path =
        inspect::write_turn_bundle_file(&camp_dir, &payload.correlation_id, &payload.payload)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn inspect_read_turn_bundle(
    state: State<'_, AppState>,
    camp_id: String,
    correlation_id: String,
) -> Result<Value, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    if !get_developer_inspect_mode_db(&connection)? {
        return Ok(Value::Null);
    }

    let camp_dir = resolve_camp_dir_for_inspect(&connection, &camp_id)?;
    let path = inspect::turn_bundle_file_path(&camp_dir, &correlation_id);
    if !path.exists() {
        return Ok(Value::Null);
    }

    read_json_file(&path)
}

#[tauri::command]
fn inspect_stat_camp_file(
    state: State<'_, AppState>,
    payload: InspectCampFileMetaPayload,
) -> Result<InspectCampFileMeta, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camp_dir = resolve_camp_dir_for_inspect(&connection, &payload.camp_id)?;
    let relative = validate_camp_relative_path(&payload.relative_path, "relative_path")?;
    let target = camp_dir.join(&relative);
    let meta = inspect::collect_file_meta(&target);

    Ok(InspectCampFileMeta {
        path: relative.to_string_lossy().replace('\\', "/"),
        exists: meta.exists,
        size_bytes: meta.size_bytes,
        modified_at_ms: meta.modified_at_ms,
        absolute_path: meta.absolute_path,
    })
}

#[tauri::command]
fn insert_tool_call_start(
    state: State<'_, AppState>,
    payload: ToolCallStartPayload,
) -> Result<String, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    insert_tool_call_start_db(&connection, &payload)
        .map_err(|err| format!("Unable to insert tool call: {err}"))
}

#[tauri::command]
fn update_tool_call_result(
    state: State<'_, AppState>,
    tool_call_id: String,
    result_json: String,
    finished_at: i64,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    update_tool_call_result_db(&connection, &tool_call_id, &result_json, finished_at)
}

#[tauri::command]
fn update_tool_call_error(
    state: State<'_, AppState>,
    tool_call_id: String,
    error: String,
    finished_at: i64,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    update_tool_call_error_db(&connection, &tool_call_id, &error, finished_at)
}

#[tauri::command]
fn list_tool_calls_for_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Vec<ToolCallRow>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let mut statement = connection
        .prepare(
            "
      SELECT
        id,
        run_id,
        step_index,
        tool_name,
        args_json,
        result_json,
        error,
        started_at,
        finished_at
      FROM tool_calls
      WHERE run_id = ?1
      ORDER BY step_index ASC, started_at ASC
      ",
        )
        .map_err(|err| format!("Unable to prepare tool call query: {err}"))?;

    let rows = statement
        .query_map(params![run_id], map_tool_call_row)
        .map_err(|err| format!("Unable to query tool calls: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Unable to map tool call rows: {err}"))
}

#[tauri::command]
fn search_runs_db(
    state: State<'_, AppState>,
    args: SearchRunsDbArgs,
) -> Result<Vec<SearchRunsDbRow>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let normalized_query = args.query.trim();
    let query_pattern = format!("%{normalized_query}%");
    let model_pattern = args
        .model
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let tag_pattern = args
        .tag
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let limit = args.limit.unwrap_or(5).clamp(1, 20);

    let mut statement = connection
    .prepare(
      "
      SELECT
        id,
        timestamp,
        COALESCE(requested_model, model) AS requested_model,
        COALESCE(resolved_model, model) AS resolved_model,
        user_prompt,
        output_text,
        tags,
        rating,
        latency_ms,
        total_tokens
      FROM runs
      WHERE
        (user_prompt LIKE ?1 OR output_text LIKE ?1)
        AND (?2 IS NULL OR COALESCE(requested_model, model) LIKE ?2 OR COALESCE(resolved_model, model) LIKE ?2)
        AND (?3 IS NULL OR COALESCE(tags, '') LIKE ?3)
        AND (?4 IS NULL OR timestamp >= ?4)
        AND (?5 IS NULL OR timestamp <= ?5)
      ORDER BY timestamp DESC
      LIMIT ?6
      ",
    )
    .map_err(|err| format!("Unable to prepare search query: {err}"))?;

    let rows = statement
        .query_map(
            params![
                query_pattern,
                model_pattern,
                tag_pattern,
                args.since_ts,
                args.until_ts,
                limit
            ],
            map_search_runs_db_row,
        )
        .map_err(|err| format!("Unable to query run search results: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Unable to map run search rows: {err}"))
}

#[tauri::command]
fn write_note_to_workspace(
    state: State<'_, AppState>,
    payload: WriteNotePayload,
) -> Result<WriteNoteResult, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let workspace_path_value = get_setting_value(&connection, SETTING_WORKSPACE_PATH)
        .map_err(|err| format!("Unable to load workspace path: {err}"))?
        .ok_or_else(|| "Workspace folder is not set. Pick one in Settings first.".to_string())?;

    let workspace_path = validate_workspace_path(&workspace_path_value)?;
    let filename = validate_note_filename(&payload.filename)?;
    let note_path = resolve_note_path(&workspace_path, &filename);
    let contents = format_note_contents(payload.title.as_deref(), &payload.body);

    fs::write(&note_path, contents.as_bytes())
        .map_err(|err| format!("Unable to write note: {err}"))?;

    Ok(WriteNoteResult {
        path: note_path.to_string_lossy().into_owned(),
        bytes_written: contents.as_bytes().len(),
    })
}

#[tauri::command]
fn workspace_list_context_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let workspace_path = require_workspace_path(&connection)?;
    let workspace_context = workspace_context_dir(&workspace_path);

    fs::create_dir_all(&workspace_context)
        .map_err(|err| format!("Unable to create workspace context directory: {err}"))?;

    let context_root = fs::canonicalize(&workspace_context)
        .map_err(|err| format!("Unable to resolve workspace context directory: {err}"))?;

    let mut entries = Vec::new();
    list_context_files_recursive(&context_root, &context_root, &mut entries)?;
    entries.sort();

    Ok(entries)
}

#[tauri::command]
fn camp_attach_workspace_context_file(
    state: State<'_, AppState>,
    camp_id: String,
    path: String,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let workspace_path = require_workspace_path(&connection)?;
    let workspace_context = workspace_context_dir(&workspace_path);

    fs::create_dir_all(&workspace_context)
        .map_err(|err| format!("Unable to create workspace context directory: {err}"))?;

    let workspace_context_root = fs::canonicalize(&workspace_context)
        .map_err(|err| format!("Unable to resolve workspace context directory: {err}"))?;
    let source = resolve_existing_context_target(&workspace_context_root, &path, "path", false)?;

    if !source.is_file() {
        return Err("Requested path is not a file.".to_string());
    }

    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let camp_context_root = canonicalize_context_root(&camp_context_dir(&camp_dir))?;
    let destination = resolve_write_context_target(&camp_context_root, &path)?;

    fs::copy(&source, &destination)
        .map_err(|err| format!("Unable to attach context file to camp: {err}"))?;
    touch_camp_updated_at(&camp_dir)?;
    Ok(())
}

#[tauri::command]
fn camp_detach_workspace_context_file(
    state: State<'_, AppState>,
    camp_id: String,
    path: String,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let camp_context_root = canonicalize_context_root(&camp_context_dir(&camp_dir))?;

    let relative = validate_context_relative_path(&path, "path", false)?;
    let target = camp_context_root.join(relative);

    if !target.exists() {
        return Ok(());
    }

    let canonical_target =
        fs::canonicalize(&target).map_err(|err| format!("Unable to resolve path: {err}"))?;
    ensure_path_within_root(&camp_context_root, &canonical_target)?;

    if !canonical_target.is_file() {
        return Err("Requested path is not a file.".to_string());
    }

    fs::remove_file(&canonical_target)
        .map_err(|err| format!("Unable to detach context file from camp: {err}"))?;

    if let Some(parent) = canonical_target.parent() {
        prune_empty_context_parents(&camp_context_root, parent)?;
    }

    touch_camp_updated_at(&camp_dir)?;
    Ok(())
}

#[tauri::command]
fn tauri_cmd_read_context_file(
    state: State<'_, AppState>,
    camp_id: String,
    path: String,
) -> Result<String, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let context_root = canonicalize_context_root(&camp_context_dir(&camp_dir))?;
    let target = resolve_existing_context_target(&context_root, &path, "path", false)?;

    if !target.is_file() {
        return Err("Requested path is not a file.".to_string());
    }

    read_text_file(&target)
}

#[tauri::command]
fn tauri_cmd_list_context_files(
    state: State<'_, AppState>,
    camp_id: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let context_root = canonicalize_context_root(&camp_context_dir(&camp_dir))?;
    let path_value = path.unwrap_or_default();
    let target_dir = resolve_existing_context_target(&context_root, &path_value, "path", true)?;

    if !target_dir.is_dir() {
        return Err("Requested path is not a directory.".to_string());
    }

    let mut entries = Vec::new();
    for entry_result in fs::read_dir(&target_dir)
        .map_err(|err| format!("Unable to list context directory: {err}"))?
    {
        let entry = entry_result.map_err(|err| format!("Unable to read context entry: {err}"))?;
        let entry_path = entry.path();
        let canonical_entry = fs::canonicalize(&entry_path)
            .map_err(|err| format!("Unable to resolve context entry: {err}"))?;
        ensure_path_within_root(&context_root, &canonical_entry)?;
        let display = to_context_relative_display(&context_root, &canonical_entry)?;
        if !display.is_empty() {
            entries.push(display);
        }
    }

    entries.sort();
    Ok(entries)
}

#[tauri::command]
fn tauri_cmd_write_context_file(
    state: State<'_, AppState>,
    camp_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let context_root = canonicalize_context_root(&camp_context_dir(&camp_dir))?;
    let target = resolve_write_context_target(&context_root, &path)?;

    if target.exists() {
        let canonical_target = fs::canonicalize(&target)
            .map_err(|err| format!("Unable to resolve destination path: {err}"))?;
        ensure_path_within_root(&context_root, &canonical_target)?;
        if canonical_target.is_dir() {
            return Err("Requested path is a directory.".to_string());
        }
    }

    fs::write(&target, content).map_err(|err| format!("Unable to write context file: {err}"))?;
    touch_camp_updated_at(&camp_dir)?;
    Ok(())
}

#[tauri::command]
fn camp_delete(state: State<'_, AppState>, camp_id: String) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = camps_root.join(&camp_id);

    if !camp_dir.exists() {
        return Err("Camp not found".to_string());
    }

    fs::remove_dir_all(&camp_dir).map_err(|e| format!("Failed to delete camp directory: {}", e))?;

    Ok(())
}

#[tauri::command]
fn camp_list(state: State<'_, AppState>) -> Result<Vec<CampSummary>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let camps_root = ensure_camps_root(&connection)?;
    let mut camps = Vec::new();

    let entries =
        fs::read_dir(&camps_root).map_err(|err| format!("Unable to read camps folder: {err}"))?;
    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        let camp_dir = entry.path();
        if !camp_dir.is_dir() {
            continue;
        }

        let config_path = camp_config_path(&camp_dir);
        if !config_path.exists() {
            continue;
        }

        let config: CampConfig = match read_camp_config(&camp_dir) {
            Ok(config) => config,
            Err(_) => continue,
        };

        camps.push(CampSummary {
            id: config.id,
            name: config.name,
            model: config.model,
            updated_at: config.updated_at,
            path: camp_dir.to_string_lossy().into_owned(),
        });
    }

    camps.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(camps)
}

#[tauri::command]
fn camp_create(state: State<'_, AppState>, payload: CampCreatePayload) -> Result<Camp, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let camps_root = ensure_camps_root(&connection)?;
    let camp_id = Uuid::new_v4().to_string();
    let camp_dir = camps_root.join(&camp_id);

    let name = validate_non_empty(&payload.name, "name")?;
    let model = validate_non_empty(&payload.model, "model")?;
    let now = now_timestamp_ms();
    let config = CampConfig {
        schema_version: CAMP_SCHEMA_VERSION.to_string(),
        id: camp_id,
        name,
        model,
        tools_enabled: payload.tools_enabled.unwrap_or(default_tools_enabled()),
        created_at: now,
        updated_at: now,
    };

    fs::create_dir_all(&camp_dir).map_err(|err| format!("Unable to create camp folder: {err}"))?;
    fs::create_dir_all(camp_context_dir(&camp_dir))
        .map_err(|err| format!("Unable to create context folder: {err}"))?;
    fs::create_dir_all(camp_artifacts_dir(&camp_dir))
        .map_err(|err| format!("Unable to create artifacts folder: {err}"))?;

    write_camp_config(&camp_dir, &config)?;
    fs::write(camp_system_prompt_path(&camp_dir), payload.system_prompt)
        .map_err(|err| format!("Unable to write system prompt: {err}"))?;
    write_json_file(
        &camp_memory_path(&camp_dir),
        &payload
            .memory
            .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
    )?;
    fs::write(camp_transcript_path(&camp_dir), "")
        .map_err(|err| format!("Unable to initialize transcript: {err}"))?;
    write_artifacts_index(&camp_dir, &empty_artifacts_index())?;

    load_camp_from_dir(&camp_dir)
}

#[tauri::command]
fn camp_load(state: State<'_, AppState>, camp_id: String) -> Result<Camp, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;

    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    load_camp_from_dir(&camp_dir)
}

#[tauri::command]
fn camp_update_config(
    state: State<'_, AppState>,
    payload: CampUpdateConfigPayload,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;

    let mut config = read_camp_config(&camp_dir)?;
    config.name = validate_non_empty(&payload.name, "name")?;
    config.model = validate_non_empty(&payload.model, "model")?;
    config.tools_enabled = payload.tools_enabled;
    config.updated_at = now_timestamp_ms();

    write_camp_config(&camp_dir, &config)
}

#[tauri::command]
fn camp_update_system_prompt(
    state: State<'_, AppState>,
    payload: CampUpdateSystemPromptPayload,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;

    fs::write(camp_system_prompt_path(&camp_dir), payload.system_prompt)
        .map_err(|err| format!("Unable to update system prompt: {err}"))?;
    touch_camp_updated_at(&camp_dir)
}

#[tauri::command]
fn camp_update_memory(
    state: State<'_, AppState>,
    payload: CampUpdateMemoryPayload,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;

    write_json_file(&camp_memory_path(&camp_dir), &payload.memory)?;
    touch_camp_updated_at(&camp_dir)
}

#[tauri::command]
fn camp_append_message(
    state: State<'_, AppState>,
    payload: CampAppendMessagePayload,
) -> Result<CampMessage, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;

    let role = validate_camp_role(&payload.role)?;
    let tool_calls = normalize_camp_tool_calls(&role, payload.tool_calls)?;
    let content = normalize_message_content(&role, &payload.content, tool_calls.is_some())?;
    let tool_name = normalize_tool_message_name(&role, payload.name)?;
    let tool_call_id = normalize_tool_message_call_id(&role, payload.tool_call_id)?;
    let included_artifact_ids = normalize_included_artifact_ids(payload.included_artifact_ids)?;
    let included_artifact_ids = if role == "user" {
        included_artifact_ids
    } else {
        None
    };
    let message = CampMessage {
        id: Uuid::new_v4().to_string(),
        role,
        content,
        created_at: now_timestamp_ms(),
        name: tool_name,
        tool_call_id,
        tool_calls,
        included_artifact_ids,
    };

    append_transcript_message(&camp_transcript_path(&camp_dir), &message)?;
    touch_camp_updated_at(&camp_dir)?;

    Ok(message)
}

#[tauri::command]
fn camp_list_artifacts(
    state: State<'_, AppState>,
    camp_id: String,
) -> Result<Vec<CampArtifactMetadata>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let index = ensure_artifacts_index(&camp_dir)?;

    Ok(index.artifacts)
}

#[tauri::command]
fn camp_get_artifact(
    state: State<'_, AppState>,
    camp_id: String,
    artifact_id: String,
) -> Result<CampArtifact, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;

    load_artifact(&camp_dir, &artifact_id)
}

#[tauri::command]
fn camp_create_artifact_from_message(
    state: State<'_, AppState>,
    payload: CampCreateArtifactFromMessagePayload,
) -> Result<CampArtifact, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;
    let message_id = validate_identifier(&payload.message_id, "message_id")?;
    let transcript = read_transcript(&camp_transcript_path(&camp_dir))?;
    let source_message = transcript
        .iter()
        .find(|message| message.id == message_id)
        .ok_or_else(|| "Source message not found.".to_string())?;

    let title = payload
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            extract_default_artifact_title(&source_message.content, &source_message.role)
        });
    let title = validate_non_empty(&title, "title")?;

    let artifact_id = Uuid::new_v4().to_string();
    let filename = format!("{artifact_id}.md");
    let now = now_timestamp_ms();
    let metadata = CampArtifactMetadata {
        id: artifact_id.clone(),
        title: title.clone(),
        filename,
        source_message_id: source_message.id.clone(),
        source_role: source_message.role.clone(),
        tags: normalize_artifact_tags(&payload.tags.unwrap_or_default()),
        created_at: now,
        updated_at: now,
        usage_count: 0,
        archived: false,
    };

    let markdown = format_artifact_markdown(&title, &source_message.content);
    write_artifact_body(&camp_dir, &metadata, &markdown)?;

    let mut index = ensure_artifacts_index(&camp_dir)?;
    index.artifacts.push(metadata.clone());
    write_artifacts_index(&camp_dir, &index)?;
    touch_camp_updated_at(&camp_dir)?;

    Ok(CampArtifact {
        metadata,
        body: markdown,
    })
}

#[tauri::command]
fn camp_update_artifact(
    state: State<'_, AppState>,
    payload: CampUpdateArtifactPayload,
) -> Result<CampArtifact, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;
    let artifact_id = validate_identifier(&payload.artifact_id, "artifact_id")?;

    let mut index = ensure_artifacts_index(&camp_dir)?;
    let (result_metadata, markdown) = {
        let metadata = find_artifact_index_entry(&mut index, &artifact_id)?;
        let current_markdown = read_artifact_body(&camp_dir, metadata)?;
        let (parsed_title, parsed_body) =
            parse_artifact_markdown(&current_markdown, &metadata.title);

        let next_title = payload
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or(parsed_title);
        let next_body = payload.body.unwrap_or(parsed_body);
        let next_tags = payload
            .tags
            .as_ref()
            .map(|tags| normalize_artifact_tags(tags))
            .unwrap_or_else(|| metadata.tags.clone());

        metadata.title = validate_non_empty(&next_title, "title")?;
        metadata.tags = next_tags;
        metadata.updated_at = now_timestamp_ms();

        let markdown = format_artifact_markdown(&metadata.title, &next_body);
        write_artifact_body(&camp_dir, metadata, &markdown)?;

        (metadata.clone(), markdown)
    };

    write_artifacts_index(&camp_dir, &index)?;
    touch_camp_updated_at(&camp_dir)?;

    Ok(CampArtifact {
        metadata: result_metadata,
        body: markdown,
    })
}

#[tauri::command]
fn camp_toggle_artifact_archive(
    state: State<'_, AppState>,
    payload: CampToggleArtifactArchivePayload,
) -> Result<CampArtifactMetadata, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &payload.camp_id)?;
    let artifact_id = validate_identifier(&payload.artifact_id, "artifact_id")?;

    let mut index = ensure_artifacts_index(&camp_dir)?;
    let result_metadata = {
        let metadata = find_artifact_index_entry(&mut index, &artifact_id)?;
        metadata.archived = payload.archived;
        metadata.updated_at = now_timestamp_ms();
        metadata.clone()
    };

    write_artifacts_index(&camp_dir, &index)?;
    touch_camp_updated_at(&camp_dir)?;

    Ok(result_metadata)
}

#[tauri::command]
fn camp_increment_artifact_usage(
    state: State<'_, AppState>,
    camp_id: String,
    artifact_ids: Vec<String>,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database lock error".to_string())?;
    let camps_root = ensure_camps_root(&connection)?;
    let camp_dir = resolve_existing_camp_dir(&camps_root, &camp_id)?;
    let normalized_ids = normalize_included_artifact_ids(Some(artifact_ids))?.unwrap_or_default();

    if normalized_ids.is_empty() {
        return Ok(());
    }

    let mut index = ensure_artifacts_index(&camp_dir)?;
    let now = now_timestamp_ms();

    for artifact_id in &normalized_ids {
        if let Some(artifact) = index
            .artifacts
            .iter_mut()
            .find(|artifact| artifact.id == *artifact_id)
        {
            artifact.usage_count += 1;
            artifact.updated_at = now;
        }
    }

    write_artifacts_index(&camp_dir, &index)?;
    touch_camp_updated_at(&camp_dir)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let connection = init_database(app)?;
            app.manage(AppState {
                connection: Mutex::new(connection),
            });

            // Handle the splash screen
            let splash_window = app.get_webview_window("splashscreen").unwrap();
            let main_window = app.get_webview_window("main").unwrap();

            tauri::async_runtime::spawn(async move {
                // Keep the splash screen open for a bit
                std::thread::sleep(Duration::from_millis(2500));

                // Then show the main app
                splash_window.close().unwrap();
                main_window.show().unwrap();
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            get_api_key,
            has_api_key,
            insert_run,
            list_runs,
            get_run_by_id,
            update_run_rating_and_tags,
            db_upsert_models,
            db_list_models,
            db_get_models_last_sync,
            db_set_models_last_sync,
            ensure_default_workspace,
            set_workspace_path,
            get_workspace_path,
            pick_workspace_folder,
            set_tools_enabled,
            get_tools_enabled,
            set_default_model,
            get_default_model,
            set_developer_inspect_mode,
            get_developer_inspect_mode,
            inspect_emit_event,
            inspect_write_turn_request,
            inspect_write_turn_response,
            inspect_write_turn_bundle,
            inspect_read_turn_bundle,
            inspect_stat_camp_file,
            insert_tool_call_start,
            update_tool_call_result,
            update_tool_call_error,
            list_tool_calls_for_run,
            search_runs_db,
            write_note_to_workspace,
            workspace_list_context_files,
            camp_attach_workspace_context_file,
            camp_detach_workspace_context_file,
            tauri_cmd_read_context_file,
            tauri_cmd_list_context_files,
            tauri_cmd_write_context_file,
            camp_delete,
            camp_list,
            camp_create,
            camp_load,
            camp_update_config,
            camp_update_system_prompt,
            camp_update_memory,
            camp_append_message,
            camp_list_artifacts,
            camp_get_artifact,
            camp_create_artifact_from_message,
            camp_update_artifact,
            camp_toggle_artifact_archive,
            camp_increment_artifact_usage
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const LEGACY_CAMP_CONFIG_FIXTURE: &str =
        include_str!("../tests/fixtures/camp_config_legacy_v0.json");
    const LEGACY_TRANSCRIPT_FIXTURE: &str =
        include_str!("../tests/fixtures/transcript_legacy_shapes.jsonl");

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{timestamp}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temporary directory should be created");
        dir
    }

    #[test]
    fn note_filename_validation_and_path_join_are_sandboxed() {
        assert!(validate_note_filename("../escape.md").is_err());
        assert!(validate_note_filename("notes/escape.md").is_err());

        let filename =
            validate_note_filename("today.md").expect("expected valid markdown filename");
        let workspace = PathBuf::from("/tmp/basecamp-workspace");
        let resolved = resolve_note_path(&workspace, &filename);

        assert_eq!(resolved, workspace.join("today.md"));
    }

    #[test]
    fn context_relative_paths_block_traversal_and_allow_nested_files() {
        assert!(validate_context_relative_path("../escape.txt", "path", false).is_err());
        assert!(validate_context_relative_path("/tmp/escape.txt", "path", false).is_err());
        assert!(validate_context_relative_path("nested/../escape.txt", "path", false).is_err());

        let valid = validate_context_relative_path("nested/file.txt", "path", false)
            .expect("path should validate");
        assert_eq!(valid, PathBuf::from("nested/file.txt"));
    }

    #[test]
    fn tool_calls_insert_update_flow_round_trip() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        create_tables(&connection).expect("schema should be created");

        let payload = ToolCallStartPayload {
            run_id: "run-1".to_string(),
            step_index: 0,
            tool_name: "search_runs".to_string(),
            args_json: "{\"query\":\"test\"}".to_string(),
            started_at: 100,
        };

        let tool_call_id =
            insert_tool_call_start_db(&connection, &payload).expect("insert should succeed");
        update_tool_call_result_db(&connection, &tool_call_id, "{\"ok\":true}", 200)
            .expect("update should succeed");

        let row: ToolCallRow = connection
            .query_row(
                "
        SELECT
          id,
          run_id,
          step_index,
          tool_name,
          args_json,
          result_json,
          error,
          started_at,
          finished_at
        FROM tool_calls
        WHERE id = ?1
        ",
                params![tool_call_id],
                map_tool_call_row,
            )
            .expect("row should exist");

        assert_eq!(row.run_id, "run-1");
        assert_eq!(row.result_json.as_deref(), Some("{\"ok\":true}"));
        assert_eq!(row.error, None);
        assert_eq!(row.finished_at, Some(200));
    }

    #[test]
    fn artifact_filename_and_path_join_are_sandboxed() {
        assert!(validate_artifact_filename("../escape.md").is_err());
        assert!(validate_artifact_filename("nested/escape.md").is_err());

        let camp_dir = PathBuf::from("/tmp/basecamp-camp");
        let path = artifact_markdown_path(&camp_dir, "artifact-id.md")
            .expect("artifact path should resolve");

        assert_eq!(
            path,
            camp_dir.join(CAMP_ARTIFACTS_DIR).join("artifact-id.md")
        );
    }

    #[test]
    fn artifacts_index_round_trip_and_auto_create() {
        let camp_dir = make_temp_dir("basecamp-artifacts");
        fs::create_dir_all(camp_artifacts_dir(&camp_dir))
            .expect("artifacts folder should be created");

        let created = ensure_artifacts_index(&camp_dir).expect("index should auto-create");
        assert_eq!(created.schema_version, CAMP_ARTIFACTS_SCHEMA_VERSION);
        assert!(created.artifacts.is_empty());

        let metadata = CampArtifactMetadata {
            id: "a1".to_string(),
            title: "Title".to_string(),
            filename: "a1.md".to_string(),
            source_message_id: "m1".to_string(),
            source_role: "assistant".to_string(),
            tags: vec!["Alpha".to_string(), "alpha".to_string(), "beta".to_string()],
            created_at: 2,
            updated_at: 3,
            usage_count: 1,
            archived: false,
        };

        let next = CampArtifactsIndex {
            schema_version: CAMP_ARTIFACTS_SCHEMA_VERSION.to_string(),
            artifacts: vec![metadata],
        };
        write_artifacts_index(&camp_dir, &next).expect("index should write");

        let loaded = ensure_artifacts_index(&camp_dir).expect("index should load");
        assert_eq!(loaded.artifacts.len(), 1);
        assert_eq!(
            loaded.artifacts[0].tags,
            vec!["Alpha".to_string(), "beta".to_string()]
        );

        let _ = fs::remove_dir_all(camp_dir);
    }

    #[test]
    fn transcript_read_supports_old_and_new_message_shapes() {
        let transcript_dir = make_temp_dir("basecamp-transcript");
        let transcript_path = transcript_dir.join(CAMP_TRANSCRIPT_FILE);
        let old_line = r#"{"id":"m1","role":"user","content":"legacy","created_at":1}"#;
        let new_line = r#"{"id":"m2","role":"user","content":"new","created_at":2,"included_artifact_ids":["a1","a2"]}"#;

        fs::write(&transcript_path, format!("{old_line}\n{new_line}\n"))
            .expect("transcript should write");

        let parsed = read_transcript(&transcript_path).expect("transcript should parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].included_artifact_ids, None);
        assert_eq!(
            parsed[1].included_artifact_ids,
            Some(vec!["a1".to_string(), "a2".to_string()])
        );

        let _ = fs::remove_dir_all(transcript_dir);
    }

    #[test]
    fn read_camp_config_should_migrate_legacy_shape_and_persist_current_version() {
        let camp_dir = make_temp_dir("basecamp-config-migrate");
        fs::write(camp_config_path(&camp_dir), LEGACY_CAMP_CONFIG_FIXTURE)
            .expect("legacy camp config fixture should write");

        let loaded = read_camp_config(&camp_dir).expect("legacy config should load");
        assert_eq!(loaded.schema_version, CAMP_SCHEMA_VERSION);
        assert_eq!(loaded.id, "camp-legacy");
        assert_eq!(loaded.name, "Legacy Camp");
        assert_eq!(loaded.model, "openrouter/auto");
        assert!(!loaded.tools_enabled);
        assert_eq!(loaded.created_at, 1_700_000_000_000);
        assert_eq!(loaded.updated_at, 1_700_000_001_000);

        let persisted: CampConfig =
            read_json_file(&camp_config_path(&camp_dir)).expect("migrated config should persist");
        assert_eq!(persisted.schema_version, CAMP_SCHEMA_VERSION);
        assert!(!persisted.tools_enabled);
        assert_eq!(persisted.created_at, 1_700_000_000_000);
        assert_eq!(persisted.updated_at, 1_700_000_001_000);

        let _ = fs::remove_dir_all(camp_dir);
    }

    #[test]
    fn read_camp_config_should_fail_for_unsupported_schema_version() {
        let camp_dir = make_temp_dir("basecamp-config-unsupported");
        fs::write(
            camp_config_path(&camp_dir),
            r#"{
  "schema_version": "9.9",
  "id": "camp-future",
  "name": "Future",
  "model": "openrouter/auto",
  "tools_enabled": false,
  "created_at": 1,
  "updated_at": 1
}"#,
        )
        .expect("unsupported config should write");

        let error = read_camp_config(&camp_dir).expect_err("unsupported schema should fail");
        assert!(error.contains("Unsupported camp schema_version"));

        let _ = fs::remove_dir_all(camp_dir);
    }

    #[test]
    fn transcript_read_should_parse_legacy_fixture_shapes() {
        let transcript_dir = make_temp_dir("basecamp-transcript-fixture");
        let transcript_path = transcript_dir.join(CAMP_TRANSCRIPT_FILE);
        fs::write(&transcript_path, LEGACY_TRANSCRIPT_FIXTURE)
            .expect("legacy transcript fixture should write");

        let parsed = read_transcript(&transcript_path).expect("legacy transcript should parse");
        assert_eq!(parsed.len(), 4);

        assert_eq!(parsed[0].id, "legacy-message-1");
        assert_eq!(parsed[0].role, "user");
        assert_eq!(parsed[0].content, "legacy user message");
        assert_eq!(parsed[0].created_at, 1_700_000_002_000);

        assert_eq!(parsed[1].id, "assistant-1");
        assert_eq!(parsed[1].role, "assistant");
        assert_eq!(parsed[1].content, "let me check");
        assert_eq!(parsed[1].created_at, 1_700_000_003_000);
        assert_eq!(
            parsed[1]
                .tool_calls
                .as_ref()
                .map(|calls| calls[0].id.as_str()),
            Some("legacy-tool-call-2-1")
        );
        assert_eq!(
            parsed[1]
                .tool_calls
                .as_ref()
                .map(|calls| calls[0].function.arguments.as_str()),
            Some("{\"path\":\"README.md\"}")
        );

        assert_eq!(parsed[2].id, "legacy-message-3");
        assert_eq!(parsed[2].role, "tool");
        assert_eq!(parsed[2].name.as_deref(), Some("read_file"));
        assert_eq!(parsed[2].tool_call_id.as_deref(), Some("call-xyz"));
        assert_eq!(parsed[2].created_at, 1_700_000_004_000);

        assert_eq!(
            parsed[3].included_artifact_ids,
            Some(vec!["a1".to_string(), "a2".to_string()])
        );
        assert_eq!(parsed[3].created_at, 1_700_000_005_000);

        let _ = fs::remove_dir_all(transcript_dir);
    }
}
