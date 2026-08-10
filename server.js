import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const transports = new Map();

// 【核心修复】将 Server 初始化封装，确保每个连接都是独立的实例，防止重连崩溃
function createMcpServer() {
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

  return mcpServer;
}

// SSE 连接路由
app.get('/sse', async (req, res) => {
  try {
    const sessionId = Date.now().toString();
    const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
    transports.set(sessionId, transport);
    
    const mcpServer = createMcpServer(); // 每次新建实例
    await mcpServer.connect(transport);
    
    req.on('close', () => transports.delete(sessionId));
  } catch (e) {
    console.error('SSE Error:', e);
    res.status(500).send('Internal Server Error');
  }
});

// 消息接收路由
app.post('/message', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) {
      return res.status(404).send('Session not found');
    }
    await transport.handlePostMessage(req, res);
  } catch (e) {
    console.error('Message Error:', e);
    res.status(500).send('Message Error');
  }
});

// 健康检查路由（防止云服务探针报错）
app.get('/', (req, res) => {
  res.send('MCP Proxy is running. Please connect via /sse');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
