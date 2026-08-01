// 集中状态管理
var state = {
  tabs: [],
  activeTabId: null,
  tabIdCounter: 0,
  isMuted: false,
  savedFlashVersion: '34.0.0.330',
  // 缩放功能状态
  defaultZoomFactor: 1.0,  // 默认100%
  zoomStep: 0.1            // 每级10%
};

module.exports = state;
