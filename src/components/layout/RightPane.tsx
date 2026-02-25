import React from 'react';

interface RightPaneProps {
    renderTranscript: () => React.ReactNode;
    renderComposer: () => React.ReactNode;
}

export function RightPane({
    renderTranscript,
    renderComposer,
}: RightPaneProps) {
    return (
        <div className="right-pane-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minHeight: 0 }}>
            {/* Transcript area scrolls */}
            <div className="right-pane-transcript" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {renderTranscript()}
            </div>

            {/* Composer docked at bottom */}
            <div className="right-pane-composer" style={{ flexShrink: 0 }}>
                {renderComposer()}
            </div>
        </div>
    );
}
