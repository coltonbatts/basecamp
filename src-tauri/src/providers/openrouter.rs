use futures_util::StreamExt;
use serde_json::Value;

use super::{
    correlation_id_for, normalized_message_content, now_timestamp_ms, parse_finish_reason,
    parse_openai_assistant_message, parse_resolved_model, parse_usage, sanitize_headers,
    BasecampChatRequest, ChatStreamEvent, NormalizedAssistantMessage, Provider,
    ProviderCapabilities, ProviderChatResponse, ProviderError, ProviderHealthStatus, ProviderKind,
    ProviderModel, ProviderRuntimeSettings, ProviderUsage, StreamProtocol,
};

pub struct OpenRouterProvider;

impl OpenRouterProvider {
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

fn require_api_key(settings: &ProviderRuntimeSettings) -> Result<String, ProviderError> {
    settings
        .api_key
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderError::new("OpenRouter API key is missing. Save it in Settings first.")
        })
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

fn parse_openrouter_error_message(status: u16, payload: &Value) -> String {
    payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("OpenRouter request failed with status {status}"))
}

fn parse_openai_tool_deltas(chunk: &Value) -> Vec<(String, Option<String>, String)> {
    let mut deltas = Vec::new();
    let Some(tool_calls) = chunk
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("tool_calls"))
        .and_then(Value::as_array)
    else {
        return deltas;
    };

    for (index, tool_call) in tool_calls.iter().enumerate() {
        let id = tool_call
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .unwrap_or_else(|| format!("stream-tool-{index}"));
        let name = tool_call
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .map(|value| value.to_string());
        let arguments_delta = tool_call
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("arguments"))
            .map(normalized_message_content)
            .unwrap_or_default();
        if !arguments_delta.is_empty() || name.is_some() {
            deltas.push((id, name, arguments_delta));
        }
    }
    deltas
}

