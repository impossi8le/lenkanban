const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3555', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

console.log('[SERVER] Preparing Next.js...');

app.prepare().then(async () => {
  console.log('[SERVER] Next.js ready, creating HTTP server...');

  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('[SERVER] Error handling request:', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  // NOTE: Socket.IO runs as separate PM2 process on port 3556
  // See ecosystem.config.js and npm run socket:start
  console.log('[SERVER] Socket.IO running on separate process (port 3556)');

  httpServer.listen(port, (err) => {
    if (err) throw err;
    console.log(`[SERVER] Ready on http://${hostname}:${port}`);
    console.log(`[SERVER] Socket.IO available at ws://${hostname}:${port}/socket.io`);
  });
}).catch((err) => {
  console.error('[SERVER] Failed to start:', err);
  process.exit(1);
});
