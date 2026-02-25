use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
#[cfg(test)]
use uuid::Uuid;

pub const INSPECT_EVENT_CHANNEL: &str = "basecamp://inspect-event";
const DEBUG_DIR_TOP: &str = ".camp";
const DEBUG_DIR_NAME: &str = "debug";
const EVENTS_FILE_NAME: &str = "events.jsonl";
const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectEventRecord {
    pub timestamp_ms: i64,
    pub correlation_id: String,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectFileMeta {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at_ms: Option<i64>,
    pub absolute_path: String,
}

fn debug_dir(camp_dir: &Path) -> PathBuf {
    camp_dir.join(DEBUG_DIR_TOP).join(DEBUG_DIR_NAME)
}

fn events_path(camp_dir: &Path) -> PathBuf {
    debug_dir(camp_dir).join(EVENTS_FILE_NAME)
}

fn sanitize_filename_component(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch);
        }
    }

    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

fn turn_file_path(camp_dir: &Path, correlation_id: &str, suffix: &str) -> PathBuf {
    let safe_id = sanitize_filename_component(correlation_id);
    debug_dir(camp_dir).join(format!("turn_{safe_id}_{suffix}.json"))
}

#[cfg(test)]
pub fn turn_request_file_path(camp_dir: &Path, correlation_id: &str) -> PathBuf {
    turn_file_path(camp_dir, correlation_id, "request")
}

#[cfg(test)]
pub fn turn_response_file_path(camp_dir: &Path, correlation_id: &str) -> PathBuf {
    turn_file_path(camp_dir, correlation_id, "response")
}

pub fn turn_bundle_file_path(camp_dir: &Path, correlation_id: &str) -> PathBuf {
    turn_file_path(camp_dir, correlation_id, "bundle")
}

pub fn ensure_debug_dir(camp_dir: &Path) -> Result<PathBuf, String> {
    let dir = debug_dir(camp_dir);
    fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "Unable to create inspect debug directory {}: {err}",
            dir.to_string_lossy()
        )
    })?;
    Ok(dir)
}

fn key_requires_redaction(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    normalized == "authorization"
        || normalized == "cookie"
        || normalized == "set-cookie"
        || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.ends_with("_key")
        || normalized == "key"
}

fn sanitize_string(value: &str) -> Value {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.starts_with("bearer ")
        || normalized.contains("sk-or-")
        || normalized.contains("api_key")
    {
        return Value::String(REDACTED.to_string());
    }

    Value::String(value.to_string())
}

pub fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut ordered = BTreeMap::new();
            for (key, nested) in map {
                if key_requires_redaction(key) {
                    ordered.insert(key.clone(), Value::String(REDACTED.to_string()));
                } else {
                    ordered.insert(key.clone(), sanitize_value(nested));
                }
            }

            let mut normalized = Map::new();
            for (key, nested) in ordered {
                normalized.insert(key, nested);
            }

            Value::Object(normalized)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_value).collect()),
        Value::String(text) => sanitize_string(text),
        _ => value.clone(),
    }
}

pub fn sanitize_event_record(input: InspectEventRecord) -> InspectEventRecord {
    InspectEventRecord {
        payload: input.payload.map(|payload| sanitize_value(&payload)),
        ..input
    }
}

pub fn emit_event(
    app: Option<&AppHandle>,
    camp_dir: &Path,
    event: InspectEventRecord,
) -> Result<InspectEventRecord, String> {
    let sanitized = sanitize_event_record(event);
    ensure_debug_dir(camp_dir)?;

    let serialized = serde_json::to_string(&sanitized)
        .map_err(|err| format!("Unable to serialize inspect event: {err}"))?;

    let path = events_path(camp_dir);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| {
            format!(
                "Unable to open inspect events file {}: {err}",
                path.to_string_lossy()
            )
        })?;

    file.write_all(serialized.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| {
            format!(
                "Unable to append inspect event {}: {err}",
                path.to_string_lossy()
            )
        })?;

    if let Some(app_handle) = app {
        let _ = app_handle.emit(INSPECT_EVENT_CHANNEL, &sanitized);
    }

    Ok(sanitized)
}

