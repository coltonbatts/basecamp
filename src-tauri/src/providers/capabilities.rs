use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openrouter,
    Lmstudio,
    Ollama,
    LlamaCpp,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Openrouter => "openrouter",
            ProviderKind::Lmstudio => "lmstudio",
            ProviderKind::Ollama => "ollama",
            ProviderKind::LlamaCpp => "llama_cpp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openrouter" => Some(ProviderKind::Openrouter),
            "lmstudio" | "lm_studio" => Some(ProviderKind::Lmstudio),
            "ollama" => Some(ProviderKind::Ollama),
            "llama_cpp" | "llamacpp" | "llama.cpp" => Some(ProviderKind::LlamaCpp),
            _ => None,
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            ProviderKind::Openrouter => "https://openrouter.ai/api/v1",
            ProviderKind::Lmstudio => "http://localhost:1234/v1",
            ProviderKind::Ollama => "http://localhost:11434",
            ProviderKind::LlamaCpp => "http://localhost:8080/v1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamProtocol {
    Sse,
    Ndjson,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    pub supports_tools: bool,
    pub supports_images: bool,
    pub supports_json_schema: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<i64>,
    pub stream_protocol: StreamProtocol,
}

impl ProviderCapabilities {
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            "{\"supports_tools\":false,\"supports_images\":false,\"supports_json_schema\":false,\"stream_protocol\":\"none\"}".to_string()
        })
    }
}

impl Default for ProviderCapabilities {
    fn default() -> Self {
        Self {
            supports_tools: false,
            supports_images: false,
            supports_json_schema: false,
            max_context_tokens: None,
            stream_protocol: StreamProtocol::None,
        }
    }
}
