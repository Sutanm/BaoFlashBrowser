import React, { useEffect, useCallback, useState } from 'react';
import { X as XIcon, File, FileArchive, FileCode, Play as PlayIcon, Pause, FolderOpen, Trash2 } from 'lucide-react';
import { useDataStore } from '@renderer/store/useDataStore';
import type { DownloadItem, DownloadEngine } from '@shared/types/downloads';
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

const DownloadsPanel: React.FC = () => {
  const { LL } = useI18nContext();
  const downloads = useDataStore((s) => s.downloads);
  const setDownloads = useDataStore((s) => s.setDownloads);
  const pushToast = useDataStore((s) => s.pushToast);
  const [downloadDir, setDownloadDir] = useState('');
  const [engine, setEngine] = useState<DownloadEngine>('aria2');
  const [aria2Ready, setAria2Ready] = useState<boolean | null>(null);
  useEffect(() => {
    let subscribed = true;
    let receivedStatus = false;
    const cleanup = window.electronAPI.on('aria2:status', (status) => {
      receivedStatus = true;
      if (subscribed) setAria2Ready(status.ready);
    });
    window.electronAPI.config.get().then((cfg) => { if (subscribed && cfg?.downloadEngine) setEngine(cfg.downloadEngine); }).catch(() => {});
    window.electronAPI.invoke('download:aria2-status').then((status) => {
      if (subscribed && !receivedStatus && status) setAria2Ready(status.ready);
    }).catch(() => { if (subscribed && !receivedStatus) setAria2Ready(false); });
    return () => { subscribed = false; cleanup(); };
  }, []);
  useEffect(() => {
    window.electronAPI?.dl?.getDir().then(setDownloadDir).catch(() => {});
  }, []);

  const removeEntry = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const result = await window.electronAPI.dl.removeRecord(id);
      if (!result.success) throw new Error('main process rejected record removal');
      setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== id));
    } catch {
      pushToast({ message: LL.download.removeRecordFailed(), type: 'error' });
    }
  }, [setDownloads, pushToast, LL]);

  const cancelDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    window.electronAPI?.dl?.cancel(id);
  }, []);

  const pauseDl = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const result = await window.electronAPI.dl.pause(id);
      if (!result.success) pushToast({ message: LL.download.pauseFailed(), type: 'error' });
    } catch {
      pushToast({ message: LL.download.pauseFailed(), type: 'error' });
    }
  }, [pushToast, LL]);

  const resumeDl = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const result = await window.electronAPI.dl.resume(id);
      if (!result.success) pushToast({ message: LL.download.resumeFailed(), type: 'error' });
    } catch {
      pushToast({ message: LL.download.resumeFailed(), type: 'error' });
    }
  }, [pushToast, LL]);

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
      const removed = await window.electronAPI.dl.removeRecord(entry.id).catch(() => ({ success: false }));
      if (removed.success) {
        setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== entry.id));
        pushToast({ message: LL.download.deleted({ filename: entry.filename || LL.download.file() }), type: 'success' });
      } else {
        pushToast({ message: LL.download.removeRecordFailed(), type: 'error' });
      }
    } else {
      pushToast({ message: LL.download.deleteFailed({ filename: entry.filename || LL.download.file() }), type: 'error' });
    }
  }, [setDownloads, pushToast, LL]);

  const clearCompleted = useCallback(async () => {
    try {
      const result = await window.electronAPI.dl.clearFinished();
      if (!result.success) throw new Error('main process rejected record cleanup');
      setDownloads((prev) => prev.filter((d: DownloadItem) => d.state === 'progressing' || d.state === 'paused'));
      pushToast({ message: LL.download.cleared(), type: 'info' });
    } catch {
      pushToast({ message: LL.download.clearFailed(), type: 'error' });
    }
  }, [setDownloads, pushToast, LL]);

  const handleItemClick = useCallback((entry: DownloadItem) => {
    if (entry.state === 'completed' && entry.savePath) {
      openFile(entry.savePath);
    }
  }, [openFile]);

  const sorted = [...downloads].reverse();
  const hasCompleted = sorted.some((d: DownloadItem) => !['progressing', 'paused'].includes(d.state));

  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-light)' }}>
        <div role="status" aria-label={LL.download.engine()} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: engine === 'chromium' ? '#3498db' : aria2Ready === null ? '#999' : aria2Ready ? '#27ae60' : '#e67e22' }} />
          <span>{LL.download.engine()}: {engine === 'aria2' && aria2Ready === false ? 'Chromium' : engine === 'aria2' ? 'aria2' : 'Chromium'}</span>
          <span>{engine === 'chromium' ? LL.download.ready() : aria2Ready === null ? LL.download.detecting() : aria2Ready ? LL.download.ready() : LL.download.aria2Unavailable()}</span>
        </div>
        <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', minHeight: 32 }} title={downloadDir} onClick={() => {
          void window.electronAPI.dl.openFolder().catch(() => pushToast({ message: LL.download.openFolderFailed(), type: 'error' }));
        }}><FolderOpen className="w-3.5 h-3.5" /> {LL.download.openFolder()}</button>
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
            const isInterrupted = entry.state === 'interrupted';
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
                  {isInterrupted && (
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
