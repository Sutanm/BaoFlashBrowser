// 窗口控制按钮（无边框窗口用）
function init() {
  var btnMin = document.getElementById('btn-win-min');
  var btnMax = document.getElementById('btn-win-max');
  var btnClose = document.getElementById('btn-win-close');
  if (!btnMin || !btnMax || !btnClose) return;

  if (window.electronAPI) {
    btnMin.addEventListener('click', function () {
      window.electronAPI.minimizeWindow();
    });

    btnMax.addEventListener('click', function () {
      window.electronAPI.toggleMaximizeWindow().then(function (isMax) {
        var icon = btnMax.querySelector('.icon');
        if (icon) {
          icon.className = 'icon ' + (isMax ? 'icon-window-restore' : 'icon-window-max');
        }
      });
    });

    btnClose.addEventListener('click', function () {
      window.electronAPI.closeWindow();
    });
  }
}

module.exports = { init: init };
