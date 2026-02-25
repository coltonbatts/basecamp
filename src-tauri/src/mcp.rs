use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use keyring::Entry;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader, BufWriter};
use tokio::process::{Child, Command};

use crate::AppState;

const KEYRING_SERVICE: &str = "com.basecamp.app";
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Optional auth token. Stored in keyring, never returned to renderer.
    #[serde(skip_serializing)]
    pub auth_token: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpTransport {
    #[serde(rename = "stdio")]
    Stdio { command: String, args: Vec<String> },
    #[serde(rename = "sse")]
    Sse { url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    pub enabled: bool,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDef {
    pub server_id: String,
    pub name: String,
    pub qualified_name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Serialize)]
struct JsonRpcNotification {
    jsonrpc: &'static str,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

pub struct McpConnections {
    connections: HashMap<String, McpConnection>,
}

impl McpConnections {
    pub fn new() -> Self {
        Self {
            connections: HashMap::new(),
        }
    }

    pub fn is_connected(&self, server_id: &str) -> bool {
        self.connections.contains_key(server_id)
    }
}

enum McpConnection {
    Stdio {
        _child: Child,
        stdin: BufWriter<tokio::process::ChildStdin>,
        stdout: TokioBufReader<tokio::process::ChildStdout>,
        next_id: AtomicU64,
    },
    Sse {
        url: String,
        client: reqwest::Client,
        next_id: AtomicU64,
        auth_token: Option<String>,
    },
}

impl McpConnection {
    async fn send_request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        match self {
            McpConnection::Stdio {
                stdin,
                stdout,
                next_id,
                ..
            } => {
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                let request = JsonRpcRequest {
                    jsonrpc: "2.0",
                    id,
                    method: method.to_string(),
                    params,
                };
                let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
                line.push('\n');
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write to MCP server stdin: {e}"))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush MCP server stdin: {e}"))?;

                let mut response_line = String::new();
                stdout
                    .read_line(&mut response_line)
                    .await
                    .map_err(|e| format!("Failed to read from MCP server stdout: {e}"))?;

                if response_line.is_empty() {
                    return Err("MCP server closed stdout unexpectedly".to_string());
                }

                let response: JsonRpcResponse = serde_json::from_str(&response_line)
                    .map_err(|e| format!("Failed to parse MCP server response: {e}"))?;

                if let Some(err) = response.error {
                    return Err(format!(
                        "MCP server error (code {}): {}",
                        err.code, err.message
                    ));
                }

                Ok(response.result.unwrap_or(Value::Null))
            }
            McpConnection::Sse {
                url,
                client,
                next_id,
                auth_token,
            } => {
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                let request = JsonRpcRequest {
                    jsonrpc: "2.0",
                    id,
                    method: method.to_string(),
                    params,
                };

                let mut builder = client.post(url.as_str()).json(&request);
                if let Some(token) = auth_token {
                    builder = builder.bearer_auth(token);
                }

                let resp = builder
                    .send()
                    .await
                    .map_err(|e| format!("SSE HTTP request failed: {e}"))?;

                if !resp.status().is_success() {
                    return Err(format!("SSE server returned status {}", resp.status()));
                }

                let body = resp
                    .text()
                    .await
                    .map_err(|e| format!("Failed to read SSE response body: {e}"))?;

                let response: JsonRpcResponse = serde_json::from_str(&body)
                    .map_err(|e| format!("Failed to parse SSE response: {e}"))?;

                if let Some(err) = response.error {
                    return Err(format!(
                        "MCP server error (code {}): {}",
                        err.code, err.message
                    ));
                }

                Ok(response.result.unwrap_or(Value::Null))
            }
        }
    }

    async fn send_notification(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        match self {
            McpConnection::Stdio { stdin, .. } => {
                let notification = JsonRpcNotification {
                    jsonrpc: "2.0",
                    method: method.to_string(),
                    params,
                };
                let mut line = serde_json::to_string(&notification).map_err(|e| e.to_string())?;
                line.push('\n');
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write notification: {e}"))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush notification: {e}"))?;
                Ok(())
            }
            McpConnection::Sse { .. } => {
                // SSE transport: notifications are fire-and-forget, no response expected
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

pub fn create_mcp_servers_table(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            transport TEXT NOT NULL CHECK(transport IN ('stdio', 'sse')),
            transport_config TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
        );
        ",
    )?;
    Ok(())
}

