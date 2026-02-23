use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use keyring::{Entry, Error as KeyringError};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tauri::{App, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.basecamp.app";
const KEYRING_ACCOUNT: &str = "openrouter_api_key";
const DB_FILE_NAME: &str = "basecamp.db";
const SETTING_WORKSPACE_PATH: &str = "workspace_path";
const SETTING_TOOLS_ENABLED: &str = "tools_enabled";
const CAMP_SCHEMA_VERSION: &str = "0.1";
const CAMPS_DIR_NAME: &str = "camps";
const CAMP_CONFIG_FILE: &str = "camp.json";
const CAMP_SYSTEM_PROMPT_FILE: &str = "system_prompt.md";
const CAMP_MEMORY_FILE: &str = "memory.json";
const CAMP_TRANSCRIPT_FILE: &str = "transcript.jsonl";
const CAMP_CONTEXT_DIR: &str = "context";
const CAMP_ARTIFACTS_DIR: &str = "artifacts";
const CAMP_ARTIFACTS_INDEX_FILE: &str = "index.json";
const CAMP_ARTIFACTS_SCHEMA_VERSION: &str = "0.1";

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
    created_at: i64,
    updated_at: i64,
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
    included_artifact_ids: Option<Vec<String>>,
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
}

#[derive(Debug, Deserialize)]
struct CampUpdateConfigPayload {
    camp_id: String,
    name: String,
    model: String,
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

fn camp_artifacts_dir(camp_dir: &Path) -> PathBuf {
    camp_dir.join(CAMP_ARTIFACTS_DIR)
}

fn camp_artifacts_index_path(camp_dir: &Path) -> PathBuf {
    camp_artifacts_dir(camp_dir).join(CAMP_ARTIFACTS_INDEX_FILE)
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
        let body = lines.collect::<Vec<_>>().join("\n").trim_start().to_string();

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

fn read_transcript(path: &Path) -> Result<Vec<CampMessage>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let file = fs::File::open(path).map_err(|err| format!("Unable to open transcript: {err}"))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Unable to read transcript line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let parsed: CampMessage = serde_json::from_str(trimmed)
            .map_err(|err| format!("Unable to parse transcript entry: {err}"))?;
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
    read_json_file(&camp_config_path(camp_dir))
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
        "system" | "user" | "assistant" => Ok(normalized),
        _ => Err("role must be one of: system, user, assistant.".to_string()),
    }
}

fn normalize_included_artifact_ids(artifact_ids: Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
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

        let config: CampConfig = match read_json_file(&config_path) {
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
    let content = validate_non_empty(&payload.content, "content")?;
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
        .unwrap_or_else(|| extract_default_artifact_title(&source_message.content, &source_message.role));
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
            insert_tool_call_start,
            update_tool_call_result,
            update_tool_call_error,
            list_tool_calls_for_run,
            search_runs_db,
            write_note_to_workspace,
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
        assert_eq!(loaded.artifacts[0].tags, vec!["Alpha".to_string(), "beta".to_string()]);

        let _ = fs::remove_dir_all(camp_dir);
    }

    #[test]
    fn transcript_read_supports_old_and_new_message_shapes() {
        let transcript_dir = make_temp_dir("basecamp-transcript");
        let transcript_path = transcript_dir.join(CAMP_TRANSCRIPT_FILE);
        let old_line = r#"{"id":"m1","role":"user","content":"legacy","created_at":1}"#;
        let new_line =
            r#"{"id":"m2","role":"user","content":"new","created_at":2,"included_artifact_ids":["a1","a2"]}"#;

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
}
