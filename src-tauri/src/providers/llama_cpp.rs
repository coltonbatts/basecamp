use serde_json::Value;

use super::{
    lmstudio::LmStudioProvider, BasecampChatRequest, ChatStreamEvent, NormalizedAssistantMessage,
    Provider, ProviderCapabilities, ProviderChatResponse, ProviderError, ProviderHealthStatus,
    ProviderKind, ProviderModel, ProviderRuntimeSettings, StreamProtocol,
};

pub struct LlamaCppProvider {
    inner: LmStudioProvider,
}

impl LlamaCppProvider {
    pub fn new() -> Self {
        Self {
            inner: LmStudioProvider::new(),
        }
    }
}

#[async_trait::async_trait]
impl Provider for LlamaCppProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::LlamaCpp
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            supports_tools: true,
            supports_images: true,
            supports_json_schema: false,
            max_context_tokens: None,
            stream_protocol: StreamProtocol::Sse,
        }
    }

    async fn list_models(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<Vec<ProviderModel>, ProviderError> {
        let mut rows = self.inner.list_models(client, settings).await?;
        for row in &mut rows {
            row.provider_kind = ProviderKind::LlamaCpp;
        }
        Ok(rows)
    }

    async fn health_check(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
    ) -> Result<ProviderHealthStatus, ProviderError> {
        let mut health = self.inner.health_check(client, settings).await?;
        health.provider_kind = ProviderKind::LlamaCpp;
        Ok(health)
    }

    async fn send_chat(
        &self,
        client: &reqwest::Client,
        settings: &ProviderRuntimeSettings,
        request: &BasecampChatRequest,
        on_event: Option<&tauri::ipc::Channel<ChatStreamEvent>>,
    ) -> Result<ProviderChatResponse, ProviderError> {
        let mut response = self
            .inner
            .send_chat(client, settings, request, on_event)
            .await?;
        response.provider_kind = ProviderKind::LlamaCpp;
        Ok(response)
    }

    fn normalize_response(&self, payload: &Value) -> NormalizedAssistantMessage {
        self.inner.normalize_response(payload)
    }
}
