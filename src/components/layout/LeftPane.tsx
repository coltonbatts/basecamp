import React from 'react';

type LeftPaneTab = 'camps' | 'files' | 'context';

interface LeftPaneProps {
    // Add props here as needed during integration
    children?: React.ReactNode;
    activeTab: LeftPaneTab;
    onTabChange: (tab: LeftPaneTab) => void;
    renderCamps: () => React.ReactNode;
    renderFiles: () => React.ReactNode;
    renderContext: () => React.ReactNode;
}

export function LeftPane({
    activeTab,
    onTabChange,
    renderCamps,
    renderFiles,
    renderContext,
}: LeftPaneProps) {
    return (
        <div className="left-pane-container">
            <div className="left-pane-tabs">
                <button
                    className={`pane-tab ${activeTab === 'camps' ? 'active' : ''}`}
                    onClick={() => onTabChange('camps')}
                >
                    CAMPS
                </button>
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
                {activeTab === 'camps' && renderCamps()}
                {activeTab === 'files' && renderFiles()}
                {activeTab === 'context' && renderContext()}
            </div>
        </div>
    );
}
