use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{now_timestamp_ms, ProviderCapabilities, ProviderConfig, ProviderKind, ProviderModel};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRegistryRow {
    pub provider_kind: ProviderKind,
    pub base_url: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRegistryRow {
    pub provider_kind: ProviderKind,
    pub model_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<i64>,
    pub capabilities: ProviderCapabilities,
    pub raw_json: Value,
    pub last_seen_at: i64,
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, rusqlite::Error> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
            params![table_name],
            |row| row.get(0),
        )
        .optional()?;
    Ok(exists.is_some())
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

fn map_provider_row(row: &Row<'_>) -> rusqlite::Result<ProviderRegistryRow> {
    let provider_kind_text: String = row.get("provider_kind")?;
    let provider_kind = ProviderKind::parse(&provider_kind_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown provider kind: {provider_kind_text}"),
            )),
        )
    })?;
    let enabled: i64 = row.get("enabled")?;
    Ok(ProviderRegistryRow {
        provider_kind,
        base_url: row.get("base_url")?,
        enabled: enabled != 0,
        last_ok_at: row.get("last_ok_at")?,
        last_error: row.get("last_error")?,
    })
}

fn map_model_row(row: &Row<'_>) -> rusqlite::Result<ModelRegistryRow> {
    let provider_kind_text: String = row.get("provider_kind")?;
    let provider_kind = ProviderKind::parse(&provider_kind_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown provider kind: {provider_kind_text}"),
            )),
        )
    })?;
    let capabilities_json: String = row.get("capabilities_json")?;
    let raw_json_text: String = row.get("raw_json")?;
    let model_id: String = row.get("model_id")?;
    let capabilities =
        serde_json::from_str::<ProviderCapabilities>(&capabilities_json).unwrap_or_default();
    let raw_json = serde_json::from_str::<Value>(&raw_json_text).unwrap_or(Value::Null);
    Ok(ModelRegistryRow {
        provider_kind,
        id: format!("{}/{}", provider_kind_text, model_id),
        model_id,
        display_name: row.get("display_name")?,
        context_length: row.get("context_length")?,
        capabilities,
        raw_json,
        last_seen_at: row.get("last_seen_at")?,
    })
}

pub fn create_registry_tables(connection: &Connection) -> Result<(), rusqlite::Error> {
    if table_exists(connection, "models")? {
        let is_new_shape = has_column(connection, "models", "provider_kind")?
            && has_column(connection, "models", "model_id")?;
        if !is_new_shape {
            let legacy_name = format!("models_legacy_{}", now_timestamp_ms());
            connection.execute(&format!("ALTER TABLE models RENAME TO {legacy_name}"), [])?;
            connection.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS models (
                  provider_kind TEXT NOT NULL,
                  model_id TEXT NOT NULL,
                  display_name TEXT,
                  context_length INTEGER,
                  capabilities_json TEXT NOT NULL,
                  raw_json TEXT NOT NULL,
                  last_seen_at INTEGER NOT NULL,
                  PRIMARY KEY(provider_kind, model_id)
                );
                CREATE INDEX IF NOT EXISTS idx_models_provider_kind ON models(provider_kind);
                CREATE INDEX IF NOT EXISTS idx_models_last_seen_at ON models(last_seen_at);
                ",
            )?;
            connection.execute(
                &format!(
                    "
                    INSERT OR REPLACE INTO models (
                      provider_kind,
                      model_id,
                      display_name,
                      context_length,
                      capabilities_json,
                      raw_json,
                      last_seen_at
                    )
                    SELECT
                      'openrouter',
                      id,
                      COALESCE(NULLIF(name, ''), id),
                      context_length,
                      '{{\"supports_tools\":true,\"supports_images\":true,\"supports_json_schema\":true,\"stream_protocol\":\"sse\"}}',
                      COALESCE(raw_json, 'null'),
                      COALESCE(updated_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
                    FROM {legacy_name}
                    WHERE id IS NOT NULL AND TRIM(id) <> ''
                    "
                ),
                [],
            )?;
        }
    }

    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS providers (
          provider_kind TEXT PRIMARY KEY,
          base_url TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          last_ok_at INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS models (
          provider_kind TEXT NOT NULL,
          model_id TEXT NOT NULL,
          display_name TEXT,
          context_length INTEGER,
          capabilities_json TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(provider_kind, model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_models_provider_kind ON models(provider_kind);
        CREATE INDEX IF NOT EXISTS idx_models_last_seen_at ON models(last_seen_at);
        ",
    )?;

    insert_default_providers(connection)?;
    Ok(())
}

fn insert_default_providers(connection: &Connection) -> Result<(), rusqlite::Error> {
    let defaults = [
        (ProviderKind::Openrouter, true),
        (ProviderKind::Lmstudio, false),
        (ProviderKind::Ollama, false),
        (ProviderKind::LlamaCpp, false),
    ];
    for (kind, enabled) in defaults {
        connection.execute(
            "
            INSERT INTO providers (provider_kind, base_url, enabled, last_ok_at, last_error)
            VALUES (?1, ?2, ?3, NULL, NULL)
            ON CONFLICT(provider_kind) DO NOTHING
            ",
            params![
                kind.as_str(),
                kind.default_base_url(),
                if enabled { 1 } else { 0 }
            ],
        )?;
    }
    Ok(())
}

pub fn list_providers(
    connection: &Connection,
) -> Result<Vec<ProviderRegistryRow>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "
        SELECT provider_kind, base_url, enabled, last_ok_at, last_error
        FROM providers
        ORDER BY provider_kind ASC
        ",
    )?;
    let rows = statement.query_map([], map_provider_row)?;
    rows.collect::<Result<Vec<_>, _>>()
}

