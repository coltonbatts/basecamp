# Basecamp Arena View — Codex Prompt

## Context

Basecamp is a Tauri desktop app (React 19 + TypeScript + Vite, no UI library). It calls AI models via OpenRouter.ai. The app has a dark, brutal design system — black background, Geist Pixel font, 3px borders, chamfered clip-path corners, `#ff4500` accent. All design tokens come from `src/index.css`.

The existing `src/components/CompareView.tsx` is a post-hoc diff of two saved `Run` records from a history database. Do not modify it.

This prompt describes a new feature: the **Arena View** — a live, streaming, multi-model parallel run interface. It is a completely new view.

---

## Feature: Arena View

The Arena lets the user write one prompt, pick 2–4 models, fire all of them simultaneously, and watch each one stream its response in real time in a side-by-side column layout.

This is an exploration and learning tool — it does not save to camps or the runs database. It is ephemeral by design.

### What the user can do

1. Write a system prompt (optional) and a user message.
2. Select 2–4 models from a searchable list drawn from the synced model DB.
3. Hit **Run Arena** — all models fire at the same time.
4. Watch each column stream its response live, with a live latency timer ticking.
5. When all columns finish, each shows: resolved model (if auto-routed), total tokens used, and final latency in ms.
6. Clear the results and run again with different models or a different prompt.

---

## Files to Create

### `src/views/ArenaView.tsx`

A new React component for the arena. Key state and behavior:

**State:**
```ts
type ArenaSlot = {
  id: string;           // stable key (e.g. slot-0, slot-1)
  model: string;        // selected model ID
  modelQuery: string;   // search input for filtering models
  status: 'idle' | 'running' | 'done' | 'error';
  streamingText: string;
  resolvedModel: string | null;
  totalTokens: number | null;
  latencyMs: number | null;
  error: string | null;
};

const [slots, setSlots] = useState<ArenaSlot[]>([/* 2 default slots */]);
const [systemPrompt, setSystemPrompt] = useState('');
const [userMessage, setUserMessage] = useState('');
const [temperature, setTemperature] = useState(0.7);
const [maxTokens, setMaxTokens] = useState(1200);
const [isRunning, setIsRunning] = useState(false);
const [models, setModels] = useState<ModelRow[]>([]);
```

**Behavior:**

- On mount, load models from `dbListModels()` (imported from `../lib/db`).
- Slots start with 2 entries. The user can add up to 4 total with an **Add Model** button, and remove any slot (minimum 2 remain) with a remove button on each slot header.
- Each slot has its own search input to filter the model `<select>`. Reuse the `modelDisplayLabel` pattern: `model.name + · Nk ctx`.
- When **Run Arena** is clicked:
  1. Validate: `userMessage` must be non-empty. All slots must have a model selected. API key must exist (`getApiKey()` from `../lib/db`).
  2. Set all slots to `status: 'running'`, clear previous results.
  3. Set `isRunning = true`.
  4. For each slot, fire `streamOpenRouterChatCompletion` (from `../lib/openrouter`) **concurrently** using `Promise.allSettled`. Do NOT await them sequentially.
  5. Each slot tracks its own streaming via `onToken` callback updating that slot's `streamingText`.
  6. Track latency per slot: record `Date.now()` before the call, compute `Date.now() - start` when the promise settles.
  7. On success: set slot to `status: 'done'`, set `resolvedModel`, `totalTokens`, `latencyMs`.
  8. On failure: set slot to `status: 'error'`, set `error` message.
  9. When ALL slots settle (regardless of success/failure), set `isRunning = false`.

Update each slot's state using a functional updater keyed by slot ID so concurrent updates don't overwrite each other:
```ts
setSlots(prev => prev.map(s => s.id === slotId ? { ...s, streamingText: s.streamingText + token } : s));
```

- A **Clear** button resets all slot results back to `idle` and clears the prompt inputs.
- **Run Arena** button is disabled while `isRunning` is true or while `userMessage` is empty.

