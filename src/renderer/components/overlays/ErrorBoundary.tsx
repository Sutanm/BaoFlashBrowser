import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    console.error('[React ErrorBoundary] caught:', error.message, error.stack);
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[React ErrorBoundary] componentStack:', info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', fontFamily: '-apple-system, sans-serif', color: '#666', gap: 12,
        }}>
          <span style={{ fontSize: 48 }}>⚠</span>
          <span style={{ fontSize: 14 }}>页面出现了错误</span>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              padding: '6px 20px', border: 'none', borderRadius: 6, cursor: 'pointer',
              background: '#533483', color: '#fff', fontSize: 13,
            }}
          >
            刷新恢复
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
