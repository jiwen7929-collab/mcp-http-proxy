import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();

const mcpServer = new Server(
  { name: 'universal-http-client', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'send_request',
    description: '发送 HTTP 请求(支持 GET/POST)。用于绕过客户端 JSON 解析 Bug，body 必须作为纯字符串传入。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'string', description: 'JSON 格式的字符串' },
        body: { type: 'string', description: '请求体的原始字符串内容' }
      },
      required: ['url', 'method']
    }
  }]
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'send_request') {
    const { url, method, headers, body } = request.params.arguments;
    try {
      const parsedHeaders = headers ? JSON.parse(headers) : { 'Content-Type': 'application/json' };
      const options = { method: method.toUpperCase(), headers: parsedHeaders };
      
      if (['POST', 'PUT', 'PATCH'].includes(options.method) && body) {
        options.body = body;
      }
      
      const response = await fetch(url, options);
      const text = await response.text();
      return { content: [{ type: 'text', text: `Status: ${response.status}\n\n${text}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
  throw new Error('Tool not found');
});

const transports = new Map();

app.get('/sse', async (req, res) => {
  const sessionId = Date.now().toString();
  const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
  transports.set(sessionId, transport);
  await mcpServer.connect(transport);
  req.on('close', () => transports.delete(sessionId));
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).send('Session not found');
  await transport.handlePostMessage(req, res);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

