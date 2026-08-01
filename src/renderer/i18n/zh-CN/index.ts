import type { BaseTranslation } from '../i18n-types';

const zhCN: BaseTranslation = {
  // 通用
  ok: '确定',
  cancel: '取消',
  retry: '重试',
  loading: '加载中...',
  confirm: '确认',
  back: '后退',
  forward: '前进',
  refresh: '刷新',
  stop: '停止',
  close: '关闭',
  save: '保存',
  delete: '删除',
  clear: '清空',
  reset: '重置',
  copy: '复制',
  search: '搜索',
  none: '无',
  default: '默认',
  enabled: '已启用',
  disabled: '已禁用',

  // 窗口控件
  win: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭',
  },

  // 标签页
  tab: {
    newTab: '新标签页',
    closeTab: '关闭标签页',
    newTabHint: '新标签页 (Ctrl+T)',
  },

  // 侧边栏
  sidebar: {
    favorites: '收藏夹',
    history: '历史记录',
    downloads: '下载',
    passwords: '密码',
    settings: '设置',
    expand: '展开侧边栏',
    collapse: '折叠侧边栏',
  },

  // 地址栏
  addressbar: {
    placeholder: '输入网址或搜索...',
    bookmarkRemove: '取消收藏',
    bookmarkAdd: '收藏当前页',
    mute: '静音',
    unmute: '取消静音',
    zoomOut: '缩小 (Ctrl+-)',
    zoomIn: '放大 (Ctrl++)',
    zoomReset: '点击重置为100%',
  },

  // Ruffle 切换
  ruffle: {
    flashMode: 'Flash 模式',
    ruffleMode: 'Ruffle 模式',
    switchToRuffle: 'Flash 模式 — 点击切换 Ruffle',
    switchToFlash: 'Ruffle 模式 — 点击切换 Flash',
    flash: 'Flash',
    ruffle: 'Ruffle',
  },

  // 收藏夹
  favorites: {
    bookmarkRemove: '★ 已收藏（点击取消）',
    bookmarkAdd: '☆ 添加当前页',
    empty: '暂无收藏',
  },

  // 历史记录
  history: {
    today: '今天',
    yesterday: '昨天',
    thisWeek: '本周',
    earlier: '更早',
    searchPlaceholder: '搜索历史记录',
    clear: '清空',
    clearConfirm: '清空所有历史记录？',
    empty: '暂无历史记录',
    visitCount: '{count} 次访问',
    cleared: '历史记录已清空',
  },

  // 下载
  download: {
    title: '下载文件',
    engine: '引擎',
    location: '位置',
    empty: '暂无下载',
    clearCompleted: '清除已完成',
    cleared: '已清除完成的下载',
    dirChanged: '下载目录已更改',
    selectDir: '选择下载目录',
    deleted: '{filename} 已删除',
    deleteFailed: '{filename} 删除失败',
    deleteConfirm: '确定删除 "{filename}"？',
    openFile: '打开文件',
    openDir: '打开文件夹',
    removeRecord: '移除记录',
    pause: '暂停下载',
    resume: '恢复下载',
    cancel: '取消下载',
    // 状态
    paused: '已暂停',
    complete: '已完成',
    cancelled: '已取消',
    interrupted: '已中断',
    preparing: '准备中...',
    detecting: '检测中...',
    ready: '就绪',
    aria2Unavailable: 'aria2 不可用，已回退',
    started: '{name} 开始下载',
    completed: '{name} 下载完成',
    cancelledNotify: '{name} 已取消',
    failed: '{name} 下载失败',
    file: '文件',
  },

  // 密码
  password: {
    notSetup: '尚未设置主密码',
    notSetupDesc: '设置后可保存和查看密码',
    setupPlaceholder: '设置主密码 (8位, 含大小写+数字)',
    confirmPlaceholder: '确认主密码',
    setupBtn: '设置主密码',
    mismatch: '两次密码不一致',
    tooShort: '密码至少 8 位',
    complexityFail: '密码需包含大写、小写和数字',
    setupFailed: '设置失败',
    enable: '启用密码本',
    unlockPlaceholder: '输入主密码解锁',
    unlockBtn: '解锁',
    wrongPassword: '密码错误',
    lock: '锁定',
    empty: '暂无保存的密码',
    hide: '隐藏',
    view: '查看',
    setDefault: '设为默认',
    resetBtn: '重置密码本',
    resetConfirm: '确认重置？再次点击确认',
    resetDone: '密码本已重置',
    resetDesc: '重置将清空所有已保存的密码，需重新设置主密码。',
    captureNotify: '检测到登录信息，可启用密码本保存',
    enableBtn: '启用密码本',
    savePrompt: '为 {host} 保存密码？',
    ignore: '忽略',
    deleted: '已删除',
  },

  // 设置
  settings: {
    title: '设置',
    saved: '设置已保存',
    savedRestart: '设置已保存，需重启生效',
    saveBtn: '保存设置',
    savedBtn: '已保存 ✓',
    savedRestartBtn: '已保存 — 需重启生效',
    // 通用
    general: '通用',
    homepage: '主页地址',
    searchEngine: '搜索引擎',
    baidu: '百度',
    spoofVersion: '伪装版本',
    spoofVersionHint: '伪装为指定版本号，部分网站会检测。需重启生效。',
    lowEndMode: '低性能设备模式',
    lowEndModeHint: '需重启生效',
    // Ruffle
    ruffle: 'Ruffle',
    defaultEngine: '新标签默认引擎',
    ppapiAuto: '自动 (PPAPI 优先)',
    preferRuffle: 'Ruffle (WASM 模拟)',
    ppapiOnly: '仅 PPAPI',
    ruffleSource: 'Ruffle 来源',
    bundled: '自托管 (离线可用)',
    cdn: 'CDN (始终最新)',
    ruffleHint: '仅对新建标签页生效，已有标签页用导航栏按钮切换',
    // 下载
    download: '下载',
    downloadEngine: '下载引擎',
    aria2: 'aria2 (多连接加速)',
    chromium: 'Chromium (内置)',
    // 外观
    appearance: '外观',
    zoom: '页面缩放',
    zoomReset: '重置',
    theme: '主题',
    themeMode: '主题模式',
    light: '亮色',
    dark: '暗色',
    system: '跟随系统',
    // 语言
    language: '语言',
  },

  // 查找
  find: {
    placeholder: '查找',
  },

  // 新标签页
  newtab: {
    searchPlaceholder: '搜索或输入网址',
    baidu: '百度',
    bilibili: 'B站',
  },

  // 收藏 Toast
  bookmark: {
    added: '已收藏 {title}',
    removed: '已取消收藏 {title}',
  },

  // 错误
  error: {
    title: '出错了',
    default: '组件渲染异常',
    dnsFail: 'DNS 解析失败',
    pageLoadFail: '页面加载失败',
    pageCrashed: '页面崩溃了',
  },
};

export default zhCN;
