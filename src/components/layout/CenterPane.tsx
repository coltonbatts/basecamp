import React from 'react';

interface CenterPaneProps {
    // Header controls
    renderHeaderActions: () => React.ReactNode;
    // Main content area
    renderContent: () => React.ReactNode;
    // Sub-navigation / Mode Switcher (e.g., Editor vs Artifact vs Graph)
    mode: string;
    onModeChange: (mode: string) => void;
    modes: string[];
}

export function CenterPane({
    renderHeaderActions,
    renderContent,
    mode,
    onModeChange,
    modes,
}: CenterPaneProps) {
    return (
        <div className="center-pane-container">
            <div className="center-pane-header panel-header">
                <div className="mode-switcher">
                    {modes.map(m => (
                        <button
                            key={m}
                            type="button"
                            className={`mode-tab ${mode === m ? 'active' : ''}`}
                            onClick={() => onModeChange(m)}
                        >
                            {m.toUpperCase()}
                        </button>
                    ))}
                </div>
                <div className="canvas-actions">
                    {renderHeaderActions()}
                </div>
            </div>
            <div className="center-pane-content">
                {renderContent()}
            </div>
        </div>
    );
}
