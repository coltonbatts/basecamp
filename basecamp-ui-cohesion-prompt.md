# Basecamp UI Cohesion — Codex Prompt

## Project Overview

Basecamp is a Tauri desktop app (React 19 + TypeScript + Vite, no UI library). It's a personal cognitive IDE for running AI models via OpenRouter.ai, organized into "camps" — individual workspaces with system prompts, transcripts, context files, and artifacts.

The project lives at the root of this repo. All source is in `src/`.

---

## The Problem

There are currently **two completely different design systems** in the app:

1. **HomeView** (`src/index.css` + `src/views/HomeView.css`) — dark, brutal, minimal. Black background, Geist Pixel font, 3px solid borders, chamfered clip-path corners, `#ff4500` orange-red accent. This is the aesthetic we want everywhere.

2. **CampWorkspaceView** (`src/App.css`) — light glassmorphism. The `.trail-shell` class overrides the root design tokens with its own variables (`--surface`, `--ink`, `--accent: #1e6855`), adds `border-radius: 18px` everywhere, soft shadows, semi-transparent white panels. This needs to be replaced.

The `* { border-radius: 0 !important }` rule in `index.css` already fights `.trail-shell` — it's a symptom of the conflict.

---

## Design Tokens (source of truth — from `src/index.css`)

```css
:root {
  color-scheme: dark;
  --bg: #000000;
  --text: #f0ead6;
  --text-muted: #9c9a90;
  --accent: #ff4500;
  --line: #f0ead6;
  --line-strong: #f0ead6;

  --font-pixel: 'Geist Pixel', monospace;

  --text-xs: 0.75rem;
  --text-sm: 0.95rem;
  --text-base: 1.2rem;
  --text-lg: 2.5rem;
  --text-xl: 4rem;
  --text-xxl: 7rem;

  --border-width: 3px;
  --corner: 6px;

  --grid-unit: 8px;
  --space-1: 8px;
  --space-2: 16px;
  --space-3: 24px;
  --space-4: 32px;
  --space-5: 48px;
  --space-6: 64px;
}
```

The body already has a pixel-grid background overlay (`body::before`) and a scanline overlay (`body::after`). These should not be changed.

---

## The Chamfered Corner Pattern

This is the visual signature of the app. Use this `clip-path` on all panels, cards, buttons, inputs, selects, and textareas:

```css
clip-path: polygon(
  var(--corner) 0, calc(100% - var(--corner)) 0,
  100% var(--corner), 100% calc(100% - var(--corner)),
  calc(100% - var(--corner)) 100%, var(--corner) 100%,
  0 calc(100% - var(--corner)), 0 var(--corner)
);
```

---

## Design Rules to Apply Consistently

