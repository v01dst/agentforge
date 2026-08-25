import React from 'react';
import { Box, Text, useInput } from 'ink';

interface FallbackProps {
  message: string;
  onReset: () => void;
}

function ErrorFallback({ message, onReset }: FallbackProps) {
  useInput(() => onReset());
  return (
    <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={1}>
      <Text color="red">Something went wrong: {message}</Text>
      <Text dimColor>press any key to restart the interface</Text>
    </Box>
  );
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level React error boundary for the whole TUI tree. Catches render
 * errors and shows a red panel; any keypress resets internal state so the
 * parent can remount the tree via its `key`.
 */
export class ErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Surface to stderr for log capture without crashing Ink's renderer.
    process.stderr.write(`[agentforge] render error: ${error.stack ?? error.message}\\n`);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    if (this.state.error) {
      return <ErrorFallback message={this.state.error.message} onReset={this.reset} />;
    }
    return this.props.children;
  }
}
