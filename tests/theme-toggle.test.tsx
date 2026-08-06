// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import { defaultSettings, useDataStore } from '../src/renderer/store/useDataStore';
import ThemeToggle from '../src/renderer/components/panels/ThemeToggle';

function renderToggle() {
  return render(
    <TypesafeI18n locale="zh-CN">
      <ThemeToggle />
    </TypesafeI18n>
  );
}

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    loadAllLocales();
    mockMatchMedia(false);
    useDataStore.setState({ themeMode: 'light', settings: { ...defaultSettings, themeMode: 'light' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
  });

  it('clicking the big toggle switches between light and dark', () => {
    renderToggle();
    fireEvent.click(screen.getByRole('switch', { name: '切换到暗色' }));
    expect(useDataStore.getState().themeMode).toBe('dark');

    fireEvent.click(screen.getByRole('switch', { name: '切换到亮色' }));
    expect(useDataStore.getState().themeMode).toBe('light');
  });

  it('clicking the big toggle while in system mode switches to the opposite effective theme', () => {
    useDataStore.setState({ themeMode: 'system', settings: { ...defaultSettings, themeMode: 'system' } });
    mockMatchMedia(false);
    renderToggle();

    fireEvent.click(screen.getByRole('switch', { name: '切换到暗色' }));
    expect(useDataStore.getState().themeMode).toBe('dark');
  });

  it('the system switch enters and exits system mode', () => {
    renderToggle();
    const systemSwitch = screen.getByRole('switch', { name: '跟随系统' });
    expect(systemSwitch).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(systemSwitch);
    expect(useDataStore.getState().themeMode).toBe('system');
    expect(systemSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('switch', { name: '跟随系统' }));
    expect(useDataStore.getState().themeMode).toBe('light');
  });
});
