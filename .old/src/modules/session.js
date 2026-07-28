var session = require('electron').session;
var log = require('electron-log');

function initSession(app) {
  var defaultSession = session.defaultSession;

  defaultSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36'
  );

  log.info('[Session] initialized');
}

function clearCache() {
  var defaultSession = session.defaultSession;
  defaultSession.clearCache(function () {
    log.info('[Session] cache cleared');
  });
}

module.exports = {
  initSession: initSession,
  clearCache: clearCache
};
