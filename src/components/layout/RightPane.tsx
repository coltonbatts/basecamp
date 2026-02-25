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
        <div className="right-pane-container">
            {/* Transcript area scrolls */}
            <div className="right-pane-transcript">
                {renderTranscript()}
            </div>

            {/* Composer docked at bottom */}
            <div className="right-pane-composer">
                {renderComposer()}
            </div>
        </div>
    );
}
