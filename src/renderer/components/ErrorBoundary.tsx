import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

const ErrorBoundaryInner: React.FC<{ message?: string; onRetry: () => void }> = ({ message, onRetry }) => {
  // The root error boundary intentionally sits outside TypesafeI18n so it can
  // also catch provider/bootstrap failures. Its own fallback must therefore
  // remain renderable when the i18n context has not been created yet.
  const context = useI18nContext();
  const LL = context?.LL;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 24, color: 'var(--text-secondary)',
    }}>
      <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8, color: 'var(--text-primary)' }}>
        {LL?.error?.title?.() ?? '页面发生错误'}
      </div>
      <div style={{ fontSize: 13, opacity: 0.7, textAlign: 'center', maxWidth: 400 }}>
        {message || LL?.error?.default?.() || '界面初始化失败，请重试或查看主程序日志。'}
      </div>
      <button
        onClick={onRetry}
        style={{
          marginTop: 16, padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
          background: 'var(--accent)', color: '#fff', fontSize: 13,
        }}
      >
        {LL?.retry?.() ?? '重试'}
      </button>
    </div>
  );
};

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return <ErrorBoundaryInner message={this.state.error?.message} onRetry={() => this.setState({ hasError: false, error: null })} />;
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
