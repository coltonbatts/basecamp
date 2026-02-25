use futures_util::StreamExt;
use serde_json::Value;

use super::{
    correlation_id_for, now_timestamp_ms, sanitize_headers, BasecampChatRequest, ChatStreamEvent,
    NormalizedAssistantMessage, Provider, ProviderCapabilities, ProviderChatResponse,
    ProviderError, ProviderHealthStatus, ProviderKind, ProviderModel, ProviderRuntimeSettings,
    ProviderUsage, StreamProtocol,
};

pub struct OllamaProvider;

impl OllamaProvider {
    pub fn new() -> Self {
        Self
    }
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn parse_context_length(value: Option<&Value>) -> Option<i64> {
    let raw = value?;
    if let Some(number) = raw.as_i64() {
        return Some(number.max(0));
    }
    if let Some(number) = raw.as_u64() {
        return i64::try_from(number).ok();
    }
    raw.as_str()
        .and_then(|text| text.trim().parse::<i64>().ok())
        .map(|value| value.max(0))
}

fn parse_ollama_error_message(status: u16, payload: &Value) -> String {
    payload
        .get("error")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("Ollama request failed with status {status}"))
}

fn normalize_image_data_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((prefix, data)) = trimmed.split_once(',') {
        if prefix.to_ascii_lowercase().contains("base64") {
            let normalized = data.trim();
            if !normalized.is_empty() {
                return Some(normalized.to_string());
            }
        }
    }
    None
}

fn extract_text_and_images(content: &Value) -> (String, Vec<String>) {
    match content {
        Value::String(text) => (text.clone(), Vec::new()),
        Value::Array(parts) => {
            let mut text_parts = Vec::new();
            let mut images = Vec::new();
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        text_parts.push(text.to_string());
                    }
                }
                if let Some(url) = part
                    .get("image_url")
                    .and_then(Value::as_object)
                    .and_then(|image| image.get("url"))
                    .and_then(Value::as_str)
                {
                    if let Some(image) = normalize_image_data_url(url) {
                        images.push(image);
                    }
                }
            }
            (text_parts.join("\n"), images)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .map(|text| (text.to_string(), Vec::new()))
            .unwrap_or_else(|| (String::new(), Vec::new())),
        _ => (String::new(), Vec::new()),
    }
}

fn openai_tool_calls_to_ollama(tool_calls: &[Value]) -> Vec<Value> {
    let mut mapped = Vec::new();
    for tool_call in tool_calls {
        let function_name = tool_call
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str);
        let function_arguments = tool_call
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("arguments"));
        let Some(name) = function_name else {
            continue;
        };
        let arguments = match function_arguments {
            Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        };
        mapped.push(serde_json::json!({
            "function": {
                "name": name,
                "arguments": arguments
            }
        }));
    }
    mapped
}

pub(crate) fn map_openai_messages_to_ollama(messages: &[Value]) -> Vec<Value> {
    let mut mapped = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        let empty_content = Value::String(String::new());
        let content_value = message.get("content").unwrap_or(&empty_content);
        let (content, images) = extract_text_and_images(content_value);
        let mut next = serde_json::Map::new();
        next.insert("role".to_string(), Value::String(role.clone()));
        next.insert("content".to_string(), Value::String(content));

        if !images.is_empty() {
            next.insert(
                "images".to_string(),
                Value::Array(images.into_iter().map(Value::String).collect()),
            );
        }

        if role == "assistant" {
            let tool_calls = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| openai_tool_calls_to_ollama(calls))
                .unwrap_or_default();
            if !tool_calls.is_empty() {
                next.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
        }

        if role == "tool" {
            if let Some(name) = message.get("name").and_then(Value::as_str) {
                next.insert("name".to_string(), Value::String(name.to_string()));
            }
            if let Some(tool_call_id) = message.get("tool_call_id").and_then(Value::as_str) {
                next.insert(
                    "tool_call_id".to_string(),
                    Value::String(tool_call_id.to_string()),
                );
            }
        }

        mapped.push(Value::Object(next));
    }
    mapped
}

