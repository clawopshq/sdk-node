/** 한 번에 띄우는 ClawOps 요청 수. 솔라피의 배치 한 번이 우리에겐 요청 N 번이 된다 */
export const DEFAULT_CONCURRENCY = 10;

/**
 * 순서를 지키면서 동시 요청 수를 제한한다.
 *
 * 배치를 끊어 기다리면 한 건의 재시도가 같은 배치 전체를 붙잡으므로,
 * 워커가 공용 커서를 당겨 써서 빈 슬롯이 생기지 않게 한다.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await run(items[index]!);
    }
  };
  // limit 이 0 이면 워커가 하나도 안 떠서 전부 조용히 누락된다.
  // `concurrency: Number(process.env.X)` 가 미설정 시 0 이 되는 흔한 경로가 있다
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
