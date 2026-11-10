import React, { memo } from 'react';
import { Globe, Loader2, X } from 'lucide-react';
import type { TabState } from '@renderer/store/useTabsStore';
import { useI18nContext } from '@renderer/i18n/i18n-react';

interface TabItemProps {
  tab: TabState;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  /** P7：指针按下即进入拖拽候选；阈值/隐藏视图/落点由 TopBar 统一处理。 */
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  /**
   * 窗口里只剩这一个标签：此时标签没有"搬走"的语义，按住它应该拖动整个窗口
   * （Chrome 行为）。实现交给 Chromium 的 `-webkit-app-region: drag`——原生拖窗
   * 零延迟，比自己轮询 setPosition 稳得多。
   */
  windowDrag?: boolean;
  isDragOver: boolean;
  isDragging: boolean;
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  isActive,
  onSelect,
  onClose,
  onPointerDown,
  windowDrag = false,
  isDragOver,
  isDragging,
}) => {
  const { LL } = useI18nContext();

  return (
    <div
      data-tab-id={tab.id}
      data-dragging={isDragging ? 'true' : undefined}
      onPointerDown={windowDrag ? undefined : onPointerDown}
      onClick={onSelect}
      className={`tab-item ${isActive ? 'active' : ''} ${isDragOver ? 'drag-over' : ''} ${windowDrag ? 'tab-item-window-drag' : ''}`}
      title={tab.url || tab.title}
    >
      {/* 内容裁剪放在内层：外层 .tab-item 必须 overflow: visible，否则活动标签
          底部用来与工具栏衔接的圆角（::before/::after）会被一起裁掉 */}
      <div className="tab-inner">
        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {tab.isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
          ) : tab.favicon ? (
            <img src={tab.favicon} className="w-3.5 h-3.5" alt="" />
          ) : (
            <Globe className="w-3.5 h-3.5 text-gray-400" />
          )}
        </span>
        <span className="truncate leading-none">{tab.title || LL.tab.newTab()}</span>
        {tab.isAudible && (
          <span className="text-[10px] flex-shrink-0">{tab.isMuted ? '🔇' : '🔊'}</span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="tab-close"
          title={LL.tab.closeTab()}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default memo(TabItem);