#[async_trait::async_trait]
impl Provider for OpenRouterProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Openrouter
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            supports_tools: true,
            supports_images: true,
            supports_json_schema: true,
            max_context_tokens: None,
            stream_protocol: StreamProtocol::Sse,
        }
    }

    async fn list_models(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<Vec<ProviderModel>, ProviderError> {
        let api_key = require_api_key(settings)?;
        let response = client
            .get(endpoint(&settings.config.base_url, "/models"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("HTTP-Referer", "http://localhost")
            .header("X-Title", "Basecamp")
            .send()
            .await
            .map_err(|err| {
                ProviderError::new(format!("OpenRouter model list request failed: {err}"))
            })?;

        let status = response.status().as_u16();
        let is_success = response.status().is_success();
        let payload = response.json::<Value>().await.unwrap_or(Value::Null);
        if !is_success {
            return Err(ProviderError {
                message: parse_openrouter_error_message(status, &payload),
                status: Some(status),
                response_payload: payload,
            });
        }

        let raw_models = if payload.is_array() {
            payload.as_array().cloned().unwrap_or_default()
        } else {
            payload
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };

        let capabilities = self.capabilities();
        let mut models = Vec::new();
        for raw_model in raw_models {
            let Some(model_id) = raw_model
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
            else {
                continue;
            };

            let display_name = raw_model
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);

            models.push(ProviderModel {
                provider_kind: ProviderKind::Openrouter,
                model_id,
                display_name,
                context_length: parse_context_length(raw_model.get("context_length")),
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
        let api_key = require_api_key(settings)?;
        let response = client
            .get(endpoint(&settings.config.base_url, "/models"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("HTTP-Referer", "http://localhost")
            .header("X-Title", "Basecamp")
            .send()
            .await
            .map_err(|err| ProviderError::new(format!("OpenRouter health check failed: {err}")))?;

        let status = response.status().as_u16();
        if response.status().is_success() {
            return Ok(ProviderHealthStatus {
                provider_kind: ProviderKind::Openrouter,
                ok: true,
                status_code: Some(status),
                message: Some("OpenRouter reachable".to_string()),
                checked_at: now_timestamp_ms(),
            });
        }

        let payload = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok(ProviderHealthStatus {
            provider_kind: ProviderKind::Openrouter,
            ok: false,
            status_code: Some(status),
            message: Some(parse_openrouter_error_message(status, &payload)),
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
        let api_key = require_api_key(settings)?;
        let started_at = now_timestamp_ms();
        let correlation_id = correlation_id_for(request);

        let mut payload = serde_json::Map::new();
        payload.insert("model".to_string(), Value::String(request.model_id.clone()));
        payload.insert(
            "messages".to_string(),
            Value::Array(request.messages.clone()),
        );
        payload.insert("stream".to_string(), Value::Bool(request.stream));
        if let Some(temperature) = request.temperature {
            payload.insert("temperature".to_string(), Value::from(temperature));
        }
        if let Some(max_tokens) = request.max_tokens {
            payload.insert("max_tokens".to_string(), Value::from(max_tokens));
        }
        if let Some(top_p) = request.top_p {
            payload.insert("top_p".to_string(), Value::from(top_p));
        }
        if let Some(tools) = &request.tools {
            payload.insert("tools".to_string(), Value::Array(tools.clone()));
        }
        if let Some(tool_choice) = &request.tool_choice {
            payload.insert("tool_choice".to_string(), tool_choice.clone());
        }
        let request_json = Value::Object(payload.clone());

        let response = client
            .post(endpoint(&settings.config.base_url, "/chat/completions"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("HTTP-Referer", "http://localhost")
            .header("X-Title", "Basecamp")
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|err| ProviderError::new(format!("OpenRouter request failed: {err}")))?;

        let status = response.status().as_u16();
        let response_headers = sanitize_headers(response.headers());
        if !response.status().is_success() {
            let error_payload = response.json::<Value>().await.unwrap_or(Value::Null);
            let message = parse_openrouter_error_message(status, &error_payload);
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
                ProviderError::new(format!("Unable to parse OpenRouter response JSON: {err}"))
            })?;
            let output_text = payload
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|message| message.get("content"))
                .map(normalized_message_content)
                .unwrap_or_default()
                .trim()
                .to_string();

            let assistant_message = self.normalize_response(&payload);
            return Ok(ProviderChatResponse {
                provider_kind: ProviderKind::Openrouter,
                base_url: settings.config.base_url.clone(),
                response_payload: payload.clone(),
                output_text,
                assistant_message,
                usage: parse_usage(&payload),
                resolved_model: parse_resolved_model(&payload),
                finish_reason: parse_finish_reason(&payload),
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

        while let Some(next_chunk) = stream.next().await {
            let bytes = next_chunk.map_err(|err| {
                ProviderError::new(format!("Unable to read OpenRouter stream: {err}"))
            })?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(split_index) = buffer.find("\n\n") {
                let raw_event = buffer[..split_index].to_string();
                buffer = buffer[split_index + 2..].to_string();

                for line in raw_event.lines() {
                    let trimmed = line.trim();
                    if !trimmed.starts_with("data:") {
                        continue;
                    }

                    let data = trimmed.trim_start_matches("data:").trim();
                    if data.is_empty() || data == "[DONE]" {
                        continue;
                    }

                    let Ok(chunk_value) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };
                    stream_chunk_count += 1;
                    if let Some(model) = parse_resolved_model(&chunk_value) {
                        resolved_model = Some(model);
                    }
                    let next_usage = parse_usage(&chunk_value);
                    usage.prompt_tokens = next_usage.prompt_tokens.or(usage.prompt_tokens);
                    usage.completion_tokens =
                        next_usage.completion_tokens.or(usage.completion_tokens);
                    usage.total_tokens = next_usage.total_tokens.or(usage.total_tokens);
                    finish_reason = parse_finish_reason(&chunk_value).or(finish_reason);

                    let token = chunk_value
                        .get("choices")
                        .and_then(Value::as_array)
                        .and_then(|choices| choices.first())
                        .and_then(|choice| choice.get("delta"))
                        .and_then(|delta| delta.get("content"))
                        .map(normalized_message_content)
                        .unwrap_or_default();
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

                    for (tool_call_id, name, arguments_delta) in
                        parse_openai_tool_deltas(&chunk_value)
                    {
                        let _ = on_event.map(|channel| {
                            channel.send(ChatStreamEvent::ToolCallDelta {
                                correlation_id: correlation_id.clone(),
                                tool_call_id,
                                name,
                                arguments_delta,
                            })
                        });
                    }
                }
            }
        }

        let summary_payload = serde_json::json!({
            "chunks_processed": stream_chunk_count,
            "output_text": output_text,
            "usage": usage,
            "resolved_model": resolved_model,
            "finish_reason": finish_reason,
        });

        let _ = on_event.map(|channel| {
            channel.send(ChatStreamEvent::ChatComplete {
                correlation_id: correlation_id.clone(),
                usage: usage.clone(),
                finish_reason: finish_reason.clone(),
            })
        });

        Ok(ProviderChatResponse {
            provider_kind: ProviderKind::Openrouter,
            base_url: settings.config.base_url.clone(),
            response_payload: summary_payload.clone(),
            output_text: output_text.clone(),
            assistant_message: NormalizedAssistantMessage {
                role: "assistant".to_string(),
                content: Some(Value::String(output_text)),
                tool_calls: vec![],
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
        parse_openai_assistant_message(payload)
    }
}
