// DOM 操作工具
function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str == null ? '' : String(str)));
  return div.innerHTML;
}

module.exports = { escapeHtml: escapeHtml };