pub fn write_turn_file(
    camp_dir: &Path,
    correlation_id: &str,
    suffix: &str,
    value: &Value,
) -> Result<PathBuf, String> {
    ensure_debug_dir(camp_dir)?;
    let path = turn_file_path(camp_dir, correlation_id, suffix);
    let sanitized = sanitize_value(value);

    let serialized = serde_json::to_string_pretty(&sanitized)
        .map_err(|err| format!("Unable to serialize inspect JSON: {err}"))?;

    fs::write(&path, serialized).map_err(|err| {
        format!(
            "Unable to write inspect file {}: {err}",
            path.to_string_lossy()
        )
    })?;

    Ok(path)
}

pub fn write_turn_request_file(
    camp_dir: &Path,
    correlation_id: &str,
    value: &Value,
) -> Result<PathBuf, String> {
    write_turn_file(camp_dir, correlation_id, "request", value)
}

pub fn write_turn_response_file(
    camp_dir: &Path,
    correlation_id: &str,
    value: &Value,
) -> Result<PathBuf, String> {
    write_turn_file(camp_dir, correlation_id, "response", value)
}

pub fn write_turn_bundle_file(
    camp_dir: &Path,
    correlation_id: &str,
    value: &Value,
) -> Result<PathBuf, String> {
    write_turn_file(camp_dir, correlation_id, "bundle", value)
}

pub fn collect_file_meta(path: &Path) -> InspectFileMeta {
    let metadata = fs::metadata(path).ok();
    let modified_at_ms = metadata
        .as_ref()
        .and_then(|entry| entry.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);

    InspectFileMeta {
        exists: metadata.is_some(),
        size_bytes: metadata.as_ref().map(|entry| entry.len()),
        modified_at_ms,
        absolute_path: path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temporary directory should be created");
        dir
    }

    #[test]
    fn redactor_masks_api_key_and_secret_fields() {
        let raw = serde_json::json!({
            "api_key": "sk-or-v1-secret-123",
            "headers": {
                "Authorization": "Bearer sk-or-v1-secret-123",
                "X-Title": "Basecamp"
            },
            "nested": {
                "token": "abc123",
                "safe": "ok"
            }
        });

        let sanitized = sanitize_value(&raw);
        let serialized =
            serde_json::to_string(&sanitized).expect("sanitized value should serialize");

        assert!(!serialized.contains("sk-or-v1-secret-123"));
        assert!(!serialized.contains("abc123"));
        assert!(serialized.contains(REDACTED));
        assert!(serialized.contains("Basecamp"));
    }

    #[test]
    fn smoke_writes_debug_files_with_consistent_correlation_id() {
        let camp_dir = make_temp_dir("basecamp-inspect-smoke");
        let correlation_id = "corr-123";

        let event = InspectEventRecord {
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
            correlation_id: correlation_id.to_string(),
            event_type: "compose_start".to_string(),
            duration_ms: None,
            summary: "Composing request".to_string(),
            payload: Some(serde_json::json!({ "model": "openrouter/auto" })),
        };
        emit_event(None, &camp_dir, event).expect("event should append");

        write_turn_request_file(
            &camp_dir,
            correlation_id,
            &serde_json::json!({
                "model": "openrouter/auto",
                "api_key": "sk-or-v1-secret-123"
            }),
        )
        .expect("request file should write");

        write_turn_response_file(
            &camp_dir,
            correlation_id,
            &serde_json::json!({ "status": 200, "ok": true }),
        )
        .expect("response file should write");

        write_turn_bundle_file(
            &camp_dir,
            correlation_id,
            &serde_json::json!({
                "correlation_id": correlation_id,
                "event_timeline": [
                    {"event_type": "compose_start"}
                ]
            }),
        )
        .expect("bundle file should write");

        let events_raw =
            fs::read_to_string(events_path(&camp_dir)).expect("events file should exist");
        assert!(events_raw.contains(correlation_id));

        let request_path = turn_request_file_path(&camp_dir, correlation_id);
        let response_path = turn_response_file_path(&camp_dir, correlation_id);
        let bundle_path = turn_bundle_file_path(&camp_dir, correlation_id);

        assert!(request_path.exists());
        assert!(response_path.exists());
        assert!(bundle_path.exists());

        let request_raw = fs::read_to_string(request_path).expect("request file should read");
        assert!(!request_raw.contains("sk-or-v1-secret-123"));
        assert!(request_raw.contains(REDACTED));

        let _ = fs::remove_dir_all(camp_dir);
    }
}
