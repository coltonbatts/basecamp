import { useEffect, useState, Fragment } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { useNavigate } from 'react-router-dom';
import { dbListModels, getApiKey } from '../lib/db';
import { streamOpenRouterChatCompletion, type OpenRouterChatRequestPayload } from '../lib/openrouter';
import type { ModelRow } from '../lib/types';

type ArenaSlot = {
    id: string;
    model: string;
    modelQuery: string;
    status: 'idle' | 'running' | 'done' | 'error';
    streamingText: string;
    resolvedModel: string | null;
    totalTokens: number | null;
    latencyMs: number | null;
    error: string | null;
};

function ArenaTimer() {
    const [ms, setMs] = useState(0);
    useEffect(() => {
        const interval = setInterval(() => setMs((prev) => prev + 100), 100);
        return () => clearInterval(interval);
    }, []);
    return <span>{(ms / 1000).toFixed(1)}s</span>;
}

function modelDisplayLabel(model: ModelRow): string {
    const ctx = model.context_length ? ` · ${(model.context_length / 1000).toFixed(0)}k ctx` : '';
    const name = model.name?.trim() ? model.name : model.id;
    return `${name}${ctx}`;
}

export function ArenaView() {
    const navigate = useNavigate();

    const [slots, setSlots] = useState<ArenaSlot[]>([
        {
            id: 'slot-0',
            model: 'openrouter/auto',
            modelQuery: '',
            status: 'idle',
            streamingText: '',
            resolvedModel: null,
            totalTokens: null,
            latencyMs: null,
            error: null,
        },
        {
            id: 'slot-1',
            model: 'openrouter/auto',
            modelQuery: '',
            status: 'idle',
            streamingText: '',
            resolvedModel: null,
            totalTokens: null,
            latencyMs: null,
            error: null,
        },
    ]);

    const [systemPrompt, setSystemPrompt] = useState('');
    const [userMessage, setUserMessage] = useState('');
    const [temperature, setTemperature] = useState(0.7);
    const [maxTokens, setMaxTokens] = useState(1200);
    const [isRunning, setIsRunning] = useState(false);
    const [models, setModels] = useState<ModelRow[]>([]);

    useEffect(() => {
        const load = async () => {
            const dbModels = await dbListModels();
            setModels(dbModels);
        };
        void load();
    }, []);

    const handleAddSlot = () => {
        if (slots.length >= 4) return;
        const newId = `slot-${Date.now()}`;
        setSlots((prev) => [
            ...prev,
            {
                id: newId,
                model: 'openrouter/auto',
                modelQuery: '',
                status: 'idle',
                streamingText: '',
                resolvedModel: null,
                totalTokens: null,
                latencyMs: null,
                error: null,
            },
        ]);
    };

    const handleRemoveSlot = (id: string) => {
        if (slots.length <= 2) return;
        setSlots((prev) => prev.filter((s) => s.id !== id));
    };

    const handleClear = () => {
        setSystemPrompt('');
        setUserMessage('');
        setSlots((prev) =>
            prev.map((s) => ({
                ...s,
                status: 'idle',
                streamingText: '',
                resolvedModel: null,
                totalTokens: null,
                latencyMs: null,
                error: null,
            }))
        );
    };

    const handleRun = async () => {
        if (!userMessage.trim()) return;

        for (const slot of slots) {
            if (!slot.model) {
                alert('All slots must have a model selected.');
                return;
            }
        }

        const apiKey = await getApiKey();
        if (!apiKey) {
            alert('OpenRouter API key is missing. Configure it in Settings first.');
            return;
        }

        setSlots((prev) =>
            prev.map((s) => ({
                ...s,
                status: 'running',
                streamingText: '',
                resolvedModel: null,
                totalTokens: null,
                latencyMs: null,
                error: null,
            }))
        );
        setIsRunning(true);

        const promises = slots.map(async (slot) => {
            const requestPayload: OpenRouterChatRequestPayload = {
                model: slot.model,
                messages: [
                    ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
                    { role: 'user' as const, content: userMessage.trim() },
                ],
                temperature,
                max_tokens: maxTokens,
            };

            const start = Date.now();

            try {
                const result = await streamOpenRouterChatCompletion(
                    apiKey,
                    requestPayload,
                    (token) => {
                        setSlots((prev) =>
                            prev.map((s) =>
                                s.id === slot.id ? { ...s, streamingText: s.streamingText + token } : s
                            )
                        );
                    }
                );

                const latencyMs = Date.now() - start;

                setSlots((prev) =>
                    prev.map((s) =>
                        s.id === slot.id
                            ? {
                                ...s,
                                status: 'done',
                                resolvedModel: result.resolvedModel,
                                totalTokens: result.usage.total_tokens ?? null,
                                latencyMs,
                            }
                            : s
                    )
                );
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                setSlots((prev) =>
                    prev.map((s) =>
                        s.id === slot.id
                            ? { ...s, status: 'error', error: errorMsg }
                            : s
                    )
                );
            }
        });

        await Promise.allSettled(promises);
        setIsRunning(false);
    };

    return (
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
                <label>
                    System Prompt (optional)
                    <textarea
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        disabled={isRunning}
                        placeholder="You are a helpful assistant..."
                    />
                </label>
                <label>
                    User Message
                    <textarea
                        value={userMessage}
                        onChange={(e) => setUserMessage(e.target.value)}
                        disabled={isRunning}
                        placeholder="Write your prompt here..."
                    />
                </label>
                <div className="arena-composer-controls">
                    <label>
                        Temperature
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="2"
                            value={temperature}
                            onChange={(e) => setTemperature(parseFloat(e.target.value))}
                            disabled={isRunning}
                        />
                    </label>
                    <label>
                        Max Tokens
                        <input
                            type="number"
                            step="100"
                            min="1"
                            value={maxTokens}
                            onChange={(e) => setMaxTokens(parseInt(e.target.value, 10))}
                            disabled={isRunning}
                        />
                    </label>
                    <button onClick={handleAddSlot} disabled={slots.length >= 4 || isRunning}>
                        Add Model
                    </button>
                    <button className="primary-action" onClick={handleRun} disabled={isRunning || !userMessage.trim()}>
                        {isRunning ? 'Running...' : 'Run Arena'}
                    </button>
                    <button onClick={handleClear} disabled={isRunning}>
                        Clear
                    </button>
                </div>
            </section>

            {/* Slot columns */}
            <PanelGroup orientation="horizontal" className="arena-panel-group">
                {slots.map((slot, index) => {
                    const filteredModels = models.filter(
                        (m) =>
                            m.id.toLowerCase().includes(slot.modelQuery.toLowerCase()) ||
                            (m.name && m.name.toLowerCase().includes(slot.modelQuery.toLowerCase()))
                    );

                    // Always include the currently selected model if it's not in the filtered list
                    const selectedModel = models.find((m) => m.id === slot.model);
                    const options = [...filteredModels];
                    if (selectedModel && !filteredModels.some((m) => m.id === selectedModel.id)) {
                        options.push(selectedModel);
                    }

                    // If the model isn't in DB (e.g., fallback openrouter/auto), ensure we can still see/select it
                    if (!options.some((m) => m.id === slot.model)) {
                        options.push({ id: slot.model, name: slot.model } as ModelRow);
                    }

                    return (
                        <Fragment key={slot.id}>
                            {index > 0 && <PanelResizeHandle className="ide-resize-handle" />}
                            <Panel defaultSize={100 / slots.length} minSize={15} className={`arena-slot panel ${slot.status}`}>
                                <div className="arena-slot-header">
                                    <div>
                                        <label>
                                            <span className="hint">Search Model</span>
                                            <input
                                                type="text"
                                                placeholder="e.g. claude"
                                                value={slot.modelQuery}
                                                onChange={(e) =>
                                                    setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, modelQuery: e.target.value } : s)))
                                                }
                                                disabled={isRunning}
                                            />
                                        </label>
                                        <label>
                                            <span className="hint">Model</span>
                                            <select
                                                value={slot.model}
                                                onChange={(e) =>
                                                    setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, model: e.target.value } : s)))
                                                }
                                                disabled={isRunning}
                                            >
                                                {options.map((m) => (
                                                    <option key={m.id} value={m.id}>
                                                        {modelDisplayLabel(m)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>
                                    {slots.length > 2 && (
                                        <button onClick={() => handleRemoveSlot(slot.id)} disabled={isRunning}>
                                            Remove
                                        </button>
                                    )}
                                </div>

                                <div className="arena-slot-status">
                                    {slot.status === 'running' && (
                                        <span className="arena-timer">
                                            Running... <ArenaTimer />
                                        </span>
                                    )}
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
                                    <pre data-placeholder="Waiting for run...">{slot.streamingText || (slot.status === 'idle' ? '' : '')}</pre>
                                </div>
                            </Panel>
                        </Fragment>
                    );
                })}
            </PanelGroup>
        </div>
    );
}
