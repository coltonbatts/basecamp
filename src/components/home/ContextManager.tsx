type ContextManagerProps = {
  globalFiles: string[];
  attachedFiles: string[];
  selectedCampId: string | null;
  isRefreshing: boolean;
  isMutating: boolean;
  onRefresh: () => void;
  onAttach: (path: string) => void;
  onDetach: (path: string) => void;
};

export function ContextManager(props: ContextManagerProps) {
  const attachedSet = new Set(props.attachedFiles);

  return (
    <section className="command-panel context-manager" aria-label="Context manager">
      <header className="command-panel-header">
        <h2>Context</h2>
        <button type="button" onClick={props.onRefresh} disabled={props.isRefreshing}>
          {props.isRefreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </header>

      <p className="panel-meta">
        {props.selectedCampId ? `${props.attachedFiles.length} attached to active camp` : 'Select a camp to attach context'}
      </p>

      <div className="context-list" role="list">
        {props.globalFiles.map((file) => {
          const isAttached = attachedSet.has(file);

          return (
            <div className="context-row" role="listitem" key={file}>
              <span className="context-row-path">{file}</span>
              <button
                type="button"
                disabled={!props.selectedCampId || props.isMutating}
                className={isAttached ? '' : 'primary-action'}
                onClick={() => {
                  if (isAttached) {
                    props.onDetach(file);
                    return;
                  }

                  props.onAttach(file);
                }}
              >
                {isAttached ? 'Detach' : 'Attach'}
              </button>
            </div>
          );
        })}
      </div>

      {props.globalFiles.length === 0 ? <p className="empty-state">No global context files in workspace `context/`.</p> : null}
    </section>
  );
}