pub(crate) fn map_ollama_tool_calls_to_openai(tool_calls: &[Value]) -> Vec<Value> {
    let mut mapped = Vec::new();
    for (index, tool_call) in tool_calls.iter().enumerate() {
        let function = tool_call.get("function").and_then(Value::as_object);
        let Some(function_name) = function
            .and_then(|entry| entry.get("name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let arguments = function
            .and_then(|entry| entry.get("arguments"))
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new()));
        let arguments_json = match arguments {
            Value::String(raw) => raw,
            other => serde_json::to_string(&other).unwrap_or_else(|_| "{}".to_string()),
        };

        mapped.push(serde_json::json!({
            "id": format!("ollama-tool-{index}"),
            "type": "function",
            "function": {
                "name": function_name,
                "arguments": arguments_json
            }
        }));
    }
    mapped
}

pub(crate) fn normalize_ollama_message(payload: &Value) -> NormalizedAssistantMessage {
    let default_message = Value::Object(serde_json::Map::new());
    let message = payload.get("message").unwrap_or(&default_message);
    let content = message.get("content").cloned();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| map_ollama_tool_calls_to_openai(calls))
        .unwrap_or_default();
    NormalizedAssistantMessage {
        role: "assistant".to_string(),
        content,
        tool_calls,
    }
}

fn parse_ollama_usage(payload: &Value) -> ProviderUsage {
    let prompt_tokens = payload.get("prompt_eval_count").and_then(Value::as_i64);
    let completion_tokens = payload.get("eval_count").and_then(Value::as_i64);
    ProviderUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: match (prompt_tokens, completion_tokens) {
            (Some(prompt), Some(completion)) => Some(prompt + completion),
            _ => None,
        },
    }
}

