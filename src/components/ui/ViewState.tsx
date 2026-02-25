type ViewStateProps = {
    icon?: string;
    title: string;
    message?: string;
    action?: {
        label: string;
        onClick: () => void;
    };
    variant?: 'default' | 'loading' | 'error';
};

export function ViewState({
    icon,
    title,
    message,
    action,
    variant = 'default',
}: ViewStateProps) {
    return (
        <div className={`view-state-container view-state-${variant}`}>
            <div className="view-state-content">
                {icon && <div className="view-state-icon">{icon}</div>}
                <h3 className="view-state-title">{title}</h3>
                {message && <p className="view-state-message">{message}</p>}
                {action && (
                    <button
                        type="button"
                        className="view-state-action"
                        onClick={action.onClick}
                    >
                        {action.label}
                    </button>
                )}
            </div>
        </div>
    );
}

ViewState.Empty = function ViewStateEmpty(props: Omit<ViewStateProps, 'variant'>) {
    return <ViewState {...props} variant="default" />;
};

ViewState.Loading = function ViewStateLoading(props: Omit<ViewStateProps, 'variant' | 'action'>) {
    return <ViewState icon="⏳" {...props} variant="loading" />;
};

ViewState.Error = function ViewStateError(props: Omit<ViewStateProps, 'variant'>) {
    return <ViewState icon="!" {...props} variant="error" />;
};
