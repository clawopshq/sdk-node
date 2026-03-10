# Tool (함수 호출)

`agent.tool()` 메서드로 AI가 호출할 수 있는 함수를 등록합니다.

## 기본 사용법

```typescript
agent.tool(
  'check_order',
  '주문 상태를 확인합니다. 고객이 주문 번호를 말하면 이 함수를 호출하세요.',
  { orderId: { type: 'string' } },
  async ({ orderId }) => {
    const order = await db.getOrder(orderId);
    return `주문 ${orderId}는 ${order.status} 상태입니다.`;
  },
);
```

## 작성 규칙

- 콜백 함수는 반드시 `async`여야 합니다
- 반환 타입은 `string`이어야 합니다
- **설명(description)이 AI에게 함수 설명으로 전달됩니다** — 상세하게 작성하세요
- 파라미터 스키마는 JSON Schema 형식으로 정의합니다

```typescript
agent.tool(
  'search_products',
  '상품을 검색합니다. 고객이 상품을 찾을 때 사용하세요.',
  {
    query: { type: 'string' },           // required
    category: { type: 'string' },        // required
    limit: { type: 'number' },           // required
  },
  async ({ query, category, limit }) => {
    const results = await productApi.search(query, category, limit ?? 10);
    return results.map((r) => `- ${r.name}: ${r.price}원`).join('\n');
  },
);
```

## 내장 Tool: hang_up

`hang_up`은 자동으로 등록되는 내장 Tool입니다. AI가 대화가 끝났다고 판단하면 자동으로 전화를 종료합니다.
