// Stage 2 sidebar panel: scripts matching the current page, quick
// enable/disable, GM_registerMenuCommand entries, and a jump to the
// management tab.

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Puzzle } from 'lucide-react';
import { useDataStore } from '../../store/useDataStore';
import { useI18nContext } from '@renderer/i18n/i18n-react';

interface MatchingScript {
  id: string;
  name: string;
  enabled: boolean;
}

interface MenuCommand {
  commandId: string;
  title: string;
  scriptId: string;
  background?: boolean;
}

interface UserscriptsPanelProps {
  tabId: string | null;
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

export default function UserscriptsPanel({ tabId, currentUrl, onOpenUrl }: UserscriptsPanelProps): React.JSX.Element {
  const { LL } = useI18nContext();
  const [scripts, setScripts] = useState<MatchingScript[]>([]);
  const [commands, setCommands] = useState<MenuCommand[]>([]);
  const [runningCommand, setRunningCommand] = useState<string | null>(null);
  const pushToast = useDataStore((s) => s.pushToast);

  const refresh = useCallback(async () => {
    if (!tabId) {
      setScripts([]);
      setCommands([]);
      return;
    }
    try {
      const result = (await window.electronAPI.userscripts.forTab(tabId, currentUrl)) as {
        scripts: MatchingScript[];
        commands: MenuCommand[];
      };
      setScripts(result.scripts ?? []);
      setCommands(result.commands ?? []);
    } catch {
      setScripts([]);
      setCommands([]);
    }
  }, [tabId, currentUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live sync with the management page / other panels.
  useEffect(() => {
    const off = window.electronAPI.userscripts.onChanged(() => void refresh());
    return off;
  }, [refresh]);

  const toggle = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    await window.electronAPI.userscripts.setEnabled(id, enabled);
    void refresh();
  }, [refresh]);

  const runCommand = useCallback(async (commandId: string): Promise<void> => {
    if (!tabId || runningCommand) return;
    setRunningCommand(commandId);
    try {
      const result = await window.electronAPI.userscripts.invokeCommand(tabId, commandId);
      pushToast({
        message: result?.ok ? LL.userscript.panel.commandSent() : LL.userscript.panel.commandFailed(),
        type: result?.ok ? 'success' : 'error',
      });
    } catch {
      pushToast({ message: LL.userscript.panel.commandFailedSimple(), type: 'error' });
    } finally {
      setRunningCommand(null);
    }
  }, [tabId, runningCommand, pushToast, LL]);

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{LL.userscript.panel.matchedOnPage()}</span>
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--accent)' }}
          onClick={() => onOpenUrl('about:userscripts', true)}
        >
          <Puzzle className="w-3.5 h-3.5" />
          {LL.userscript.panel.manageAll()}
        </button>
      </div>

      {scripts.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.5 }}>{LL.userscript.panel.noMatchOnPage()}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {scripts.map((script) => (
            <li key={script.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{script.name}</span>
              <button
                type="button"
                style={{ fontSize: 12, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', color: script.enabled ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                onClick={() => void toggle(script.id, !script.enabled)}
              >
                {script.enabled ? LL.userscript.disable() : LL.userscript.enable()}
              </button>
            </li>
          ))}
        </ul>
      )}

      {commands.length > 0 ? (
        <>
          <span style={{ fontSize: 12, opacity: 0.6 }}>{LL.userscript.panel.commands()}</span>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {commands.map((command) => (
              <li key={command.commandId}>
                <button
                  type="button"
                  disabled={runningCommand === command.commandId}
                  style={{ width: '100%', textAlign: 'left', fontSize: 13, cursor: runningCommand === command.commandId ? 'wait' : 'pointer', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', opacity: runningCommand === command.commandId ? 0.6 : 1 }}
                  onClick={() => void runCommand(command.commandId)}
                >
                  {runningCommand === command.commandId ? LL.userscript.panel.commandRunning() : command.title}
                  {command.background ? (
                    <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 999, fontWeight: 600, color: 'var(--accent)', background: 'rgba(99,102,241,0.14)' }}>
                      {LL.userscript.background.badge()}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {scripts.length > 0 || commands.length > 0 ? (
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-secondary)' }}
          onClick={() => onOpenUrl('about:userscripts', false)}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          {LL.userscript.panel.manageAll()}
        </button>
      ) : null}
    </div>
  );
}
