// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import AutomationPanel from '../src/renderer/components/panels/AutomationPanel';

describe('Automation 2.0 sidebar entry', () => {
  const onOpenUrl = vi.fn();

  beforeEach(() => {
    loadAllLocales();
    onOpenUrl.mockReset();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        automationV3: {
          listPackages: vi.fn().mockResolvedValue([]),
          status: vi.fn().mockResolvedValue({ state: 'idle' }),
          onChanged: vi.fn(() => () => {}),
        },
      },
    });
  });

  afterEach(() => cleanup());

  it('renders translated controls in English and disables the assistant on internal pages', async () => {
    render(<TypesafeI18n locale="en"><AutomationPanel tabId={null} currentUrl="about:newtab" onOpenUrl={onOpenUrl} /></TypesafeI18n>);
    expect(screen.getByRole('button', { name: 'Open floating assistant' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Open automation workbench' }));
    expect(onOpenUrl).toHaveBeenCalledWith('about:automation', true);
    await waitFor(() => expect(window.electronAPI.automationV3.listPackages).toHaveBeenCalled());
  });

  it('keeps a prominent workbench button and opens the registered internal URL', async () => {
    render(<TypesafeI18n locale="zh-CN"><AutomationPanel tabId="tab-1" currentUrl="https://example.test/game" onOpenUrl={onOpenUrl} /></TypesafeI18n>);
    const button = screen.getByRole('button', { name: /进入自动化工作台/u });
    fireEvent.click(button);
    expect(onOpenUrl).toHaveBeenCalledWith('about:automation', true);
    await waitFor(() => expect(window.electronAPI.automationV3.listPackages).toHaveBeenCalled());
  });
});
