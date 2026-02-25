import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", color: "red", backgroundColor: "black", width: "100%", height: "100vh" }}>
          <h1>React Crashed!</h1>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: "1rem" }}>{this.state.error?.toString()}</pre>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: "1rem", fontSize: "0.8em" }}>{this.state.error?.stack}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}