fn load_server_configs(connection: &Connection) -> Result<Vec<McpServerConfig>, String> {
    let mut stmt = connection
        .prepare("SELECT id, name, transport, transport_config, enabled FROM mcp_servers")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let transport_type: String = row.get(2)?;
            let transport_config: String = row.get(3)?;
            let enabled: bool = row.get(4)?;
            Ok((id, name, transport_type, transport_config, enabled))
        })
        .map_err(|e| e.to_string())?;

    let mut configs = Vec::new();
    for row in rows {
        let (id, name, transport_type, transport_config, enabled) =
            row.map_err(|e| e.to_string())?;
        let transport = match transport_type.as_str() {
            "stdio" => {
                let parsed: Value =
                    serde_json::from_str(&transport_config).map_err(|e| e.to_string())?;
                McpTransport::Stdio {
                    command: parsed["command"].as_str().unwrap_or_default().to_string(),
                    args: parsed["args"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                }
            }
            "sse" => {
                let parsed: Value =
                    serde_json::from_str(&transport_config).map_err(|e| e.to_string())?;
                McpTransport::Sse {
                    url: parsed["url"].as_str().unwrap_or_default().to_string(),
                }
            }
            other => return Err(format!("Unknown transport type: {other}")),
        };

        configs.push(McpServerConfig {
            id,
            name,
            transport,
            enabled,
            auth_token: None,
        });
    }

    Ok(configs)
}

