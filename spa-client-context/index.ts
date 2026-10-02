import * as http from 'node:http';
// Once you declare [telnyx] or [[secrets]] in func.toml, regenerate types
// with `telnyx-edge types` and import them:
//   import { env } from "@telnyx/edge-runtime";
//   const balance = await env.<TELNYX_BINDING>.balance.retrieve();
//   const value   = await env.SECRETS.get("<SECRET_BINDING>");

interface ResponseData {
  message: string;
  data?: any;
}

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health' || req.url?.startsWith('/health/')) { res.writeHead(200); res.end(); return; }

  // Default response
  const responseData: ResponseData = {
    message: 'Hello from Telnyx Edge Compute!'
  };

  // For POST requests, try to read and echo the request body
  if (req.method === 'POST') {
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      // If body exists, include it in response
      if (body) {
        try {
          // Try to parse as JSON first
          const requestData = JSON.parse(body);
          responseData.data = requestData;
        } catch (error) {
          // If not JSON, include as text
          responseData.data = body;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseData));
    });
  } else {
    // For GET and other methods, return immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseData));
  }
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
