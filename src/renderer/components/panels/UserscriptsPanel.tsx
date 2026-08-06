// Stage 2 sidebar panel: scripts matching the current page, quick
// enable/disable, GM_registerMenuCommand entries, and a jump to the
// management tab.

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Puzzle } from 'lucide-react';

interface MatchingScript {
  id: string;
  name: string;
  enabled: boolean;
}

interface MenuCommand {
  commandId: string;
  title: string;
  scriptId: string;
}

interface UserscriptsPanelProps {
  tabId: string | null;
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

export default function UserscriptsPanel({ tabId, currentUrl, onOpenUrl }: UserscriptsPanelProps): React.JSX.Element {
  const [scripts, setScripts] = useState<MatchingScript[]>([]);
  const [commands, setCommands] = useState<MenuCommand[]>([]);

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

  const toggle = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    await window.electronAPI.userscripts.setEnabled(id, enabled);
    void refresh();
  }, [refresh]);

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, opacity: 0.6 }}>当前页面匹配</span>
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--accent)' }}
          onClick={() => onOpenUrl('about:userscripts', true)}
        >
          <Puzzle className="w-3.5 h-3.5" />
          管理所有脚本
        </button>
      </div>

      {scripts.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.5 }}>当前页面没有匹配的脚本。</p>
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
                {script.enabled ? '禁用' : '启用'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {commands.length > 0 ? (
        <>
          <span style={{ fontSize: 12, opacity: 0.6 }}>脚本命令</span>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {commands.map((command) => (
              <li key={command.commandId}>
                <button
                  type="button"
                  style={{ width: '100%', textAlign: 'left', fontSize: 13, cursor: 'pointer', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px' }}
                  onClick={() => { if (tabId) void window.electronAPI.userscripts.invokeCommand(tabId, command.commandId); }}
                >
                  {command.title}
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
          管理所有脚本
        </button>
      ) : null}
    </div>
  );
}
