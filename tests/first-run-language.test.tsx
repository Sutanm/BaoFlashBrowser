// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import { defaultSettings } from '../src/renderer/store/useDataStore';
import FirstRunLanguageGate from '../src/renderer/components/overlays/FirstRunLanguageGate';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), migrate: vi.fn() }));
vi.mock('../src/renderer/services/db', () => ({
  db: { settingsSingleton: { get: mocks.get, put: mocks.put } },
  migrateFromLocalStorage: mocks.migrate,
}));

function open() {
  return render(<TypesafeI18n locale="zh-CN"><FirstRunLanguageGate><div>Browser ready</div></FirstRunLanguageGate></TypesafeI18n>);
}

describe('first launch language selection', () => {
  beforeEach(() => {
    loadAllLocales();
    mocks.get.mockReset().mockResolvedValue(undefined);
    mocks.put.mockReset().mockResolvedValue(undefined);
    mocks.migrate.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('previews English and saves before mounting the browser', async () => {
    open();
    const select = await screen.findByRole('combobox');
    expect(screen.queryByText('Browser ready')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Browser ready');
    expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }), 'default');
  });

  it('skips the dialog for existing users after legacy migration', async () => {
    mocks.get.mockResolvedValue({ ...defaultSettings, language: 'en' });
    open();
    await screen.findByText('Browser ready');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('keeps the dialog open when persistence fails and allows retry', async () => {
    mocks.put.mockRejectedValueOnce(new Error('disk full'));
    open();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Browser ready')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Browser ready');
  });

  it('waits for migration and retries a failed settings load', async () => {
    mocks.migrate.mockRejectedValueOnce(new Error('database unavailable'));
    open();
    await screen.findByRole('alert');
    expect(mocks.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
  });
});
