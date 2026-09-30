import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logError } from '../lib/log';
import { ErrorState } from './States';

interface Props {
  /** Shown in the fallback title, e.g. "This view". */
  label: string;
  children: ReactNode;
  /** Changing this key clears a caught error (e.g. on navigation). */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey: string | undefined;
}

/** Contains a rendering failure to one region and offers a retry instead of a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError(`${this.props.label} crashed${info.componentStack ? ` at ${info.componentStack.trim().split('\n')[0] ?? ''}` : ''}`, error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorState
          className="h-full"
          title={`${this.props.label} failed to display`}
          message={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}
