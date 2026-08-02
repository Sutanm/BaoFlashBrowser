import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDataStore } from '../../store/useDataStore';
import { toastDuration, type ToastDismissReason } from '../../services/toast';

type ToastPhase = 'hidden' | 'entering' | 'visible' | 'exiting';

const ENTER_DELAY = 30;
const EXIT_DURATION = 110;
const TOAST_COLORS = { success: '#27ae60', info: '#3498db', warning: '#f39c12', error: '#e74c3c' };

interface AddressToastHostProps {
  closeLabel: string;
}

const AddressToastHost: React.FC<AddressToastHostProps> = ({ closeLabel }) => {
  const toast = useDataStore((state) => state.toastQueue[0] || null);
  const dismissStoredToast = useDataStore((state) => state.dismissToast);
  const [phase, setPhase] = useState<ToastPhase>('hidden');
  const [timerPaused, setTimerPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const animationRef = useRef<ReturnType<typeof setTimeout>>();
  const remainingRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const closingRef = useRef(false);
  const actionLockedRef = useRef(false);
  const toastIdRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    clearTimeout(timerRef.current);
    clearTimeout(animationRef.current);
  }, []);

  const dismiss = useCallback((reason: ToastDismissReason) => {
    const id = toastIdRef.current;
    if (id === null || closingRef.current) return;
    closingRef.current = true;
    clearTimeout(timerRef.current);
    clearTimeout(animationRef.current);
    setPhase('exiting');
    animationRef.current = setTimeout(() => dismissStoredToast(id, reason), EXIT_DURATION);
  }, [dismissStoredToast]);

  const scheduleTimeout = useCallback(() => {
    if (remainingRef.current === null || closingRef.current) return;
    clearTimeout(timerRef.current);
    startedAtRef.current = performance.now();
    timerRef.current = setTimeout(() => dismiss('timeout'), remainingRef.current);
  }, [dismiss]);

  useEffect(() => {
    clearTimers();
    if (!toast) {
      toastIdRef.current = null;
      setPhase('hidden');
      return;
    }

    toastIdRef.current = toast.id;
    closingRef.current = false;
    actionLockedRef.current = false;
    remainingRef.current = toastDuration(toast);
    setTimerPaused(false);
    setPhase('entering');
    animationRef.current = setTimeout(() => setPhase('visible'), ENTER_DELAY);
    scheduleTimeout();
    return clearTimers;
  }, [toast?.id, clearTimers, scheduleTimeout]);

  const pauseTimer = useCallback(() => {
    if (remainingRef.current === null || timerPaused || closingRef.current) return;
    clearTimeout(timerRef.current);
    remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - startedAtRef.current));
    setTimerPaused(true);
  }, [timerPaused]);

  const resumeTimer = useCallback(() => {
    if (remainingRef.current === null || !timerPaused || closingRef.current) return;
    setTimerPaused(false);
    scheduleTimeout();
  }, [timerPaused, scheduleTimeout]);

  if (!toast || phase === 'hidden') return null;
  const duration = toastDuration(toast);

  return (
    <div
      className={`toast-overlay toast-${phase}`}
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      onClick={() => dismiss('click')}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      style={{ background: toast.color || TOAST_COLORS[toast.type] }}
    >
      <span className="toast-message" title={toast.message}>{toast.message}</span>
      {toast.actions && toast.actions.length > 0 && (
        <div className="toast-actions">
          {toast.actions.map((action, index) => (
            <button
              key={`${toast.id}-${index}`}
              className={`toast-btn ${action.primary ? 'toast-btn-primary' : ''}`}
              disabled={phase === 'exiting'}
              onClick={(event) => {
                event.stopPropagation();
                if (actionLockedRef.current) return;
                actionLockedRef.current = true;
                dismiss('action');
                Promise.resolve().then(action.onClick).catch((error) => {
                  console.error('[Toast] action failed:', error);
                });
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <button
        className="toast-close"
        aria-label={closeLabel}
        title={closeLabel}
        disabled={phase === 'exiting'}
        onClick={(event) => {
          event.stopPropagation();
          dismiss('close-button');
        }}
      >
        <X className="w-3.5 h-3.5" />
      </button>
      {duration !== null && duration > 0 && (
        <span
          key={toast.id}
          className={`toast-progress ${timerPaused ? 'paused' : ''}`}
          style={{ animationDuration: `${duration}ms` }}
        />
      )}
    </div>
  );
};

export default AddressToastHost;