fn insert_server_config(connection: &Connection, config: &McpServerConfig) -> Result<(), String> {
    let (transport_type, transport_config) = match &config.transport {
        McpTransport::Stdio { command, args } => (
            "stdio",
            serde_json::json!({ "command": command, "args": args }).to_string(),
        ),
        McpTransport::Sse { url } => ("sse", serde_json::json!({ "url": url }).to_string()),
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    connection
        .execute(
            "INSERT OR REPLACE INTO mcp_servers (id, name, transport, transport_config, enabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![config.id, config.name, transport_type, transport_config, config.enabled, now],
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Keyring helpers
// ---------------------------------------------------------------------------

fn mcp_keyring_entry(server_id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, &format!("mcp_server:{server_id}"))
        .map_err(|e| format!("Keyring error: {e}"))
}

fn store_auth_token(server_id: &str, token: &str) -> Result<(), String> {
    let entry = mcp_keyring_entry(server_id)?;
    entry
        .set_password(token)
        .map_err(|e| format!("Failed to store auth token: {e}"))
}

fn read_auth_token(server_id: &str) -> Option<String> {
    let entry = mcp_keyring_entry(server_id).ok()?;
    entry.get_password().ok()
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

async fn connect_server(config: &McpServerConfig) -> Result<McpConnection, String> {
    let auth_token = read_auth_token(&config.id);

    match &config.transport {
        McpTransport::Stdio { command, args } => {
            let mut cmd = Command::new(command);
            cmd.args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());

            // Pass auth token as env var if present
            if let Some(ref token) = auth_token {
                cmd.env("MCP_AUTH_TOKEN", token);
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to spawn MCP server '{}': {e}", config.name))?;

            let stdin = child
                .stdin
                .take()
                .ok_or("Failed to capture MCP server stdin")?;
            let stdout = child
                .stdout
                .take()
                .ok_or("Failed to capture MCP server stdout")?;

            Ok(McpConnection::Stdio {
                _child: child,
                stdin: BufWriter::new(stdin),
                stdout: TokioBufReader::new(stdout),
                next_id: AtomicU64::new(1),
            })
        }
        McpTransport::Sse { url } => {
            let client = reqwest::Client::new();
            Ok(McpConnection::Sse {
                url: url.clone(),
                client,
                next_id: AtomicU64::new(1),
                auth_token,
            })
        }
    }
}

async fn initialize_connection(conn: &mut McpConnection) -> Result<(), String> {
    let init_params = serde_json::json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {
            "name": "Basecamp",
            "version": "0.1.0"
        }
    });

    let _result = conn.send_request("initialize", Some(init_params)).await?;
    conn.send_notification("notifications/initialized", None)
        .await?;

    Ok(())
}

fn parse_tool_defs(server_id: &str, result: &Value) -> Vec<McpToolDef> {
    let tools = match result.get("tools").and_then(|t| t.as_array()) {
        Some(tools) => tools,
        None => return Vec::new(),
    };

    tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?;
            let description = tool
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = tool
                .get("inputSchema")
                .cloned()
                .unwrap_or(serde_json::json!({"type": "object", "properties": {}}));

            // Check annotations.readOnlyHint (MCP spec)
            let read_only = tool
                .get("annotations")
                .and_then(|a| a.get("readOnlyHint"))
                .and_then(|r| r.as_bool())
                .unwrap_or(false);

            Some(McpToolDef {
                server_id: server_id.to_string(),
                name: name.to_string(),
                qualified_name: format!("{}/{}", server_id, name),
                description,
                input_schema,
                read_only,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mcp_register_server(
    state: State<'_, AppState>,
    config: McpServerConfig,
) -> Result<McpServerConfig, String> {
    // Store auth token in keyring if provided
    if let Some(ref token) = config.auth_token {
        if !token.is_empty() {
            store_auth_token(&config.id, token)?;
        }
    }

    // Insert into database
    {
        let db = state.connection.lock().map_err(|e| e.to_string())?;
        insert_server_config(&db, &config)?;
    }

    // Return config without auth token
    Ok(McpServerConfig {
        auth_token: None,
        ..config
    })
}

#[tauri::command]
pub async fn mcp_list_servers(state: State<'_, AppState>) -> Result<Vec<McpServerStatus>, String> {
    let configs = {
        let db = state.connection.lock().map_err(|e| e.to_string())?;
        load_server_configs(&db)?
    };

    let mcp = state.mcp.lock().await;

    Ok(configs
        .into_iter()
        .map(|config| McpServerStatus {
            connected: mcp.is_connected(&config.id),
            id: config.id,
            name: config.name,
            transport: config.transport,
            enabled: config.enabled,
        })
        .collect())
}

#[tauri::command]
pub async fn mcp_discover_tools(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<McpToolDef>, String> {
    // Load config from database
    let config = {
        let db = state.connection.lock().map_err(|e| e.to_string())?;
        let configs = load_server_configs(&db)?;
        configs
            .into_iter()
            .find(|c| c.id == server_id)
            .ok_or_else(|| format!("Server not found: {server_id}"))?
    };

    let mut mcp = state.mcp.lock().await;

    // Connect if not already connected
    if !mcp.is_connected(&server_id) {
        let mut conn = connect_server(&config).await?;
        initialize_connection(&mut conn).await?;
        mcp.connections.insert(server_id.clone(), conn);
    }

    // Fetch tools
    let conn = mcp
        .connections
        .get_mut(&server_id)
        .ok_or("Connection lost")?;

    let result = conn.send_request("tools/list", None).await?;
    let tools = parse_tool_defs(&server_id, &result);

    Ok(tools)
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, AppState>,
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<McpToolResult, String> {
    let mut mcp = state.mcp.lock().await;

    let conn = mcp
        .connections
        .get_mut(&server_id)
        .ok_or_else(|| format!("Server not connected: {server_id}"))?;

    let params = serde_json::json!({
        "name": tool_name,
        "arguments": arguments,
    });

    let result = conn.send_request("tools/call", Some(params)).await?;

    // Parse MCP tool result format
    let is_error = result
        .get("isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    let content = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| McpContent {
                    content_type: item
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("text")
                        .to_string(),
                    text: item.get("text").and_then(|t| t.as_str()).map(String::from),
                })
                .collect()
        })
        .unwrap_or_else(|| {
            // If no content array, wrap the whole result as text
            vec![McpContent {
                content_type: "text".to_string(),
                text: Some(result.to_string()),
            }]
        });

    Ok(McpToolResult { content, is_error })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_rpc_request_serialization() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list".to_string(),
            params: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], 1);
        assert_eq!(parsed["method"], "tools/list");
        assert!(parsed.get("params").is_none());
    }

    #[test]
    fn test_json_rpc_request_with_params() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: 42,
            method: "tools/call".to_string(),
            params: Some(serde_json::json!({"name": "echo", "arguments": {"text": "hello"}})),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["params"]["name"], "echo");
        assert_eq!(parsed["params"]["arguments"]["text"], "hello");
    }

    #[test]
    fn test_json_rpc_response_success() {
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        let resp: JsonRpcResponse = serde_json::from_str(json).unwrap();
        assert!(resp.error.is_none());
        assert!(resp.result.is_some());
    }

    #[test]
    fn test_json_rpc_response_error() {
        let json =
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid request"}}"#;
        let resp: JsonRpcResponse = serde_json::from_str(json).unwrap();
        assert!(resp.error.is_some());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32600);
        assert_eq!(err.message, "Invalid request");
    }

    #[test]
    fn test_transport_serde_roundtrip_stdio() {
        let transport = McpTransport::Stdio {
            command: "node".to_string(),
            args: vec!["server.js".to_string()],
        };
        let json = serde_json::to_string(&transport).unwrap();
        let parsed: McpTransport = serde_json::from_str(&json).unwrap();
        match parsed {
            McpTransport::Stdio { command, args } => {
                assert_eq!(command, "node");
                assert_eq!(args, vec!["server.js"]);
            }
            _ => panic!("Expected Stdio transport"),
        }
    }

    #[test]
    fn test_transport_serde_roundtrip_sse() {
        let transport = McpTransport::Sse {
            url: "http://localhost:3000/mcp".to_string(),
        };
        let json = serde_json::to_string(&transport).unwrap();
        let parsed: McpTransport = serde_json::from_str(&json).unwrap();
        match parsed {
            McpTransport::Sse { url } => {
                assert_eq!(url, "http://localhost:3000/mcp");
            }
            _ => panic!("Expected Sse transport"),
        }
    }

    #[test]
    fn test_parse_tool_defs_basic() {
        let result = serde_json::json!({
            "tools": [
                {
                    "name": "echo",
                    "description": "Echo a message",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "message": { "type": "string" }
                        },
                        "required": ["message"]
                    }
                }
            ]
        });

        let tools = parse_tool_defs("test-server", &result);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].qualified_name, "test-server/echo");
        assert_eq!(tools[0].description, "Echo a message");
        assert!(!tools[0].read_only);
    }

    #[test]
    fn test_parse_tool_defs_read_only_hint() {
        let result = serde_json::json!({
            "tools": [
                {
                    "name": "get_status",
                    "description": "Get status",
                    "inputSchema": { "type": "object", "properties": {} },
                    "annotations": { "readOnlyHint": true }
                },
                {
                    "name": "delete_item",
                    "description": "Delete item",
                    "inputSchema": { "type": "object", "properties": {} },
                    "annotations": { "readOnlyHint": false }
                }
            ]
        });

        let tools = parse_tool_defs("srv", &result);
        assert_eq!(tools.len(), 2);
        assert!(tools[0].read_only);
        assert!(!tools[1].read_only);
    }

    #[test]
    fn test_parse_tool_defs_empty() {
        let result = serde_json::json!({});
        let tools = parse_tool_defs("srv", &result);
        assert!(tools.is_empty());
    }

    #[test]
    fn test_qualified_name_format() {
        let result = serde_json::json!({
            "tools": [{ "name": "my_tool", "inputSchema": {} }]
        });
        let tools = parse_tool_defs("my-server", &result);
        assert_eq!(tools[0].qualified_name, "my-server/my_tool");
    }

    #[test]
    fn test_server_config_serde() {
        let config = McpServerConfig {
            id: "test-id".to_string(),
            name: "Test Server".to_string(),
            transport: McpTransport::Stdio {
                command: "npx".to_string(),
                args: vec!["-y".to_string(), "some-mcp-server".to_string()],
            },
            enabled: true,
            auth_token: Some("secret-token".to_string()),
        };

        // auth_token should be skipped in serialization
        let json = serde_json::to_string(&config).unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.get("auth_token").is_none());
        assert_eq!(parsed["id"], "test-id");
        assert_eq!(parsed["name"], "Test Server");
    }
}
