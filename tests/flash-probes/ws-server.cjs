const http = require('http');
const crypto = require('crypto');
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const payload = Buffer.from('probe-ok');
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  socket.write(frame);
  socket.on('error', () => {});
});
server.listen(8098, '127.0.0.1', () => console.log('ws listening 8098'));
