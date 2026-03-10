/**
 * snake_case를 camelCase로 변환합니다.
 * trailing underscore(예약어 회피용)는 제거합니다.
 * 예: 'from_' -> 'from', 'account_id' -> 'accountId'
 */
export function toCamelCase(snake: string): string {
  if (snake.endsWith('_')) {
    snake = snake.slice(0, -1);
  }
  const parts = snake.split('_');
  return parts[0] + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * null/undefined 값을 제거하여 API에 불필요한 필드를 보내지 않습니다.
 */
export function stripNotGiven(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v != null) {
      result[k] = v;
    }
  }
  return result;
}
