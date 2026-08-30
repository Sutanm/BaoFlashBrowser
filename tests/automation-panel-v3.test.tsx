// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutomationPanel from '../src/renderer/components/panels/AutomationPanel';

describe('Automation 2.0 sidebar entry', () => {
  const onOpenUrl = vi.fn();

  beforeEach(() => {
    onOpenUrl.mockReset();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        automationV3: {
          listPackages: vi.fn().mockResolvedValue([]),
          status: vi.fn().mockResolvedValue({ state: 'idle' }),
        },
      },
    });
  });

  afterEach(() => cleanup());

  it('keeps a prominent workbench button and opens the registered internal URL', async () => {
    render(<AutomationPanel tabId="tab-1" currentUrl="https://example.test/game" onOpenUrl={onOpenUrl} />);
    const button = screen.getByRole('button', { name: /进入自动化工作台/u });
    fireEvent.click(button);
    expect(onOpenUrl).toHaveBeenCalledWith('about:automation', true);
    await waitFor(() => expect(window.electronAPI.automationV3.listPackages).toHaveBeenCalled());
  });
});
