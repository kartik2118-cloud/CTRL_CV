/**
 * extension/config.js
 * Default configuration constants for LiveSub extension.
 * Placeholder URL is required until operator configures the production backend.
 */
(function(root) {
  'use strict';

  var DEFAULT_WS_URL = 'wss://REPLACE_ME/ws';

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_WS_URL: DEFAULT_WS_URL };
  }
  root.DEFAULT_WS_URL = DEFAULT_WS_URL;
  root.CtrlCVConfig = { DEFAULT_WS_URL: DEFAULT_WS_URL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
