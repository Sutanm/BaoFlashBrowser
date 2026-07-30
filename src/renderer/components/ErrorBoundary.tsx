import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', padding: 24, color: 'var(--text-secondary)',
        }}>
          <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8, color: 'var(--text-primary)' }}>
            出错了
          </div>
          <div style={{ fontSize: 13, opacity: 0.7, textAlign: 'center', maxWidth: 400 }}>
            {this.state.error?.message || '组件渲染异常'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 16, padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: 'var(--accent)', color: '#fff', fontSize: 13,
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
