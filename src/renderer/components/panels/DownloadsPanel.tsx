import React, { useEffect, useCallback, useState } from 'react';
import { X as XIcon, File, FileArchive, FileCode, Play as PlayIcon, Pause, FolderOpen, Trash2 } from 'lucide-react';
import { useDataStore } from '@renderer/store/useDataStore';
import type { DownloadItem } from '@shared/types/downloads';
import type { DownloadEngine } from '@shared/types/settings';
import { useI18nContext } from '@renderer/i18n/i18n-react';

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '';
  if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return bytesPerSec.toFixed(0) + ' B/s';
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fileExt(filename: string): string {
  if (!filename) return '';
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

function FileIcon({ filename }: { filename: string }) {
  const ext = fileExt(filename);
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <FileArchive className="w-4 h-4" style={{ color: '#e67e22' }} />;
  if (['swf'].includes(ext)) return <PlayIcon className="w-4 h-4" style={{ color: '#3498db' }} />;
  if (['exe', 'msi'].includes(ext)) return <FileCode className="w-4 h-4" style={{ color: '#27ae60' }} />;
  return <File className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />;
}

function dirName(fullPath: string): string {
  if (!fullPath) return '';
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fullPath;
}

const DownloadsPanel: React.FC = () => {
  const { LL } = useI18nContext();
  const downloads = useDataStore((s) => s.downloads);
  const setDownloads = useDataStore((s) => s.setDownloads);
  const pushToast = useDataStore((s) => s.pushToast);
  const [aria2Status, setAria2Status] = useState<{ ready: boolean; port?: number; dir?: string } | null>(null);
  const [downloadDir, setDownloadDir] = useState('');
  const [engine, setEngine] = useState<DownloadEngine>('aria2');

  useEffect(() => {
    window.electronAPI?.config?.get().then((cfg) => {
      if (cfg?.downloadEngine) setEngine(cfg.downloadEngine as DownloadEngine);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI?.on('aria2:status', (data: any) => {
      setAria2Status(data);
    });
    window.electronAPI?.invoke('download:aria2-status').then((data: any) => {
      if (data) setAria2Status(data);
    }).catch(() => {});
    return () => { cleanup?.(); };
  }, []);

  useEffect(() => {
    window.electronAPI?.dl?.getDir().then((dir: string) => {
      if (dir) setDownloadDir(dir);
    }).catch(() => {});
  }, []);

  const removeEntry = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== id));
  }, [setDownloads]);

  const cancelDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    window.electronAPI?.dl?.cancel(id);
  }, []);

  const pauseDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    window.electronAPI?.dl?.pause(id);
  }, []);

  const resumeDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    window.electronAPI?.dl?.resume(id);
  }, []);

  const openFile = useCallback((savePath: string) => {
    if (savePath) window.electronAPI?.dl?.open(savePath);
  }, []);

  const openDir = useCallback((savePath: string) => {
    if (savePath) window.electronAPI?.dl?.openDir(savePath);
  }, []);

  const deleteFileAndEntry = useCallback(async (e: React.MouseEvent, entry: DownloadItem) => {
    e.stopPropagation();
    if (!window.confirm(LL.download.deleteConfirm({ filename: entry.filename || '' }))) return;
    // L42: 校验 deleteFile 返回值，失败时不移除条目
    const success = await window.electronAPI?.dl?.deleteFile(entry.savePath);
    if (success) {
      setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== entry.id));
      pushToast({ message: LL.download.deleted({ filename: entry.filename || LL.download.file() }), type: 'error' });
    } else {
      pushToast({ message: LL.download.deleteFailed({ filename: entry.filename || LL.download.file() }), type: 'error' });
    }
  }, [setDownloads, pushToast, LL]);

  const chooseDir = useCallback(async () => {
    const newDir = await window.electronAPI?.dl?.setDir();
    if (newDir) {
      setDownloadDir(newDir);
      pushToast({ message: LL.download.dirChanged(), type: 'success' });
    }
  }, [pushToast, LL]);

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.state === 'progressing'));
    pushToast({ message: LL.download.cleared(), type: 'info' });
  }, [setDownloads, pushToast, LL]);

  const handleItemClick = useCallback((entry: DownloadItem) => {
    if (entry.state === 'completed' && entry.savePath) {
      openFile(entry.savePath);
    }
  }, [openFile]);

  const sorted = [...downloads].reverse();
  const hasCompleted = sorted.some((d: DownloadItem) => d.state !== 'progressing');

  return (
    <>
      {/* Engine status + download directory */}
      <div style={{
        borderBottom: '1px solid var(--border-light)',
        padding: '8px 12px',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        {/* Engine line: 显示实际生效的引擎 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{LL.download.engine()}:</span>
          <span>{aria2Status?.ready ? 'aria2' : 'Chromium'}</span>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: aria2Status?.ready ? '#27ae60' : '#3498db',
            boxShadow: aria2Status?.ready ? '0 0 6px #27ae60' : '0 0 6px #3498db',
          }} />
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {engine === 'aria2' && !aria2Status?.ready && aria2Status !== null ? `(${LL.download.aria2Unavailable()})` : ''}
            {aria2Status?.ready ? `${LL.download.ready()} :${aria2Status.port}` : aria2Status ? '' : LL.download.detecting()}
          </span>
        </div>
        {/* Directory line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{LL.download.location()}:</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {downloadDir ? dirName(downloadDir) : LL.default()}
          </span>
          <button
            onClick={chooseDir}
            className="btn-icon"
            style={{ width: 24, height: 24, flexShrink: 0 }}
            title={LL.download.selectDir()}
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {hasCompleted && (
        <div className="fav-add-bar">
          <button onClick={clearCompleted} className="btn-secondary">{LL.download.clearCompleted()}</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sorted.length === 0 ? (
          <div className="sidebar-empty">{LL.download.empty()}</div>
        ) : (
          sorted.map((entry: DownloadItem) => {
            const isProgress = entry.state === 'progressing';
            const isPaused = entry.state === 'paused';
            const isDone = entry.state === 'completed';
            const dlEngine = entry.engine || 'chromium';

            return (
              <div
                key={entry.id}
                className="download-item"
                title={entry.url}
                onClick={() => handleItemClick(entry)}
                style={{ cursor: isDone && entry.savePath ? 'pointer' : 'default' }}
              >
                <div className="download-icon">
                  {isDone ? (
                    <FolderOpen className="w-4 h-4" style={{ color: '#27ae60' }} />
                  ) : entry.state === 'cancelled' || entry.state === 'interrupted' ? (
                    <XIcon className="w-4 h-4" style={{ color: '#e74c3c' }} />
                  ) : isPaused ? (
                    <Pause className="w-4 h-4" style={{ color: '#f39c12' }} />
                  ) : (
                    <FileIcon filename={entry.filename || ''} />
                  )}
                </div>
                <div className="download-info">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="download-filename">{entry.filename || LL.download.file()}</span>
                    <span style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      borderRadius: 3,
                      background: dlEngine === 'aria2' ? 'rgba(46,204,113,0.15)' : 'rgba(52,152,219,0.15)',
                      color: dlEngine === 'aria2' ? '#27ae60' : '#3498db',
                      fontWeight: 500,
                    }}>
                      {dlEngine === 'aria2' ? 'aria2' : 'Chromium'}
                    </span>
                  </div>
                  <span className="download-meta">
                    {isProgress && entry.speed > 0 ? formatSpeed(entry.speed) + ' · ' : ''}
                    {isPaused ? LL.download.paused() :
                     isDone ? LL.download.complete() :
                     entry.state === 'cancelled' ? LL.download.cancelled() :
                     entry.state === 'interrupted' ? LL.download.interrupted() :
                     isProgress && (entry.progress ?? 0) > 0 ? (entry.progress ?? 0).toFixed(1) + '%' : LL.download.preparing()}
                    {entry.totalBytes > 0 ? ' · ' + formatBytes(entry.receivedBytes) + ' / ' + formatBytes(entry.totalBytes) : ''}
                  </span>
                  {(isProgress || isPaused) && (
                    <div className="download-progress">
                      <div className="download-progress-bar" style={{ width: Math.min(entry.progress ?? 0, 99.9) + '%' }} />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {isProgress && (
                    <button onClick={(e) => pauseDl(e, entry.id)} className="fav-remove" title={LL.download.pause()}>
                      <Pause className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isPaused && (
                    <button onClick={(e) => resumeDl(e, entry.id)} className="fav-remove" title={LL.download.resume()}>
                      <PlayIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {(isProgress || isPaused) && (
                    <button onClick={(e) => cancelDl(e, entry.id)} className="fav-remove" title={LL.download.cancel()}>
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isDone && entry.savePath && (
                    <button onClick={(e) => { e.stopPropagation(); openDir(entry.savePath); }} className="fav-remove" title={LL.download.openDir()}>
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isDone && entry.savePath && (
                    <button onClick={(e) => deleteFileAndEntry(e, entry)} className="fav-remove" title={LL.delete()}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {!isProgress && !isPaused && (
                    <button onClick={(e) => removeEntry(e, entry.id)} className="fav-remove" title={LL.download.removeRecord()}>
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
};

export default DownloadsPanel;
