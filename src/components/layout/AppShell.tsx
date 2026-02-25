import { ReactNode } from 'react';
import './AppShell.css'; // We'll add a specific CSS file or put it in App.css

interface AppShellProps {
    leftPane: ReactNode;
    centerPane: ReactNode;
    rightPane: ReactNode;
    topBar: ReactNode;
    leftPaneWidth: number;
    rightPaneWidth: number;
    onLeftPaneResize: (width: number) => void;
    onRightPaneResize: (width: number) => void;
    leftPaneCollapsed: boolean;
    rightPaneCollapsed: boolean;
}

export function AppShell({
    leftPane,
    centerPane,
    rightPane,
    topBar,
    leftPaneWidth,
    rightPaneWidth,
    onLeftPaneResize,
    onRightPaneResize,
    leftPaneCollapsed,
    rightPaneCollapsed,
}: AppShellProps) {
    const handleLeftDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = leftPaneWidth;

        const onMouseMove = (moveEvent: MouseEvent) => {
            const newWidth = Math.max(200, Math.min(600, startWidth + (moveEvent.clientX - startX)));
            onLeftPaneResize(newWidth);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
    };

    const handleRightDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = rightPaneWidth;

        const onMouseMove = (moveEvent: MouseEvent) => {
            // Moving left increases right pane width
            const newWidth = Math.max(300, Math.min(800, startWidth - (moveEvent.clientX - startX)));
            onRightPaneResize(newWidth);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
    };

    // Convert logical widths to CSS grid columns
    const leftCol = leftPaneCollapsed ? '0px' : `${leftPaneWidth}px`;
    const rightCol = rightPaneCollapsed ? '0px' : `${rightPaneWidth}px`;

    // We need splitters iff the pane is NOT collapsed
    const leftSplitterCol = leftPaneCollapsed ? '0px' : '8px';
    const rightSplitterCol = rightPaneCollapsed ? '0px' : '8px';

    return (
        <div className="app-shell-root">
            {topBar}
            <div
                className="app-shell-grid"
                style={{
                    '--left-width': leftCol,
                    '--left-splitter-width': leftSplitterCol,
                    '--right-width': rightCol,
                    '--right-splitter-width': rightSplitterCol,
                } as React.CSSProperties}
            >
                <div className={`app-shell-pane app-shell-left ${leftPaneCollapsed ? 'collapsed' : ''}`}>
                    {leftPane}
                </div>

                {!leftPaneCollapsed && (
                    <div className="app-shell-splitter" onMouseDown={handleLeftDrag} />
                )}

                <div className="app-shell-pane app-shell-center">
                    {centerPane}
                </div>

                {!rightPaneCollapsed && (
                    <div className="app-shell-splitter" onMouseDown={handleRightDrag} />
                )}

                <div className={`app-shell-pane app-shell-right ${rightPaneCollapsed ? 'collapsed' : ''}`}>
                    {rightPane}
                </div>
            </div>
        </div>
    );
}
