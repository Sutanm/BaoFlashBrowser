import React, { useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { X as XIcon, Download, CheckCircle, XCircle } from 'lucide-react';
import { downloadsAtom } from '@renderer/atoms/data.atom';
import type { DownloadItem } from '@shared/types/downloads';

function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const DownloadsPanel: React.FC = () => {
  const [downloads, setDownloads] = useAtom(downloadsAtom);

  useEffect(() => {
    const cleanup = (window as any).electronAPI?.on('download:updated', (payload: any) => {
      setDownloads((prev) => {
        const exists = prev.find((d: DownloadItem) => d.id === payload.id);
        if (exists) {
          return prev.map((d: DownloadItem) => d.id === payload.id ? { ...d, ...payload } : d);
        }
        return [{ ...payload, id: payload.id }, ...prev];
      });
    });
    return () => { cleanup?.(); };
  }, [setDownloads]);

  const removeEntry = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== id));
  }, [setDownloads]);

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.state !== 'completed' && d.state !== 'cancelled'));
  }, [setDownloads]);

  const sorted = [...downloads].reverse();
  const hasCompleted = sorted.some((d: DownloadItem) => d.state === 'completed' || d.state === 'cancelled');

  return (
    <>
      {hasCompleted && (
        <div className="fav-add-bar">
          <button onClick={clearCompleted} className="btn-secondary">清除已完成</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sorted.length === 0 ? (
          <div className="sidebar-empty">暂无下载</div>
        ) : (
          sorted.map((entry: DownloadItem) => (
            <div key={entry.id} className="download-item" title={entry.url}>
              <div className="download-icon">
                {entry.state === 'completed' ? (
                  <CheckCircle className="w-4 h-4" style={{ color: '#27ae60' }} />
                ) : entry.state === 'cancelled' || entry.state === 'interrupted' ? (
                  <XCircle className="w-4 h-4" style={{ color: '#e74c3c' }} />
                ) : (
                  <Download className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                )}
              </div>
              <div className="download-info">
                <span className="download-filename">{entry.filename}</span>
                <span className="download-meta">
                  {entry.state === 'progressing' && entry.speed ? entry.speed + ' · ' : ''}
                  {entry.state === 'completed' ? '已完成' :
                   entry.state === 'cancelled' ? '已取消' :
                   entry.state === 'interrupted' ? '已中断' :
                   entry.progress + '%'}
                  {entry.totalBytes > 0 ? ' · ' + formatFileSize(entry.totalBytes) : ''}
                </span>
                {entry.state === 'progressing' && (
                  <div className="download-progress">
                    <div className="download-progress-bar" style={{ width: entry.progress + '%' }} />
                  </div>
                )}
              </div>
              <button onClick={(e) => removeEntry(e, entry.id)} className="fav-remove" title="删除">
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
};

export default DownloadsPanel;