**Request payload per slot:**
```ts
const requestPayload: OpenRouterChatRequestPayload = {
  model: slot.model,
  messages: [
    ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
    { role: 'user' as const, content: userMessage.trim() },
  ],
  temperature,
  max_tokens: maxTokens,
};
```

**JSX structure:**
```
<div className="arena-shell trail-shell">
  <header className="trail-header">
    <div className="trail-title">
      <h1>Arena</h1>
      <p>Run one prompt across multiple models simultaneously.</p>
    </div>
    <div className="trail-toolbar">
      <button onClick={() => navigate('/home')}>Home</button>
      <button onClick={() => navigate(-1)}>Back</button>
    </div>
  </header>

  {/* Prompt composer */}
  <section className="arena-composer panel">
    <label>System Prompt (optional)</label>
    <textarea ... />
    <label>User Message</label>
    <textarea ... />
    <div className="arena-composer-controls">
      <label>Temperature <input type="number" .../></label>
      <label>Max Tokens <input type="number" .../></label>
      <button onClick={handleAddSlot} disabled={slots.length >= 4 || isRunning}>Add Model</button>
      <button className="primary-action" onClick={handleRun} disabled={isRunning || !userMessage.trim()}>
        {isRunning ? 'Running...' : 'Run Arena'}
      </button>
      <button onClick={handleClear} disabled={isRunning}>Clear</button>
    </div>
  </section>

  {/* Slot columns */}
  <div className="arena-grid" style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }}>
    {slots.map(slot => (
      <ArenaSlot key={slot.id} slot={slot} ... />
    ))}
  </div>
</div>
```

Extract each column into a local `ArenaSlotColumn` component (or inline it — keep it simple):

```
<div className="arena-slot panel">
  <div className="arena-slot-header">
    <div>
      <label>Search Model <input .../></label>
      <label>Model <select .../></label>
    </div>
    {slots.length > 2 && <button onClick={() => handleRemoveSlot(slot.id)} disabled={isRunning}>Remove</button>}
  </div>

  <div className="arena-slot-status">
    {slot.status === 'running' && <span className="arena-timer">Running... <ArenaTimer /></span>}
    {slot.status === 'done' && (
      <div className="arena-slot-meta">
        {slot.resolvedModel && slot.resolvedModel !== slot.model && (
          <span>Auto → {slot.resolvedModel}</span>
        )}
        <span>{slot.totalTokens?.toLocaleString() ?? '—'} tokens</span>
        <span>{slot.latencyMs ? `${slot.latencyMs.toLocaleString()} ms` : '—'}</span>
      </div>
    )}
    {slot.status === 'error' && <span className="arena-slot-error">{slot.error}</span>}
  </div>

  <div className="arena-slot-output">
    <pre>{slot.streamingText || (slot.status === 'idle' ? 'Waiting for run...' : '')}</pre>
  </div>
</div>
```

**`ArenaTimer` sub-component:** A simple component that uses `useEffect` + `setInterval` to tick a counter from 0ms upward every 100ms while mounted. Resets when unmounted. Shows e.g. `1.4s`. This gives the live feel of watching the model think.

```ts
function ArenaTimer() {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setMs(prev => prev + 100), 100);
    return () => clearInterval(interval);
  }, []);
  return <span>{(ms / 1000).toFixed(1)}s</span>;
}
```

---

### CSS additions for `src/App.css`

Add the following classes. All must follow the existing dark design system.

