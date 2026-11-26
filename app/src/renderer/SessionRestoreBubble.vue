<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import './overlay-panel.css'

/**
 * 崩溃恢复气泡（Chromium 的 `SessionCrashedBubbleView`，刻意逐项对齐）。
 *
 * 源码依据（本机 142.0.7444.265 检出 `D:\electron-build-142\cr\src`）：
 * - `chrome/browser/ui/views/session_crashed_bubble_view.cc:219-278`：
 *   `BubbleDialogModelHost` + `BubbleBorder::TOP_RIGHT`，锚在**工具栏最右那颗按钮**
 *   （Chrome 是应用菜单 `GetAppMenuButton()`，我们是齿轮）；`SetIsAlertDialog()` +
 *   `DisableCloseOnDeactivate()`——**失焦不关**，必须回答；
 * - 文案：`IDS_SESSION_CRASHED_BUBBLE_TITLE` =「Restore pages?」、
 *   `IDS_SESSION_CRASHED_VIEW_MESSAGE` =「Chrome didn't shut down correctly.」、
 *   主按钮 `IDS_SESSION_CRASHED_VIEW_RESTORE_BUTTON` =「Restore」；
 * - 默认只有一个主按钮；右上角 × 是"不恢复"（= 忽略这次会话）。
 *   Chromium 只在启动页模板非空时才多一个「打开启动页」的按钮，我们没有那个模式，故不出现。
 *
 * 与 Chromium 的两处本地差异（都写进 `docs/reports/2026-11-26-session-bubble.md`）：
 * 1. 正文多一行「可恢复 N 个标签页」：Chromium 只说"没正常关闭"，我们的会话是跨窗口并回，
 *    标签数是用户判断"值不值得恢复"的唯一依据；
 * 2. × 带 `title="忽略"`：Chromium 靠图标语义，中文环境光一个 × 容易被当成"稍后再说"。
 *
 * 载体：与飞窗**共用同一个叠加层视图与渲染进程**（`shell-overlays.ts`），
 * 但语义是警示对话框——点卡片外面不会关（`onFlyoutMouse` 对 bubble 直接返回）。
 */
defineProps<{ tabs: number }>()

const panel = ref<HTMLElement>()
const restoreButton = ref<HTMLButtonElement>()
const busy = ref(false)
let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let lastSentHeight = 0

/** 与其它叠加层同一套高度上报：报卡片高度，主进程加投影边距后设视图高度。 */
function measure(): void {
  const element = panel.value
  if (!element) return
  const contentHeight = element.scrollHeight
  if (contentHeight < 40) return
  const next = contentHeight + 2
  if (Math.abs(next - lastSentHeight) < 1) return
  lastSentHeight = next
  void window.baoOverlay.resizeBubble(next)
}

/**
 * 回答。`busy` 只是防止双击把一次决定算成两次（主进程侧也会因为视图已收而返回 false）。
 */
async function answer(restore: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await window.baoOverlay.closeBubble(restore)
  } finally {
    busy.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  // Enter = 恢复（警示对话框的默认按钮）；Esc = 忽略。主进程的 `before-input-event`
  // 会先一步处理 Esc（浮层收在自己的视图里），这里保留一份是为了键盘焦点在空格/Enter
  // 之外的第三方路径（例如辅助技术合成的事件）也能得到同样结果。
  if (event.key === 'Escape') {
    event.preventDefault()
    void answer(false)
    return
  }
  if (event.key === 'Enter' && (event.target as HTMLElement | null)?.tagName !== 'BUTTON') {
    event.preventDefault()
    void answer(true)
  }
}

onMounted(() => {
  applyShellTheme(initialShellTheme())
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'bubble-opened') {
      applyShellTheme(event.theme)
      lastSentHeight = 0
      void nextTick(() => {
        // Chromium 的警示对话框把焦点放在默认按钮上：Enter 就是"恢复"。
        restoreButton.value?.focus({ preventScroll: true })
        measure()
      })
    }
  })
  observer = new ResizeObserver(measure)
  if (panel.value) observer.observe(panel.value)
  void nextTick(measure)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  detach?.()
})
</script>

<template>
  <div class="bubble-frame session-bubble-frame" @keydown="onKeydown">
    <section
      id="session-restore-bubble"
      ref="panel"
      class="overlay-card session-bubble"
      role="alertdialog"
      aria-labelledby="session-restore-title"
      aria-describedby="session-restore-message"
    >
      <header class="session-bubble-head">
        <h2 id="session-restore-title" class="session-bubble-title">恢复页面?</h2>
        <button
          type="button"
          class="session-bubble-close"
          aria-label="忽略"
          title="忽略（不恢复）"
          :disabled="busy"
          @click="answer(false)"
        ><ShellIcon name="close" /></button>
      </header>

      <p id="session-restore-message" class="session-bubble-message">
        BaoFlashBrowser 未正常关闭。
      </p>
      <p class="session-bubble-detail">
        可恢复 <span class="session-bubble-count">{{ tabs }}</span> 个标签页。
      </p>

      <footer class="session-bubble-actions">
        <button
          ref="restoreButton"
          type="button"
          class="overlay-button primary"
          :disabled="busy"
          @click="answer(true)"
        >恢复</button>
      </footer>
    </section>
  </div>
</template>

<style>
/* 与编辑气泡同一套外框（视图比卡片大一圈，边距里画投影，鼠标由主进程转发给页面）。 */
.session-bubble-frame {
  box-sizing: border-box;
  width: 100%;
  height: 100vh;
  padding: 0 var(--overlay-gutter-x, 12px) var(--overlay-gutter-bottom, 20px);
  display: flex;
  align-items: flex-start;
}

/* 卡片内距比飞窗宽一档：警示对话框的正文需要呼吸，11px 的标签内距会让两段文字挤成一团。 */
.session-bubble { padding: 8px 10px 10px; }

.session-bubble-head { display: flex; align-items: flex-start; gap: 8px; }
/* 标题用正文色、14px：它不是菜单分组标签（那档是 11px 灰），而是这句话的主语。 */
.session-bubble-title {
  flex: 1;
  margin: 0;
  padding: 2px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.session-bubble-close {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border-radius: 5px; color: var(--text-secondary); flex: none;
}
.session-bubble-close:hover { color: var(--text-primary); background: var(--surface-hover); }
.session-bubble-close:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: -1px; }
.session-bubble-close .shell-icon { width: 13px; height: 13px; }

.session-bubble-message { margin: 4px 0 0; font-size: 12px; line-height: 1.5; }
.session-bubble-detail {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
}
.session-bubble-count { font-variant-numeric: tabular-nums; color: var(--text-primary); }

/* 按钮靠右：警示对话框的动作在底部右侧（Chromium 的 dialog 按钮区）。 */
.session-bubble-actions { display: flex; justify-content: flex-end; gap: 6px; padding-top: 10px; }
.session-bubble-actions .overlay-button { min-width: 64px; }
</style>
