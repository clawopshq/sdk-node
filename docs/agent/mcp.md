# MCP 서버 연동

MCP(Model Context Protocol) 서버를 연결하여 AI에게 외부 도구를 제공할 수 있습니다.

## 설치

```bash
npm install claw-ops ws @modelcontextprotocol/sdk
```

> `@modelcontextprotocol/sdk` 없이 `mcpServers`를 설정하면 `AgentError: MCP 서버를 사용하려면 npm install @modelcontextprotocol/sdk 를 실행하세요.` 에러가 발생합니다.

## 사용법

```typescript
import { ClawOpsAgent, OpenAIRealtime, mcpServerHTTP, mcpServerStdio } from 'claw-ops/agent';

const agent = new ClawOpsAgent({
  from: '07012341234',
  session: new OpenAIRealtime({
    systemPrompt: '상담원입니다.',
  }),
  mcpServers: [
    // HTTP/SSE 기반 MCP 서버
    mcpServerHTTP('https://my-mcp-server.com', {
      headers: { Authorization: 'Bearer token' },
    }),
    // Stdio 기반 MCP 서버 (subprocess로 실행)
    mcpServerStdio('npx', {
      args: ['@modelcontextprotocol/server-google'],
      env: { GOOGLE_API_KEY: '...' },
    }),
  ],
});
```

## 동작 방식

MCP 서버는 **전화가 올 때마다** 자동으로 시작되고, **통화 종료 시** 정리됩니다:

1. 전화 수신 → MCP 서버 프로세스 시작 (Stdio) 또는 HTTP 연결
2. MCP 프로토콜로 `tools/list` 호출 → 사용 가능한 도구 목록 수집
3. `agent.tool()`로 등록한 도구와 함께 AI에 자동 등록
4. AI가 MCP 도구를 호출하면 → MCP 프로토콜로 `tools/call` 전달
5. 통화 종료 → MCP 서버 연결 종료 및 도구 정리

## 주의사항

- `agent.tool()`과 MCP 도구의 이름이 충돌하면 `AgentError`가 발생합니다
- MCP 서버 연결이 실패하면 해당 통화의 AI 처리가 시작되지 않습니다