```css
.arena-shell {
  /* same as .trail-shell — inherits it */
}

.arena-composer {
  display: grid;
  gap: var(--space-3);
}

.arena-composer textarea {
  min-height: 80px;
}

/* Prompt composer uses a smaller textarea than the camp composer */
.arena-composer > label:first-of-type textarea {
  min-height: 60px;
}

.arena-composer-controls {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
  flex-wrap: wrap;
}

.arena-composer-controls label {
  flex-direction: row;
  align-items: center;
  gap: var(--space-1);
  width: auto;
}

.arena-composer-controls input[type='number'] {
  width: 80px;
}

.arena-grid {
  display: grid;
  gap: var(--space-3);
  min-height: 0;
  flex: 1;
  /* grid-template-columns set inline based on slot count */
}

.arena-slot {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.arena-slot-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: var(--border-width) solid var(--line);
}

.arena-slot-header > div {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.arena-slot-status {
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  min-height: var(--space-4);
  display: flex;
  align-items: center;
}

.arena-slot-meta {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.arena-slot-meta span {
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

/* Accent the resolved model label */
.arena-slot-meta span:first-child {
  color: var(--accent);
}

.arena-slot-error {
  color: var(--accent);
  font-size: var(--text-xs);
  text-transform: uppercase;
}

.arena-timer {
  color: var(--accent);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.arena-slot-output {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: var(--border-width) solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  padding: var(--space-2);
  clip-path: polygon(var(--corner) 0, calc(100% - var(--corner)) 0,
      100% var(--corner), 100% calc(100% - var(--corner)),
      calc(100% - var(--corner)) 100%, var(--corner) 100%,
      0 calc(100% - var(--corner)), 0 var(--corner));
}

.arena-slot-output pre {
  margin: 0;
  font-family: var(--font-pixel);
  font-size: var(--text-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}

.arena-slot-output pre:empty::before,
.arena-slot-output pre[data-placeholder]::before {
  content: attr(data-placeholder);
  color: var(--text-muted);
}

/* Running slot: dashed border to signal activity */
.arena-slot.running .arena-slot-output {
  border-style: dashed;
}

/* Done slot: accent the top border */
.arena-slot.done .arena-slot-output {
  border-top-color: var(--accent);
}

@media (max-width: 1100px) {
  .arena-grid {
    grid-template-columns: 1fr 1fr !important;
  }
}

@media (max-width: 700px) {
  .arena-grid {
    grid-template-columns: 1fr !important;
  }
}
```

---

## Files to Modify

### `src/App.tsx`

Add the `/arena` route:
```tsx
import { ArenaView } from './views/ArenaView';

// Inside <Routes>:
<Route path="/arena" element={<ArenaView />} />
```

### `src/views/HomeView.tsx`

Add a navigation button to the Arena in the home dashboard header toolbar (next to the existing Refresh Models button):
```tsx
import { useNavigate } from 'react-router-dom';
// ...
const navigate = useNavigate(); // already present
// In the header:
<button type="button" onClick={() => navigate('/arena')}>
  Arena
</button>
```

---

## What NOT to Change

- Do not modify `src/components/CompareView.tsx` — it's a different, unrelated feature.
- Do not modify `src/lib/openrouter.ts` — `streamOpenRouterChatCompletion` is already correct.
- Do not modify `src/index.css` or `src/views/HomeView.css`.
- Do not add any new npm dependencies.
- Do not save arena runs to any database.
- Do not modify `src/lib/db.ts`.

---

## File Map

```
src/
  App.tsx                     ← add /arena route
  App.css                     ← add arena CSS classes
  views/
    ArenaView.tsx             ← CREATE THIS (new file)
    HomeView.tsx              ← add Arena button to header
  components/
    CompareView.tsx           ← do not touch
  lib/
    openrouter.ts             ← do not touch (use streamOpenRouterChatCompletion)
    db.ts                     ← do not touch (import dbListModels, getApiKey)
```

---

## Summary of Deliverables

1. `src/views/ArenaView.tsx` — fully functional arena view with parallel streaming, live timers, and per-slot resolved model + token display
2. `src/App.css` — arena CSS classes added following the dark design system
3. `src/App.tsx` — `/arena` route added
4. `src/views/HomeView.tsx` — Arena navigation button added to header

The arena should feel alive — multiple models racing in parallel, timers ticking in orange, responses appearing character by character. That's the whole point.
