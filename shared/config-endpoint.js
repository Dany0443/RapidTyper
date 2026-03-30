/**
 * config-endpoint.js
 * Generates the automatic websocket resolution script for clients.
 */

function generateConfigJs() {
    return `
/* RapidTyper WS URL auto-detection */
(function(){
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var host  = location.hostname || 'localhost';
  var port  = location.port;
  var wsPort;
  
  if (port === '8443' || port === '8080') {
      // School Server: WS is on the same port as HTTP/HTTPS
      wsPort = port;
  } else if (port === '5890') {
      // Dev MainServer: UI on 5890, WS on 5889
      wsPort = '5889';
  } else {
      // Fallback
      wsPort = port;
  }
  
  window.__WS_URL__ = proto + '://' + host + (wsPort ? ':' + wsPort : '');
})();
`;
}

function handleConfigRequest(req, res) {
    if (req.url === '/config.js') {
        res.writeHead(200, {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(generateConfigJs());
        return true;
    }
    return false;
}

module.exports = { handleConfigRequest, generateConfigJs };
