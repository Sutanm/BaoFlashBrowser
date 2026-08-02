import crypto from 'crypto';
import http from 'http';
import net from 'net';

export interface Aria2RpcClient {
  port: number;
  secret: string;
  call(method: string, ...params: unknown[]): Promise<unknown>;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function createAria2RpcClient(): Promise<Aria2RpcClient> {
  const port = await reserveLoopbackPort();
  const secret = 'bao_' + crypto.randomBytes(16).toString('hex');
  return {
    port,
    secret,
    call(method: string, ...params: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 'bao_' + Date.now(),
          method,
          params: [`token:${secret}`, ...params],
        });
        const request = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/jsonrpc',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error) reject(new Error(json.error.message));
              else resolve(json.result);
            } catch (error) {
              reject(error);
            }
          });
        });
        request.on('error', reject);
        request.end(body);
      });
    },
  };
}
