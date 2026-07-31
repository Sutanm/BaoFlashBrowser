// D04: IPC 通道名常量化，集中管理所有 IPC 通道名
// 避免字符串散落在各文件中，减少拼写错误风险

export const IPC = {
  TAB: {
    CREATE: 'tab:create',
    CLOSE: 'tab:close',
    ACTIVATE: 'tab:activate',
    NAVIGATE: 'tab:navigate',
    GO_BACK: 'tab:goBack',
    GO_FORWARD: 'tab:goForward',
    RELOAD: 'tab:reload',
    STOP: 'tab:stop',
    ZOOM: 'tab:zoom',
    MUTE: 'tab:mute',
    DEVTOOLS: 'tab:devtools',
    FIND: 'tab:find',
    STOP_FIND: 'tab:stopFind',
    SET_BOUNDS: 'tab:setBounds',
    SET_RUFFLE_MODE: 'tab:setRuffleMode',
    // on() channels
    UPDATED: 'tab:updated',
    FOUND: 'tab:found',
    LOAD_ERROR: 'tab:load-error',
    CRASHED: 'tab:crashed',
    NEW_WINDOW: 'tab:newwindow',
  },
  DOWNLOAD: {
    ARIA2_STATUS: 'download:aria2-status',
    GET_DIR: 'download:get-dir',
    SET_DIR: 'download:set-dir',
    DELETE_FILE: 'download:delete-file',
    START: 'download:start',
    CANCEL: 'download:cancel',
    PAUSE: 'download:pause',
    RESUME: 'download:resume',
    OPEN: 'download:open',
    OPEN_DIR: 'download:openDir',
    // on() channels
    PROGRESS: 'download:progress',
  },
  CONFIG: {
    LOAD: 'load-config',
    SAVE: 'save-config',
  },
  WIN: {
    MINIMIZE: 'win:minimize',
    MAXIMIZE: 'win:maximize',
    UNMAXIMIZE: 'win:unmaximize',
    CLOSE: 'win:close',
    SET_FULLSCREEN: 'win:setFullscreen',
    TOGGLE_FULLSCREEN: 'win:toggleFullscreen',
    IS_MAXIMIZED: 'win:isMaximized',
  },
} as const;
