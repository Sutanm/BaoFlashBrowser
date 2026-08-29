// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import SettingsPanel from '../src/renderer/components/panels/SettingsPanel';

const mainConfig = {
  flashVersion: '34.0.0.330', flashPluginChannel: 'stable' as const, lowEndMode: false,
  downloadEngine: 'aria2' as const, downloadDir: '', screenshotDir: '',
  userscriptMaxResponseMB: 2, userscriptTimeoutSeconds: 15,
  userscriptMaxConcurrentPerScript: 4, userscriptMaxConcurrentGlobal: 16,
  userscriptDownloadMaxMB: 8, userscriptDownloadConcurrent: 4, userscriptMaxValueKB: 16,
};

function renderPanel() {
  return render(
    <TypesafeI18n locale="zh-CN">
      <SettingsPanel onOpenUrl={vi.fn()} />
    </TypesafeI18n>,
  );
}

describe('SettingsPanel section rendering', () => {
  const clearCache = vi.fn();

  beforeEach(() => {
    clearCache.mockReset().mockResolvedValue({ clearedSessions: 2 });
    loadAllLocales();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        config: { get: vi.fn().mockResolvedValue(mainConfig) },
        pwd: {
          status: vi.fn().mockResolvedValue({
            initialized: false, unlocked: false, enabled: true,
            autoCapture: true, autoFill: true, autoFillReady: false, excludedSites: [],
          }),
        },
        cache: { clear: clearCache },
      },
    });
  });

  afterEach(() => cleanup());

  it('mounts only the selected section and preserves parent-owned draft state', () => {
    const { container } = renderPanel();
    const categories = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-category-row'));

    fireEvent.click(categories()[0]);
    expect(container.querySelectorAll('.settings-section-card')).toHaveLength(1);
    const homepage = screen.getByPlaceholderText('about:newtab');
    fireEvent.change(homepage, { target: { value: 'https://example.com/home' } });

    fireEvent.click(container.querySelector<HTMLButtonElement>('.settings-page-head button')!);
    fireEvent.click(categories()[1]);
    expect(container.querySelectorAll('.settings-section-card')).toHaveLength(2);
    expect(screen.queryByPlaceholderText('about:newtab')).not.toBeInTheDocument();

    fireEvent.click(container.querySelector<HTMLButtonElement>('.settings-page-head button')!);
    fireEvent.click(categories()[0]);
    expect(screen.getByPlaceholderText('about:newtab')).toHaveValue('https://example.com/home');
  });

  it('requires confirmation before clearing both browser caches', async () => {
    const { container } = renderPanel();
    const categories = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-category-row'));
    fireEvent.click(categories[4]);

    const clearButton = screen.getByRole('button', { name: '清理网页缓存' });
    fireEvent.click(clearButton);
    expect(clearCache).not.toHaveBeenCalled();
    expect(clearButton).toHaveTextContent('再次点击确认清理');

    fireEvent.click(clearButton);
    await waitFor(() => expect(clearCache).toHaveBeenCalledTimes(1));
  });
});
