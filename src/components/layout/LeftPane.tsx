import React from 'react';

type LeftPaneTab = 'files' | 'context';

interface LeftPaneProps {
    // Add props here as needed during integration
    children?: React.ReactNode;
    activeTab: LeftPaneTab;
    onTabChange: (tab: LeftPaneTab) => void;
    renderFiles: () => React.ReactNode;
    renderContext: () => React.ReactNode;
}

export function LeftPane({
    activeTab,
    onTabChange,
    renderFiles,
    renderContext,
}: LeftPaneProps) {
    return (
        <div className="left-pane-container">
            <div className="left-pane-tabs">
                <button
                    className={`pane-tab ${activeTab === 'files' ? 'active' : ''}`}
                    onClick={() => onTabChange('files')}
                >
                    FILES
                </button>
                <button
                    className={`pane-tab ${activeTab === 'context' ? 'active' : ''}`}
                    onClick={() => onTabChange('context')}
                >
                    CONTEXT
                </button>
            </div>

            <div className="left-pane-content">
                {activeTab === 'files' && renderFiles()}
                {activeTab === 'context' && renderContext()}
            </div>
        </div>
    );
}