pub fn get_provider(
    connection: &Connection,
    kind: ProviderKind,
) -> Result<Option<ProviderRegistryRow>, rusqlite::Error> {
    connection
        .query_row(
            "
            SELECT provider_kind, base_url, enabled, last_ok_at, last_error
            FROM providers
            WHERE provider_kind = ?1
            ",
            params![kind.as_str()],
            map_provider_row,
        )
        .optional()
}

pub fn upsert_provider(
    connection: &Connection,
    row: &ProviderRegistryRow,
) -> Result<(), rusqlite::Error> {
    connection.execute(
        "
        INSERT INTO providers (provider_kind, base_url, enabled, last_ok_at, last_error)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(provider_kind) DO UPDATE SET
          base_url = excluded.base_url,
          enabled = excluded.enabled,
          last_ok_at = excluded.last_ok_at,
          last_error = excluded.last_error
        ",
        params![
            row.provider_kind.as_str(),
            row.base_url,
            if row.enabled { 1 } else { 0 },
            row.last_ok_at,
            row.last_error
        ],
    )?;
    Ok(())
}

pub fn update_provider_health(
    connection: &Connection,
    provider_kind: ProviderKind,
    ok: bool,
    last_error: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let now = now_timestamp_ms();
    let ok_timestamp: Option<i64> = if ok { Some(now) } else { None };
    connection.execute(
        "
        UPDATE providers
        SET last_ok_at = COALESCE(?2, last_ok_at),
            last_error = ?3
        WHERE provider_kind = ?1
        ",
        params![provider_kind.as_str(), ok_timestamp, last_error],
    )?;
    Ok(())
}

pub fn list_models(
    connection: &Connection,
    provider_filter: Option<ProviderKind>,
) -> Result<Vec<ModelRegistryRow>, rusqlite::Error> {
    match provider_filter {
        Some(provider_kind) => {
            let mut statement = connection.prepare(
                "
                SELECT
                  provider_kind,
                  model_id,
                  display_name,
                  context_length,
                  capabilities_json,
                  raw_json,
                  last_seen_at
                FROM models
                WHERE provider_kind = ?1
                ORDER BY LOWER(COALESCE(NULLIF(display_name, ''), model_id)) ASC, LOWER(model_id) ASC
                ",
            )?;
            let rows = statement.query_map(params![provider_kind.as_str()], map_model_row)?;
            rows.collect::<Result<Vec<_>, _>>()
        }
        None => {
            let mut statement = connection.prepare(
                "
                SELECT
                  provider_kind,
                  model_id,
                  display_name,
                  context_length,
                  capabilities_json,
                  raw_json,
                  last_seen_at
                FROM models
                ORDER BY provider_kind ASC, LOWER(COALESCE(NULLIF(display_name, ''), model_id)) ASC, LOWER(model_id) ASC
                ",
            )?;
            let rows = statement.query_map([], map_model_row)?;
            rows.collect::<Result<Vec<_>, _>>()
        }
    }
}

pub fn get_model_capabilities(
    connection: &Connection,
    provider_kind: ProviderKind,
    model_id: &str,
) -> Result<Option<ProviderCapabilities>, rusqlite::Error> {
    let value: Option<String> = connection
        .query_row(
            "
            SELECT capabilities_json
            FROM models
            WHERE provider_kind = ?1 AND model_id = ?2
            ",
            params![provider_kind.as_str(), model_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.and_then(|raw| serde_json::from_str::<ProviderCapabilities>(&raw).ok()))
}

pub fn replace_models_for_provider(
    connection: &mut Connection,
    provider_kind: ProviderKind,
    models: &[ProviderModel],
) -> Result<usize, rusqlite::Error> {
    let now = now_timestamp_ms();
    let tx = connection.transaction()?;
    tx.execute(
        "DELETE FROM models WHERE provider_kind = ?1",
        params![provider_kind.as_str()],
    )?;
    let mut statement = tx.prepare(
        "
        INSERT INTO models (
          provider_kind,
          model_id,
          display_name,
          context_length,
          capabilities_json,
          raw_json,
          last_seen_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
    )?;

    let mut inserted = 0usize;
    for model in models {
        let raw_json =
            serde_json::to_string(&model.raw_json).unwrap_or_else(|_| "null".to_string());
        statement.execute(params![
            provider_kind.as_str(),
            model.model_id,
            model.display_name,
            model.context_length,
            model.capabilities.to_json_string(),
            raw_json,
            now,
        ])?;
        inserted += 1;
    }
    drop(statement);
    tx.commit()?;
    Ok(inserted)
}

pub fn get_models_last_sync(connection: &Connection) -> Result<Option<i64>, rusqlite::Error> {
    connection.query_row("SELECT MAX(last_seen_at) FROM models", [], |row| row.get(0))
}

pub fn provider_to_runtime_config(row: &ProviderRegistryRow) -> ProviderConfig {
    ProviderConfig {
        provider_kind: row.provider_kind,
        base_url: row.base_url.clone(),
        enabled: row.enabled,
    }
}
