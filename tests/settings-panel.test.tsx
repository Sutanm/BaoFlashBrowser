// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  beforeEach(() => {
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
});