- **Background:** always `var(--bg)` (#000000). No semi-transparent whites. No gradients.
- **Panels:** `border: var(--border-width) solid var(--line); background: var(--bg);`
- **Text:** `var(--text)` for primary, `var(--text-muted)` for secondary/hints.
- **Labels and headings:** `text-transform: uppercase; letter-spacing: 0.05em–0.1em;`
- **Hover state for interactive elements:** invert — `background: var(--text); color: var(--bg);`. Instant, no transition delay (or `transition: all 0s`).
- **Focus state:** same as hover (no outline, invert instead).
- **Primary action buttons:** `background: var(--accent); color: var(--bg); border-color: var(--accent);`
- **Disabled state:** `opacity: 0.3; cursor: not-allowed;`
- **No box-shadow.** Use `filter: drop-shadow(Xpx Xpx 0 var(--accent))` on hero elements only (e.g., the main header panel).
- **No border-radius anywhere.** Already enforced globally but remove any per-component overrides.
- **Fonts:** everything uses `var(--font-pixel)` (Geist Pixel, already loaded via `@font-face` in index.css).
- **Spacing:** use the `--space-*` tokens.

---

## What to Change

### 1. Rewrite `src/App.css`

This file currently defines `.trail-shell` and all the workspace styles in the light glassmorphism language. **Replace the entire file** with a dark-theme equivalent that:

- Removes `.trail-shell` entirely (or makes it a no-op wrapper with no visual styling of its own — just `min-height: 100%; width: 100%; display: flex; flex-direction: column;`).
- Removes all `--surface`, `--surface-raised`, `--surface-muted`, `--ink`, `--ink-soft`, `--accent-strong`, `--danger` variable declarations (these were `.trail-shell`'s private overrides).
- Rewrites `.panel` to match the HomeView panel style: `border: var(--border-width) solid var(--line); background: var(--bg); padding: var(--space-3);` plus the chamfered clip-path.
- Rewrites `.trail-header` to match `.home-dashboard-header`: flat black, chamfered, with `filter: drop-shadow(16px 16px 0 var(--accent))` on the header itself.
- Rewrites `.message`, `.message-user`, `.message-assistant`, `.message-tool` — flat, dark, no colored backgrounds per role. Distinguish roles with border-left or a small role label, not background color.
- Rewrites all `button`, `input`, `select`, `textarea` base styles to match HomeView — flat dark, chamfered.
- Rewrites `.composer textarea` — dark background, `var(--text)` text, chamfered.
- Rewrites `.transcript-scroll`, `.artifact-scroll`, `.camp-list-scroll` — dark, subtle inset (e.g., `background: rgba(255,255,255,0.03); border: var(--border-width) solid var(--line);`), chamfered.
- Rewrites `.artifact-chip` — flat, dark, chamfered (not pill-shaped).
- Keeps all class names the same so no TSX files need to change just for styling reasons.
- Keeps the layout grid structure (`.trail-grid`, `.ide-grid`, `.trail-rail`, `.ide-explorer`, `.ide-canvas`, `.ide-chat` etc.) — just re-skin, don't restructure.
- Keeps `@keyframes panel-enter` (the subtle entrance animation) but it can be simplified.
- Keeps all responsive breakpoint media queries, just update values to be appropriate for the dark theme.

### 2. Restyle `.camp-list-item` in `App.css`

Currently white card with rounded corners. Rewrite to:
```css
.camp-list-item {
  border: var(--border-width) solid var(--line);
  background: var(--bg);
  color: var(--text);
  /* chamfered clip-path */
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  transition: background 0s, color 0s;
}
.camp-list-item:hover,
.camp-list-item.active {
  background: var(--text);
  color: var(--bg);
}
```

### 3. Add token tracking display to `src/views/CampWorkspaceView.tsx`

The `runCampChatRuntime` function already returns `usage` (via the OpenRouter response) but it's not surfaced in the UI. Add a running session token counter:

- Add state: `const [sessionTokens, setSessionTokens] = useState<number>(0);`
- After each successful run, add the returned `total_tokens` to the counter.
- Display it in the camp workspace header area (near the model name): something like `{sessionTokens.toLocaleString()} tokens` in `var(--text-muted)` style, uppercase, small font.
- Reset to 0 when the camp changes (on `campId` change).

The token data flows back from `runCampChatRuntime` which calls `streamOpenRouterChatCompletion` or `runToolUseLoop` — both return `usage: TokenUsage` with `total_tokens: number | null`. Accumulate `total_tokens ?? 0` after each run.

### 4. Show resolved model in `src/views/CampWorkspaceView.tsx`

`runCampChatRuntime` → `streamOpenRouterChatCompletion` → returns `resolvedModel: string | null`. This tells you what model OpenRouter actually used (important when the camp's model is `openrouter/auto`).

- Add state: `const [resolvedModel, setResolvedModel] = useState<string | null>(null);`
- After each run, set `resolvedModel` to the returned value.
- Display it beneath the model picker or in the header — e.g., `Resolved: {resolvedModel}` — only when `resolvedModel !== camp.config.model` (i.e., when auto-routing was used or the model was re-routed).
- Style it as a small muted label: `font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em;`

Note: `runCampChatRuntime` currently does not return `resolvedModel` or `usage`. You'll need to:
1. Add `resolvedModel` and `usage` to the `RunCampChatRuntimeResult` type in `src/lib/campChatRuntime.ts`.
2. Thread the value through from the underlying calls (`streamOpenRouterChatCompletion` and `runToolUseLoop` both already return it).
3. Consume it in `CampWorkspaceView`.

### 5. Surface model context length in `src/components/ModelPicker.tsx` (or wherever the model `<select>` is)

The `ModelRow` type already has `context_length: number | null` and `pricing_json: string | null` stored from the OpenRouter sync. In the model picker dropdown (the `<select>` used in HomeView and CampWorkspaceView), add context length to the option label when available:

```ts
function modelDisplayLabel(model: ModelRow): string {
  const ctx = model.context_length ? ` · ${(model.context_length / 1000).toFixed(0)}k ctx` : '';
  const name = model.name?.trim() ? model.name : model.id;
  return `${name}${ctx}`;
}
```

This makes the model picker immediately informative without needing a separate UI.

---

## What NOT to Change

- Do not change `src/index.css` — it's already correct and is the source of truth.
- Do not change `src/views/HomeView.css` — it's already correct.
- Do not change `src/views/HomeView.tsx` — it's already correct.
- Do not change any Tauri/Rust files in `src-tauri/`.
- Do not change the component structure or routing logic — only CSS and the specific additions to `CampWorkspaceView.tsx` and `campChatRuntime.ts` described above.
- Do not install any new dependencies.
- Do not change class names used in TSX files unless absolutely necessary (prefer CSS-only changes).

---

## File Map (for reference)

```
src/
  index.css                         ← source of truth design tokens, do not touch
  App.css                           ← REWRITE this entirely
  views/
    HomeView.tsx                    ← do not touch
    HomeView.css                    ← do not touch
    CampWorkspaceView.tsx           ← add token tracking + resolvedModel display
  components/
    TranscriptView.tsx              ← CSS-only restyle via App.css
    CampSettingsPanel.tsx           ← CSS-only restyle via App.css
    Settings.tsx                    ← CSS-only restyle via App.css
    ModelPicker.tsx                 ← update label formatting
  lib/
    campChatRuntime.ts              ← add resolvedModel + usage to return type
    types.ts                        ← do not touch
    openrouter.ts                   ← do not touch
```

---

## Summary of Deliverables

1. `src/App.css` — fully rewritten in the dark/brutal aesthetic
2. `src/lib/campChatRuntime.ts` — `resolvedModel` and `usage` added to return type and threaded through
3. `src/views/CampWorkspaceView.tsx` — session token counter + resolved model display added
4. `src/components/ModelPicker.tsx` (or equivalent) — context length added to option labels

The app should look and feel like a single coherent tool after this — dark, flat, chamfered, with the Geist Pixel font everywhere and the `#ff4500` accent tying it together.
