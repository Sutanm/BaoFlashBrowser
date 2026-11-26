<script setup lang="ts">
/**
 * 外壳与内部页共用的一套线性图标（24×24 视口、1.7 描边、圆角端点）。
 *
 * 设置页左栏按 Edge 的样子列图标（2026-11-26）：图标只放"能对上语义"的那几个，
 * 没有合适语义的项就不硬塞（宁可没有图标，也不要放一个意思不对的）。
 */
defineProps<{
  name: 'lock' | 'chevron' | 'flash' | 'ruffle' | 'check' | 'error' | 'close' | 'gear'
  | 'palette' | 'shield' | 'home' | 'gauge' | 'translate' | 'info'
  | 'star' | 'star-filled' | 'page' | 'folder' | 'bookmarks' | 'search'
}>()
</script>

<template>
  <svg class="shell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g v-if="name === 'lock'">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </g>
    <path v-else-if="name === 'chevron'" d="m6 9 6 6 6-6" />
    <path v-else-if="name === 'flash'" d="m13 2-8 12h6l-1 8 9-12h-6z" />
    <path v-else-if="name === 'ruffle'" d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
    <path v-else-if="name === 'check'" d="m5 12 4 4 10-10" />
    <g v-else-if="name === 'error'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6m0 4h.01" />
    </g>
    <!-- 齿轮：空心 cog（描边），与其它图标的线宽一致 -->
    <g v-else-if="name === 'gear'">
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .2.2.4.5.4h4c.2 0 .4-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6z" />
      <circle cx="12" cy="12" r="3.1" />
    </g>
    <!-- 调色板：外观（主题） -->
    <g v-else-if="name === 'palette'">
      <path d="M12 3a9 9 0 0 0 0 18c1.6 0 2.2-1.1 2.2-2.2 0-1.5-1.4-1.6-1.4-3.1 0-1.4 1.3-2.4 2.8-2.4H18a3 3 0 0 0 3-3c0-4.1-4-7.3-9-7.3z" />
      <circle cx="8.4" cy="10" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="10" r=".9" fill="currentColor" stroke="none" />
    </g>
    <!-- 盾牌：隐私、搜索和服务 -->
    <path v-else-if="name === 'shield'" d="M12 3.2 19 6v5c0 4.6-3 8.2-7 9.8-4-1.6-7-5.2-7-9.8V6z" />
    <!-- 房子：启动（主页/新标签页） -->
    <path v-else-if="name === 'home'" d="m4 11 8-7 8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z" />
    <!-- 仪表：性能 -->
    <g v-else-if="name === 'gauge'">
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 18 4-5.5" />
      <circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </g>
    <!-- 翻译：语言 -->
    <g v-else-if="name === 'translate'">
      <path d="M4 6h8M8 4.5v1.5c0 4-1.8 6.6-4 7.8" />
      <path d="M4.6 9.6c1.4 2.4 3.4 4 5.9 5" />
      <path d="M13 20l4-9 4 9M14.6 17h4.8" />
    </g>
    <!-- 圆圈 i：关于 -->
    <g v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.6v.4" />
    </g>
    <!-- 星标：工具栏「收藏此页面」。空心=未收藏，实心=已收藏（Chrome/Edge 同一套语义）。 -->
    <path v-else-if="name === 'star'" d="m12 3.7 2.6 5.4 5.9.9-4.3 4.2 1 5.9-5.2-2.9-5.2 2.9 1-5.9-4.3-4.2 5.9-.9z" />
    <path v-else-if="name === 'star-filled'" d="m12 3.7 2.6 5.4 5.9.9-4.3 4.2 1 5.9-5.2-2.9-5.2 2.9 1-5.9-4.3-4.2 5.9-.9z"
      fill="currentColor" stroke="none" />
    <!-- 文档：收藏夹列表里的网址收藏 -->
    <g v-else-if="name === 'page'">
      <path d="M7 3.6h6.4L18 8.2v12.2H7z" />
      <path d="M13.4 3.6v4.6H18" />
    </g>
    <!-- 文件夹：收藏夹里的文件夹（本轮只展示，不可新建/拖动） -->
    <path v-else-if="name === 'folder'" d="M4 7.6A1.6 1.6 0 0 1 5.6 6h3.6l1.7 2.1h7.5a1.6 1.6 0 0 1 1.6 1.6v7.3a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17z" />
    <!-- 收藏夹（书签带 + 列表）：工具栏那颗打开收藏夹树的按钮（星标在地址栏里，是另一件事） -->
    <g v-else-if="name === 'bookmarks'">
      <path d="M14 3.8h5.2v16.3l-2.6-2.7-2.6 2.7z" />
      <path d="M4.2 6.4h6.4M4.2 11h6.4M4.2 15.6h4.4" />
    </g>
    <!-- 放大镜：收藏夹管理页的搜索框（与系统控件同一语义，纯装饰） -->
    <g v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </g>
    <path v-else d="m6 6 12 12M18 6 6 18" />
  </svg>
</template>

<style>
.shell-icon { width: 16px; height: 16px; flex: none; }
</style>
