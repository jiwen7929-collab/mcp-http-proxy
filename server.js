import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const transports = new Map();

// 1. 添加 CORS 跨域放行头 (防止 App 底层 WebView 拦截)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function createMcpServer() {
  const mcpServer = new Server(
    { name: 'universal-http-client', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'send_request',
      description: '发送 HTTP 请求。用于绕过 JSON 解析 Bug，body 必须为纯字符串。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'string', description: 'JSON 格式字符串' },
          body: { type: 'string', description: '纯字符串请求体' }
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
        if (['POST', 'PUT', 'PATCH'].includes(options.method) && body) options.body = body;
        
        const response = await fetch(url, options);
        const text = await response.text();
        return { content: [{ type: 'text', text: `Status: ${response.status}\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
    throw new Error('Tool not found');
  });

  return mcpServer;
}

// 2. 优化连接路径：使用安全的绝对路径，防止客户端丢参
app.get('/sse', async (req, res) => {
  console.log('>>> [SSE] 新的连接请求到来');
  try {
    const sessionId = Date.now().toString();
    const transport = new SSEServerTransport(`/message/${sessionId}`, res);
    transports.set(sessionId, transport);
    
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    
    console.log(`>>> [SSE] 握手成功! Session: ${sessionId}`);
    
    req.on('close', () => {
      console.log(`>>> [SSE] 客户端主动断开了连接, Session: ${sessionId}`);
      transports.delete(sessionId);
    });
  } catch (e) {
    console.error('>>> [SSE] 致命错误:', e);
    if (!res.headersSent) res.status(500).send('Error');
  }
});

app.post('/message/:sessionId', async (req, res) => {
  console.log(`>>> [POST] 收到工具调用指令, Session: ${req.params.sessionId}`);
  try {
    const transport = transports.get(req.params.sessionId);
    if (!transport) {
      console.log('>>> [POST] 错误：找不到对应的会话记录');
      return res.status(404).send('Session not found');
    }
    await transport.handlePostMessage(req, res);
  } catch (e) {
    console.error('>>> [POST] 处理指令出错:', e);
    res.status(500).send('Message Error');
  }
});

app.get('/', (req, res) => res.send('MCP is running'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
