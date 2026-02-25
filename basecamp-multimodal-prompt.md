# Basecamp Architectural Upgrade: Multimodal & File Generation Capabilities

## Project Overview

Basecamp is a personal cognitive IDE for running AI models via OpenRouter.ai. Currently, it excels at text-based operations and basic tool calling. However, when a model attempts to generate a non-text file (e.g., a PDF, an image) without explicitly using a tool, it often dumps raw Base64 data directly into the chat transcript.

The goal of this architectural upgrade is to make Basecamp fully multimodal. A user should be able to ask a model to "create a PDF," "generate an image," or "analyze this screenshot," and the application should handle the files natively, displaying them correctly without exposing raw data strings to the user.

---

## 1. System Prompt & Tool-Enforcement Architecture

The cleanest way to handle file creation from modern LLMs is to force them to use tools, rather than trying to parse raw outputs.

- **Objective:** Prevent the model from dumping Base64 directly into the text response.
- **Action:** Update the global camp system prompt or the tool definition instructions to strictly enforce file-generation rules.
  - *Example Prompt Addition:* "When the user asks you to generate a file, image, or document (such as a PDF), you MUST use the `create_artifact` or `write_file` tool to save it. Under no circumstances should you output raw binary or base64 data directly into your conversational response."
- **Fallback Parser (Optional but recommended):** Implement a pre-processor in `src/lib/openrouter.ts` (inside `runToolUseLoop` or `streamOpenRouterChatCompletion`) that uses a regex to detect raw Base64 strings (like `JVBERi0...` for PDF or `iVBORw0K...` for PNG). If detected, automatically extract the Base64 block, convert it into a `CampArtifact`, and replace the Base64 string in the UI transcript with a clean reference link (e.g., `[Generated PDF Artifact]`).

## 2. Multimodal Input (Vision & Document Analysis)

Models like Claude 3.5 Sonnet and Gemini 1.5 Pro support multimodal inputs (images, PDFs). Basecamp needs to support sending these files alongside the prompt.

- **UI Updates (`CampChat.tsx` / `Composer`):**
  - Add drag-and-drop support and a file attachment button to the chat composer.
  - Store attached files in local state before sending.
- **Data Pipeline (`openrouter.ts` & `campChatRuntime.ts`):**
  - Read the attached files using Tauri's filesystem API and convert them to Base64 data URIs.
  - Update `OpenRouterChatMessage` and the `buildOpenRouterPayload` function to support array-based content blocks required by OpenRouter for multimodal messages:

    ```json
    "content": [
      { "type": "text", "text": "What is in this image?" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
    ```

## 3. Rich Canvas & Artifact Renderers

When an artifact is created—either via the `create_artifact` tool or written to disk via `write_file`—the UI must be able to render it instead of just displaying raw text.

- **Canvas View (`CampWorkspaceView.tsx` / Canvas components):**
  - Currently, if you open a file in the Canvas, it assumes text.
  - Implement content-type sniffing (checking magic bytes or file extensions).
  - **Image Renderer:** If the artifact is an image (`.png`, `.jpg`, `.webp`), render an `<img src={base64_or_local_file_url} />`.
  - **PDF Renderer:** If the artifact is a PDF (`.pdf`), render it using an `<object>` tag or an `<iframe>`:

    ```html
    <object data={`data:application/pdf;base64,${base64Data}`} type="application/pdf" width="100%" height="100%">
      <p>Unable to display PDF file.</p>
    </object>
    ```

  - **HTML Renderer:** Provide a sandboxed `<iframe>` to render generated HTML/CSS/JS artifacts directly in the Canvas.

## 4. Expanding the Tool Registry for Media

To fully support "anything a model can do," ensure the tools provided to the model in `src/lib/tools.ts` are capable of handling varied content types.

- Ensure `write_file` and `create_artifact` tools can explicitly accept an `encoding` parameter (e.g., `utf-8` or `base64`), allowing the LLM to choose how it passes the data to the Rust backend.
- *Rationale:* If an LLM generates an image, it will generate base64. The `write_file` tool needs to know to decode that base64 back into raw bytes before writing it to disk via Tauri, rather than writing a text file containing the base64 string.

## Summary of Deliverables for this Upgrade

1. **System Prompt Update:** Instruct models to *always* use tools for file generation.
2. **Tool Parameter Updates:** Add an `encoding` field to `write_file` and `create_artifact` args schema to properly decode base64.
3. **Chat Composer Upgrades:** Add UI and data-pipeline support for attaching files to messages (Vision API support).
4. **Canvas Renderers:** Add conditional rendering in the Canvas capable of displaying Images, PDFs, and HTML natively.
5. **Base64 Fallback Interceptor:** (Optional) Intercept massive base64 text dumps in the chat stream and convert them into silent artifacts.
