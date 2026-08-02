// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddressToastHost from '../src/renderer/components/overlays/AddressToastHost';
import { useDataStore } from '../src/renderer/store/useDataStore';

describe('AddressToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDataStore.setState({ toastQueue: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('closes by clicking the toast body or the X button', () => {
    const onDismiss = vi.fn();
    const view = render(<AddressToastHost closeLabel="Close" />);
    act(() => useDataStore.getState().pushToast({ message: 'Body close', type: 'info', duration: null, onDismiss }));
    expect(view.container.querySelector('.toast-progress')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Body close'));
    expect(view.container.querySelector('.toast-exiting')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(110));
    expect(screen.queryByText('Body close')).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledWith('click');

    act(() => useDataStore.getState().pushToast({ message: 'Button close', type: 'info', duration: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => vi.advanceTimersByTime(110));
    expect(screen.queryByText('Button close')).not.toBeInTheDocument();
  });

  it('keeps a persistent toast until the user closes it', () => {
    render(<AddressToastHost closeLabel="Close" />);
    act(() => useDataStore.getState().pushToast({ message: 'Persistent', type: 'warning', duration: null }));
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByText('Persistent')).toBeInTheDocument();
  });

  it('shows progress and pauses automatic dismissal while hovered', () => {
    const view = render(<AddressToastHost closeLabel="Close" />);
    act(() => useDataStore.getState().pushToast({ message: 'Timed', type: 'success', duration: 1000 }));
    const host = screen.getByRole('status');
    expect(view.container.querySelector('.toast-progress')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(400));
    fireEvent.mouseEnter(host);
    expect(view.container.querySelector('.toast-progress.paused')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByText('Timed')).toBeInTheDocument();
    fireEvent.mouseLeave(host);
    act(() => vi.advanceTimersByTime(600));
    expect(view.container.querySelector('.toast-exiting')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(110));
    expect(screen.queryByText('Timed')).not.toBeInTheDocument();
  });

  it('starts exiting before an asynchronous action finishes and runs it once', async () => {
    const action = vi.fn(() => new Promise<void>(() => {}));
    const view = render(<AddressToastHost closeLabel="Close" />);
    act(() => useDataStore.getState().pushToast({
      message: 'Password prompt', type: 'info', duration: null,
      actions: [{ label: 'Save', primary: true, onClick: action }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => Promise.resolve());
    expect(action).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.toast-exiting')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(110));
    expect(screen.queryByText('Password prompt')).not.toBeInTheDocument();
  });

  it('does not let an old timer dismiss the next toast', () => {
    render(<AddressToastHost closeLabel="Close" />);
    act(() => {
      useDataStore.getState().pushToast({ message: 'First', type: 'info', duration: 100 });
      useDataStore.getState().pushToast({ message: 'Second', type: 'info', duration: null });
    });

    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByText('First')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(110));
    expect(screen.getByText('Second')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText('Second')).toBeInTheDocument();
  });
});