#[async_trait::async_trait]
impl Provider for OllamaProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Ollama
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            supports_tools: true,
            supports_images: true,
            supports_json_schema: false,
            max_context_tokens: None,
            stream_protocol: StreamProtocol::Ndjson,
        }
    }

    async fn list_models(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<Vec<ProviderModel>, ProviderError> {
        let response = client
            .get(endpoint(&settings.config.base_url, "/api/tags"))
            .send()
            .await
            .map_err(|err| {
                ProviderError::new(format!("Ollama model list request failed: {err}"))
            })?;
        let status = response.status().as_u16();
        let is_success = response.status().is_success();
        let payload = response.json::<Value>().await.unwrap_or(Value::Null);
        if !is_success {
            return Err(ProviderError {
                message: parse_ollama_error_message(status, &payload),
                status: Some(status),
                response_payload: payload,
            });
        }

        let raw_models = payload
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let capabilities = self.capabilities();
        let mut models = Vec::new();
        for raw_model in raw_models {
            let model_id = raw_model
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| raw_model.get("model").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let Some(model_id) = model_id else {
                continue;
            };
            let display_name = raw_model
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .or_else(|| Some(model_id.clone()));

            let context_length = parse_context_length(
                raw_model
                    .get("details")
                    .and_then(Value::as_object)
                    .and_then(|details| details.get("context_length")),
            );

            models.push(ProviderModel {
                provider_kind: ProviderKind::Ollama,
                model_id,
                display_name,
                context_length,
                capabilities: capabilities.clone(),
                raw_json: raw_model,
            });
        }
        Ok(models)
    }

    async fn health_check(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<ProviderHealthStatus, ProviderError> {
        let response = client
            .get(endpoint(&settings.config.base_url, "/api/tags"))
            .send()
            .await
            .map_err(|err| ProviderError::new(format!("Ollama health check failed: {err}")))?;
        let status = response.status().as_u16();
        if response.status().is_success() {
            return Ok(ProviderHealthStatus {
                provider_kind: ProviderKind::Ollama,
                ok: true,
                status_code: Some(status),
                message: Some(format!("Ollama reachable at {}", settings.config.base_url)),
                checked_at: now_timestamp_ms(),
            });
        }
        let payload = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok(ProviderHealthStatus {
            provider_kind: ProviderKind::Ollama,
            ok: false,
            status_code: Some(status),
            message: Some(format!(
                "Ollama not reachable at {} ({})",
                settings.config.base_url,
                parse_ollama_error_message(status, &payload)
            )),
            checked_at: now_timestamp_ms(),
        })
    }

    async fn send_chat(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
        request: &BasecampChatRequest,
        on_event: Option<&tauri::ipc::Channel<ChatStreamEvent>>,
    ) -> Result<ProviderChatResponse, ProviderError> {
        let started_at = now_timestamp_ms();
        let correlation_id = correlation_id_for(request);
        let mut options = serde_json::Map::new();
        if let Some(temperature) = request.temperature {
            options.insert("temperature".to_string(), Value::from(temperature));
        }
        if let Some(max_tokens) = request.max_tokens {
            options.insert("num_predict".to_string(), Value::from(max_tokens));
        }
        if let Some(top_p) = request.top_p {
            options.insert("top_p".to_string(), Value::from(top_p));
        }

        let mut payload = serde_json::Map::new();
        payload.insert("model".to_string(), Value::String(request.model_id.clone()));
        payload.insert(
            "messages".to_string(),
            Value::Array(map_openai_messages_to_ollama(&request.messages)),
        );
        payload.insert("stream".to_string(), Value::Bool(request.stream));
        if !options.is_empty() {
            payload.insert("options".to_string(), Value::Object(options));
        }
        if let Some(tools) = &request.tools {
            payload.insert("tools".to_string(), Value::Array(tools.clone()));
        }
        let request_json = Value::Object(payload.clone());

        let response = client
            .post(endpoint(&settings.config.base_url, "/api/chat"))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|err| ProviderError::new(format!("Ollama request failed: {err}")))?;
        let status = response.status().as_u16();
        let response_headers = sanitize_headers(response.headers());
        if !response.status().is_success() {
            let error_payload = response.json::<Value>().await.unwrap_or(Value::Null);
            let message = parse_ollama_error_message(status, &error_payload);
            let _ = on_event.map(|channel| {
                channel.send(ChatStreamEvent::ChatError {
                    correlation_id,
                    message: message.clone(),
                })
            });
            return Err(ProviderError {
                message,
                status: Some(status),
                response_payload: error_payload,
            });
        }

        if !request.stream {
            let payload = response.json::<Value>().await.map_err(|err| {
                ProviderError::new(format!("Unable to parse Ollama JSON response: {err}"))
            })?;
            let output_text = payload
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let assistant_message = self.normalize_response(&payload);
            return Ok(ProviderChatResponse {
                provider_kind: ProviderKind::Ollama,
                base_url: settings.config.base_url.clone(),
                response_payload: payload.clone(),
                output_text,
                assistant_message,
                usage: parse_ollama_usage(&payload),
                resolved_model: payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                finish_reason: payload
                    .get("done_reason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                status,
                duration_ms: (now_timestamp_ms() - started_at).max(0),
                response_headers,
                stream_chunk_count: 0,
                sanitized_request_payload: self.sanitize_for_logs(&request_json),
                sanitized_response_payload: self.sanitize_for_logs(&payload),
            });
        }

        let mut stream = response.bytes_stream();
        let mut output_text = String::new();
        let mut usage = ProviderUsage::default();
        let mut resolved_model: Option<String> = None;
        let mut finish_reason: Option<String> = None;
        let mut stream_chunk_count = 0usize;
        let mut buffer = String::new();
        let mut observed_tool_calls = Vec::<Value>::new();

        while let Some(next_chunk) = stream.next().await {
            let bytes = next_chunk.map_err(|err| {
                ProviderError::new(format!("Unable to read Ollama stream: {err}"))
            })?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(split_index) = buffer.find('\n') {
                let raw_line = buffer[..split_index].trim().to_string();
                buffer = buffer[split_index + 1..].to_string();
                if raw_line.is_empty() {
                    continue;
                }
                let Ok(chunk_value) = serde_json::from_str::<Value>(&raw_line) else {
                    continue;
                };
                stream_chunk_count += 1;

                if let Some(model) = chunk_value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                {
                    resolved_model = Some(model);
                }
                let next_usage = parse_ollama_usage(&chunk_value);
                usage.prompt_tokens = next_usage.prompt_tokens.or(usage.prompt_tokens);
                usage.completion_tokens = next_usage.completion_tokens.or(usage.completion_tokens);
                usage.total_tokens = next_usage.total_tokens.or(usage.total_tokens);

                if let Some(reason) = chunk_value
                    .get("done_reason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                {
                    finish_reason = Some(reason);
                }

                let token = chunk_value
                    .get("message")
                    .and_then(Value::as_object)
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !token.is_empty() {
                    output_text.push_str(&token);
                    let _ = on_event.map(|channel| {
                        channel.send(ChatStreamEvent::ChatDelta {
                            correlation_id: correlation_id.clone(),
                            role: "assistant".to_string(),
                            content_delta: token,
                        })
                    });
                }

                if let Some(tool_calls) = chunk_value
                    .get("message")
                    .and_then(Value::as_object)
                    .and_then(|message| message.get("tool_calls"))
                    .and_then(Value::as_array)
                {
                    let mapped = map_ollama_tool_calls_to_openai(tool_calls);
                    for tool_call in &mapped {
                        let tool_call_id = tool_call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("ollama-tool")
                            .to_string();
                        let name = tool_call
                            .get("function")
                            .and_then(Value::as_object)
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string);
                        let args = tool_call
                            .get("function")
                            .and_then(Value::as_object)
                            .and_then(|function| function.get("arguments"))
                            .and_then(Value::as_str)
                            .unwrap_or("{}")
                            .to_string();
                        let _ = on_event.map(|channel| {
                            channel.send(ChatStreamEvent::ToolCallDelta {
                                correlation_id: correlation_id.clone(),
                                tool_call_id,
                                name,
                                arguments_delta: args,
                            })
                        });
                    }
                    observed_tool_calls.extend(mapped);
                }
            }
        }

        let summary_payload = serde_json::json!({
            "chunks_processed": stream_chunk_count,
            "output_text": output_text,
            "usage": usage,
            "resolved_model": resolved_model,
            "finish_reason": finish_reason,
            "tool_calls": observed_tool_calls,
        });
        let _ = on_event.map(|channel| {
            channel.send(ChatStreamEvent::ChatComplete {
                correlation_id: correlation_id.clone(),
                usage: usage.clone(),
                finish_reason: finish_reason.clone(),
            })
        });

        Ok(ProviderChatResponse {
            provider_kind: ProviderKind::Ollama,
            base_url: settings.config.base_url.clone(),
            response_payload: summary_payload.clone(),
            output_text: output_text.clone(),
            assistant_message: NormalizedAssistantMessage {
                role: "assistant".to_string(),
                content: Some(Value::String(output_text)),
                tool_calls: observed_tool_calls,
            },
            usage,
            resolved_model,
            finish_reason,
            status,
            duration_ms: (now_timestamp_ms() - started_at).max(0),
            response_headers,
            stream_chunk_count,
            sanitized_request_payload: self.sanitize_for_logs(&request_json),
            sanitized_response_payload: self.sanitize_for_logs(&summary_payload),
        })
    }

    fn normalize_response(&self, payload: &Value) -> NormalizedAssistantMessage {
        normalize_ollama_message(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::BasecampChatMetadata;
    use httpmock::{Method::GET, Method::POST, MockServer};
    use serde_json::Value;

    fn test_settings(base_url: &str) -> ProviderRuntimeSettings {
        ProviderRuntimeSettings {
            config: super::super::ProviderConfig {
                provider_kind: ProviderKind::Ollama,
                base_url: base_url.to_string(),
                enabled: true,
            },
            api_key: None,
        }
    }

    #[test]
    fn map_openai_messages_to_ollama_should_include_images_and_tool_calls() {
        let messages = vec![
            serde_json::json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "describe image" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAABBBB" } }
                ]
            }),
            serde_json::json!({
                "role": "assistant",
                "content": "calling tool",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"README.md\"}"
                        }
                    }
                ]
            }),
        ];

        let mapped = map_openai_messages_to_ollama(&messages);
        assert_eq!(mapped.len(), 2);
        assert_eq!(
            mapped[0]
                .get("images")
                .and_then(Value::as_array)
                .and_then(|images| images.first())
                .and_then(Value::as_str),
            Some("AAAABBBB")
        );
        assert_eq!(
            mapped[1]
                .get("tool_calls")
                .and_then(Value::as_array)
                .and_then(|calls| calls.first())
                .and_then(|call| call.get("function"))
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str),
            Some("read_file")
        );
    }

    #[test]
    fn normalize_ollama_message_should_map_tool_calls_to_openai_shape() {
        let payload = serde_json::json!({
            "message": {
                "content": "tool result",
                "tool_calls": [
                    {
                        "function": {
                            "name": "list_files",
                            "arguments": {
                                "path": "context/"
                            }
                        }
                    }
                ]
            }
        });

        let normalized = normalize_ollama_message(&payload);
        assert_eq!(normalized.role, "assistant");
        assert_eq!(
            normalized
                .content
                .and_then(|value| value.as_str().map(ToString::to_string)),
            Some("tool result".to_string())
        );
        assert_eq!(normalized.tool_calls.len(), 1);
        assert_eq!(
            normalized.tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str),
            Some("list_files")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ollama_list_models_smoke() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(GET).path("/api/tags");
            then.status(200).json_body(serde_json::json!({
                "models": [
                    {
                        "name": "llama3.2:3b",
                        "details": {
                            "context_length": 8192
                        }
                    }
                ]
            }));
        });

        let provider = OllamaProvider::new();
        let client = reqwest::Client::new();
        let models = provider
            .list_models(&client, &test_settings(&server.base_url()))
            .await
            .expect("ollama list_models should succeed");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "llama3.2:3b");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ollama_stream_chat_smoke() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/api/chat");
            then.status(200)
                .header("content-type", "application/x-ndjson")
                .body(
                    "{\"model\":\"llama3.2:3b\",\"message\":{\"role\":\"assistant\",\"content\":\"Hello \"},\"done\":false}\n\
                     {\"model\":\"llama3.2:3b\",\"message\":{\"role\":\"assistant\",\"content\":\"there\"},\"prompt_eval_count\":2,\"eval_count\":3,\"done\":true,\"done_reason\":\"stop\"}\n",
                );
        });

        let provider = OllamaProvider::new();
        let client = reqwest::Client::new();
        let request = BasecampChatRequest {
            provider_kind: ProviderKind::Ollama,
            model_id: "llama3.2:3b".to_string(),
            messages: vec![serde_json::json!({
                "role": "user",
                "content": "Say hi"
            })],
            tools: None,
            tool_choice: None,
            temperature: Some(0.1),
            max_tokens: Some(32),
            top_p: None,
            stream: true,
            metadata: BasecampChatMetadata {
                camp_id: Some("camp-ollama".to_string()),
                correlation_id: Some("corr-ollama-smoke".to_string()),
                provider_kind: Some(ProviderKind::Ollama),
            },
        };

        let response = provider
            .send_chat(&client, &test_settings(&server.base_url()), &request, None)
            .await
            .expect("ollama chat should succeed");

        assert_eq!(response.output_text, "Hello there");
        assert_eq!(response.resolved_model.as_deref(), Some("llama3.2:3b"));
        assert_eq!(response.usage.total_tokens, Some(5));
    }
}
