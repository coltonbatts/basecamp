use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

pub mod capabilities;
pub mod llama_cpp;
pub mod lmstudio;
pub mod ollama;
pub mod openrouter;
pub mod registry;

pub use capabilities::{ProviderCapabilities, ProviderKind, StreamProtocol};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BasecampChatRequest {
    pub provider_kind: ProviderKind,
    pub model_id: String,
    pub messages: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub metadata: BasecampChatMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BasecampChatMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camp_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<ProviderKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModel {
    pub provider_kind: ProviderKind,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<i64>,
    pub capabilities: ProviderCapabilities,
    pub raw_json: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthStatus {
    pub provider_kind: ProviderKind,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub provider_kind: ProviderKind,
    pub base_url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRuntimeSettings {
    pub config: ProviderConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedAssistantMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<Value>,
}

impl Default for NormalizedAssistantMessage {
    fn default() -> Self {
        Self {
            role: "assistant".to_string(),
            content: Some(Value::String(String::new())),
            tool_calls: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    ChatDelta {
        correlation_id: String,
        role: String,
        content_delta: String,
    },
    ToolCallDelta {
        correlation_id: String,
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments_delta: String,
    },
    ChatComplete {
        correlation_id: String,
        usage: ProviderUsage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
    },
    ChatError {
        correlation_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderChatResponse {
    pub provider_kind: ProviderKind,
    pub base_url: String,
    pub response_payload: Value,
    pub output_text: String,
    pub assistant_message: NormalizedAssistantMessage,
    pub usage: ProviderUsage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    pub status: u16,
    pub duration_ms: i64,
    pub response_headers: BTreeMap<String, String>,
    pub stream_chunk_count: usize,
    pub sanitized_request_payload: Value,
    pub sanitized_response_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub response_payload: Value,
}

impl ProviderError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            response_payload: Value::Null,
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCommandError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub response_payload: Value,
}

impl From<ProviderError> for ProviderCommandError {
    fn from(value: ProviderError) -> Self {
        Self {
            message: value.message,
            status: value.status,
            response_payload: value.response_payload,
        }
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self) -> ProviderCapabilities;

    fn supports_streaming(&self) -> bool {
        self.capabilities().stream_protocol != StreamProtocol::None
    }

    fn supports_tools(&self) -> bool {
        self.capabilities().supports_tools
    }

    async fn list_models(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<Vec<ProviderModel>, ProviderError>;

    async fn health_check(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<ProviderHealthStatus, ProviderError>;

    async fn send_chat(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
        request: &BasecampChatRequest,
        on_event: Option<&Channel<ChatStreamEvent>>,
    ) -> Result<ProviderChatResponse, ProviderError>;

    fn normalize_response(&self, payload: &Value) -> NormalizedAssistantMessage;

    fn sanitize_for_logs(&self, value: &Value) -> Value {
        redact_json(value)
    }
}

pub struct ProviderManager {
    openrouter: openrouter::OpenRouterProvider,
    lmstudio: lmstudio::LmStudioProvider,
    ollama: ollama::OllamaProvider,
    llama_cpp: llama_cpp::LlamaCppProvider,
}

impl ProviderManager {
    pub fn new() -> Self {
        Self {
            openrouter: openrouter::OpenRouterProvider::new(),
            lmstudio: lmstudio::LmStudioProvider::new(),
            ollama: ollama::OllamaProvider::new(),
            llama_cpp: llama_cpp::LlamaCppProvider::new(),
        }
    }

    pub fn get(&self, kind: ProviderKind) -> &dyn Provider {
        match kind {
            ProviderKind::Openrouter => &self.openrouter,
            ProviderKind::Lmstudio => &self.lmstudio,
            ProviderKind::Ollama => &self.ollama,
            ProviderKind::LlamaCpp => &self.llama_cpp,
        }
    }
}

impl Default for ProviderManager {
    fn default() -> Self {
        Self::new()
    }
}

pub fn now_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn sanitize_headers(headers: &reqwest::header::HeaderMap) -> BTreeMap<String, String> {
    let mut safe = BTreeMap::new();
    for (name, value) in headers {
        let key = name.as_str().to_ascii_lowercase();
        if key == "set-cookie"
            || key == "cookie"
            || key == "authorization"
            || key == "proxy-authorization"
            || key == "x-api-key"
        {
            continue;
        }

        if let Ok(text) = value.to_str() {
            safe.insert(name.as_str().to_string(), text.to_string());
        }
    }

    safe
}

pub fn normalized_message_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                Value::Object(object) => object
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                _ => String::new(),
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

pub fn parse_usage(payload: &Value) -> ProviderUsage {
    let usage = payload.get("usage").and_then(Value::as_object);
    ProviderUsage {
        prompt_tokens: usage
            .and_then(|entry| entry.get("prompt_tokens"))
            .and_then(Value::as_i64),
        completion_tokens: usage
            .and_then(|entry| entry.get("completion_tokens"))
            .and_then(Value::as_i64),
        total_tokens: usage
            .and_then(|entry| entry.get("total_tokens"))
            .and_then(Value::as_i64),
    }
}

pub fn parse_finish_reason(payload: &Value) -> Option<String> {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

pub fn parse_resolved_model(payload: &Value) -> Option<String> {
    payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn parse_openai_assistant_message(payload: &Value) -> NormalizedAssistantMessage {
    let default_message = Value::Object(serde_json::Map::new());
    let message = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .unwrap_or(&default_message);

    let content = message.get("content").cloned();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    NormalizedAssistantMessage {
        role: "assistant".to_string(),
        content,
        tool_calls,
    }
}

pub fn correlation_id_for(request: &BasecampChatRequest) -> String {
    request
        .metadata
        .correlation_id
        .clone()
        .unwrap_or_else(|| format!("corr-{}", now_timestamp_ms()))
}

pub fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            for (key, item) in map {
                if is_secret_key(key) {
                    next.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    next.insert(key.clone(), redact_json(item));
                }
            }
            Value::Object(next)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_json).collect()),
        _ => value.clone(),
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    normalized.contains("authorization")
        || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn redact_json_should_remove_sensitive_fields_recursively() {
        let payload = serde_json::json!({
            "Authorization": "Bearer secret-token",
            "nested": {
                "api_key": "top-secret",
                "token": "abc",
                "safe": "value"
            },
            "array": [
                { "password": "1234" },
                { "value": "ok" }
            ]
        });

        let redacted = redact_json(&payload);
        assert_eq!(
            redacted.get("Authorization").and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            redacted
                .get("nested")
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("api_key"))
                .and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            redacted
                .get("nested")
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("safe"))
                .and_then(Value::as_str),
            Some("value")
        );
        assert_eq!(
            redacted
                .get("array")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("password"))
                .and_then(Value::as_str),
            Some("[REDACTED]")
        );
    }
}
