import React, { useEffect, useCallback, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { X as XIcon, File, FileArchive, FileCode, Play as PlayIcon, Pause, FolderOpen, Trash2 } from 'lucide-react';
import { downloadsAtom, settingsAtom, pushToastAtom } from '@renderer/atoms/data.atom';
import type { DownloadItem } from '@shared/types/downloads';

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
  if (['swf'].includes(ext)) return <Play className="w-4 h-4" style={{ color: '#3498db' }} />;
  if (['exe', 'msi'].includes(ext)) return <FileCode className="w-4 h-4" style={{ color: '#27ae60' }} />;
  return <File className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />;
}

function dirName(fullPath: string): string {
  if (!fullPath) return '';
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fullPath;
}

const DownloadsPanel: React.FC = () => {
  const [downloads, setDownloads] = useAtom(downloadsAtom);
  const settings = useAtomValue(settingsAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const [aria2Status, setAria2Status] = useState<{ ready: boolean; port?: number; dir?: string } | null>(null);
  const [downloadDir, setDownloadDir] = useState('');

  const engine = settings.downloadEngine;

  useEffect(() => {
    const cleanup = (window as any).electronAPI?.on('aria2:status', (data: any) => {
      setAria2Status(data);
    });
    (window as any).electronAPI?.invoke('download:aria2-status').then((data: any) => {
      if (data) setAria2Status(data);
    }).catch(() => {});
    return () => { cleanup?.(); };
  }, []);

  useEffect(() => {
    (window as any).electronAPI?.dl?.getDir().then((dir: string) => {
      if (dir) setDownloadDir(dir);
    }).catch(() => {});
  }, []);

  const removeEntry = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== id));
  }, [setDownloads]);

  const cancelDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    (window as any).electronAPI?.dl?.cancel(id);
  }, []);

  const pauseDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    (window as any).electronAPI?.dl?.pause(id);
  }, []);

  const resumeDl = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    (window as any).electronAPI?.dl?.resume(id);
  }, []);

  const openFile = useCallback((savePath: string) => {
    if (savePath) (window as any).electronAPI?.dl?.open(savePath);
  }, []);

  const openDir = useCallback((savePath: string) => {
    if (savePath) (window as any).electronAPI?.dl?.openDir(savePath);
  }, []);

  const deleteFileAndEntry = useCallback(async (e: React.MouseEvent, entry: DownloadItem) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除 "${entry.filename}"？`)) return;
    // L42: 校验 deleteFile 返回值，失败时不移除条目
    const success = await (window as any).electronAPI?.dl?.deleteFile(entry.savePath);
    if (success) {
      setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== entry.id));
      pushToast({ message: `${entry.filename || '文件'} 已删除`, type: 'info', color: '#e74c3c' });
    } else {
      pushToast({ message: `${entry.filename || '文件'} 删除失败`, type: 'error' });
    }
  }, [setDownloads, pushToast]);

  const chooseDir = useCallback(async () => {
    const newDir = await (window as any).electronAPI?.dl?.setDir();
    if (newDir) {
      setDownloadDir(newDir);
      pushToast({ message: '下载目录已更改', type: 'success' });
    }
  }, [pushToast]);

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.state === 'progressing'));
    pushToast({ message: '已清除完成的下载', type: 'info' });
  }, [setDownloads, pushToast]);

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
        {/* Engine line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>引擎:</span>
          <span>{engine === 'aria2' ? 'aria2' : 'Chromium'}</span>
          {engine === 'aria2' && (
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: aria2Status?.ready ? '#27ae60' : '#e74c3c',
              boxShadow: aria2Status?.ready ? '0 0 6px #27ae60' : '0 0 6px #e74c3c',
            }} />
          )}
          {engine === 'aria2' && (
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              {aria2Status?.ready ? `就绪 :${aria2Status.port}` : aria2Status ? '不可用' : '检测中...'}
            </span>
          )}
        </div>
        {/* Directory line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>位置:</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {downloadDir ? dirName(downloadDir) : '默认'}
          </span>
          <button
            onClick={chooseDir}
            className="btn-icon"
            style={{ width: 24, height: 24, flexShrink: 0 }}
            title="选择下载目录"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {hasCompleted && (
        <div className="fav-add-bar">
          <button onClick={clearCompleted} className="btn-secondary">清除已完成</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sorted.length === 0 ? (
          <div className="sidebar-empty">暂无下载</div>
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
                    <span className="download-filename">{entry.filename || '下载文件'}</span>
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
                    {isPaused ? '已暂停' :
                     isDone ? '已完成' :
                     entry.state === 'cancelled' ? '已取消' :
                     entry.state === 'interrupted' ? '已中断' :
                     isProgress && (entry.progress ?? 0) > 0 ? (entry.progress ?? 0).toFixed(1) + '%' : '准备中...'}
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
                    <button onClick={(e) => pauseDl(e, entry.id)} className="fav-remove" title="暂停下载">
                      <Pause className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isPaused && (
                    <button onClick={(e) => resumeDl(e, entry.id)} className="fav-remove" title="恢复下载">
                      <PlayIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {(isProgress || isPaused) && (
                    <button onClick={(e) => cancelDl(e, entry.id)} className="fav-remove" title="取消下载">
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isDone && entry.savePath && (
                    <button onClick={(e) => { e.stopPropagation(); openDir(entry.savePath); }} className="fav-remove" title="打开文件夹">
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isDone && entry.savePath && (
                    <button onClick={(e) => deleteFileAndEntry(e, entry)} className="fav-remove" title="删除文件">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {!isProgress && !isPaused && (
                    <button onClick={(e) => removeEntry(e, entry.id)} className="fav-remove" title="移除记录">
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
