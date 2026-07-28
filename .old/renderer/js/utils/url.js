// URL 处理工具
function isUrl(input) {
  if (!input) return false;
  if (input === 'about:blank' || input === 'localhost') return true;
  if (input.indexOf('://') !== -1) {
    return /^https?:\/\//i.test(input) || /^file:\/\//i.test(input);
  }
  if (input.indexOf('.') !== -1 && input.indexOf(' ') === -1) {
    var host = input.split('/')[0];
    var parts = host.split('.');
    if (parts.length < 2) return false;
    var tld = parts[parts.length - 1];
    if (tld.length < 2) return false;
    return true;
  }
  return false;
}

function normalizeUrl(input) {
  if (!input) return 'about:blank';
  if (input.indexOf('://') !== -1) return input;
  if (input.indexOf('.') !== -1 && input.indexOf(' ') === -1) return 'https://' + input;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(input);
}

module.exports = { isUrl: isUrl, normalizeUrl: normalizeUrl };
