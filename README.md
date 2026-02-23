# Basecamp v0.1

Basecamp is a local-first Tauri desktop app for structured LLM project work.

It is intentionally not a generic chat client.

## Core Concept

A **Camp** is a persistent local project folder containing:

- selected OpenRouter model
- system prompt
- structured memory (JSON)
- append-only transcript history
- reusable markdown artifacts promoted from transcript messages
- optional context files

All Camp state is visible on disk.

## Local File Layout

Workspace root:

```text
<workspace>/
  camps/
    <camp_id>/
      camp.json
      system_prompt.md
      memory.json
      transcript.jsonl
      artifacts/
        index.json
        <artifact_id>.md
      context/
```

Reference: [docs/v0.1-architecture.md](./docs/v0.1-architecture.md)

## Current Stack

- Tauri v2 (Rust backend)
- React + TypeScript (Vite)
- OpenRouter API
- SQLite (settings + model cache)
- OS keyring (OpenRouter API key)

## Artifact Workflow (v0.1.1)

1. Promote any transcript message into an artifact markdown file.
2. Artifacts are indexed in `artifacts/index.json` with usage metadata.
3. Select artifacts in the composer before sending a new message.
4. Selected artifact IDs are persisted on the user transcript entry (`included_artifact_ids`).
5. Request composition includes selected artifacts deterministically before transcript history.
6. Progression badge is derived locally from artifact count, reused artifact count, and conversation turns.

## Camp Setup Workflow

- Basecamp auto-initializes a default root folder at `~/Basecamp` (you can still switch via `Pick Workspace`).
- Use the **Trailhead** setup flow to create a camp workspace by selecting:
  - camp name
  - model
- model search/filter (plus refresh models in-place)
- Each new camp is created as its own local folder under `<workspace>/camps/<camp_id>/`.

## Run

```bash
npm install
npm run tauri dev
```

Quickest desktop launch (macOS):

1. Double-click `launch-basecamp.command` in this repo.
2. Or run `npm run desktop`.
