/**
 * 솔라피 알림톡 발송 이력 감사 — 읽기 전용.
 *
 * 알림톡이 실패했을 때 문자로 대체발송하는 기능을 설계하기 위한 실측 스크립트다.
 * **메시지를 한 건도 보내지 않는다.** 조회만 하고, 수신번호·본문은 출력하지 않는다.
 *
 * ── 설치 ──────────────────────────────────────────────────────────
 *     npm i solapi tsx
 *
 * ── 환경변수 ──────────────────────────────────────────────────────
 *     export SOLAPI_API_KEY="NCS..."
 *     export SOLAPI_API_SECRET="..."
 *     export AUDIT_DAYS="30"        # 선택, 기본 30일
 *
 * ── 실행 ──────────────────────────────────────────────────────────
 *     npx tsx examples/solapi-audit.ts
 *
 * 출력된 요약을 그대로 전달해 주시면 됩니다. 개인정보는 포함되지 않습니다.
 */
import { SolapiMessageService } from 'solapi';

const apiKey = process.env.SOLAPI_API_KEY;
const apiSecret = process.env.SOLAPI_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error('SOLAPI_API_KEY 와 SOLAPI_API_SECRET 을 설정해 주세요.');
  process.exit(1);
}

const DAYS = Number(process.env.AUDIT_DAYS ?? 30);
const PAGE = 500;
const MAX_PAGES = 40; // 안전장치. 20,000건까지만 훑는다

/** 상태코드 → 사람이 읽을 수 있는 사유 (알림톡 관련만) */
const REASONS: Record<string, string> = {
  '2000': '접수 완료',
  '3000': '이통사 접수(리포트 대기)',
  '3101': '발신 프로필 키가 유효하지 않음',
  '3102': '친구 관계가 아님',
  '3103': '메시지와 템플릿 불일치',
  '3104': '카카오톡 미사용자',
  '3105': '미등록 템플릿',
  '3106': '유효하지 않은 옐로아이디',
  '3107': '72시간 내 카톡 미사용 / 알림톡 차단',
  '3108': '발송 가능 시간이 아님(08:00~20:50)',
  '3109': '잘못된 파라미터 요청',
  '3117': '변수값 길이 초과',
  '4000': '수신 완료',
};

/** 대체발송 대상으로 검토 중인 코드 */
const FALLBACK_CANDIDATES = new Set(['3104', '3107', '3102']);

interface Stored {
  messageId?: string;
  statusCode?: string | null;
  text?: string | null;
  customFields?: Record<string, string> | null;
  kakaoOptions?: Record<string, unknown> | null;
  dateCreated?: string;
  dateReported?: string | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  return `${(ms / 60_000).toFixed(1)}분`;
}

async function main(): Promise<void> {
  const solapi = new SolapiMessageService(apiKey!, apiSecret!);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - DAYS * 24 * 60 * 60 * 1000);

  console.log(`솔라피 알림톡 감사 — 최근 ${DAYS}일 (발송 없음, 조회만)\n`);

  const byStatus = new Map<string, number>();
  const reportLagMs: number[] = [];
  let total = 0;
  let withCustomFields = 0;
  let withText = 0;
  let withTemplateId = 0;
  let maxCustomFieldChars = 0;
  let maxCustomFieldCount = 0;
  let sampleKakaoOptionKeys: string[] = [];
  let rateLimited = false;

  let startKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: { messageList?: Record<string, Stored>; nextKey?: string | null };
    try {
      response = (await solapi.getMessages({
        type: 'ATA',
        startDate,
        endDate,
        dateType: 'CREATED',
        limit: PAGE,
        startKey,
      })) as typeof response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/429|Too Many Requests|rate/i.test(message)) {
        rateLimited = true;
        console.log(`  ⚠️ ${page + 1}페이지에서 호출 제한에 걸렸습니다: ${message}`);
        break;
      }
      throw error;
    }

    const rows = Object.values(response.messageList ?? {});
    if (rows.length === 0) break;

    for (const row of rows) {
      total += 1;
      const code = String(row.statusCode ?? '(없음)');
      byStatus.set(code, (byStatus.get(code) ?? 0) + 1);

      if (row.customFields && Object.keys(row.customFields).length > 0) {
        withCustomFields += 1;
        const keys = Object.keys(row.customFields);
        maxCustomFieldCount = Math.max(maxCustomFieldCount, keys.length);
        for (const value of Object.values(row.customFields)) {
          maxCustomFieldChars = Math.max(maxCustomFieldChars, String(value).length);
        }
      }
      if (row.text != null && row.text !== '') withText += 1;
      if (row.kakaoOptions) {
        const keys = Object.keys(row.kakaoOptions);
        if (sampleKakaoOptionKeys.length === 0) sampleKakaoOptionKeys = keys;
        if ('templateId' in row.kakaoOptions) withTemplateId += 1;
      }
      if (row.dateCreated && row.dateReported) {
        const lag = new Date(row.dateReported).getTime() - new Date(row.dateCreated).getTime();
        if (Number.isFinite(lag) && lag >= 0) reportLagMs.push(lag);
      }
    }

    startKey = response.nextKey ?? undefined;
    if (!startKey) break;
  }

  if (total === 0) {
    console.log('해당 기간에 알림톡 발송 이력이 없습니다.');
    return;
  }

  // ── 1. 상태코드 분포 ────────────────────────────────────────────
  console.log(`총 ${total.toLocaleString()}건\n`);
  console.log('상태코드 분포');
  const sorted = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
  let fallbackTarget = 0;
  for (const [code, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1);
    const mark = FALLBACK_CANDIDATES.has(code) ? ' ← 대체발송 대상' : '';
    console.log(
      `  ${code}  ${String(count).padStart(6)}건 (${pct.padStart(5)}%)  ${REASONS[code] ?? ''}${mark}`,
    );
    if (FALLBACK_CANDIDATES.has(code)) fallbackTarget += count;
  }
  const perMonth = Math.round((fallbackTarget / DAYS) * 30);
  console.log(
    `\n  대체발송 대상 합계: ${fallbackTarget.toLocaleString()}건 (월 환산 약 ${perMonth.toLocaleString()}건)`,
  );

  // ── 2. 리포트 확정까지 걸린 시간 ────────────────────────────────
  reportLagMs.sort((a, b) => a - b);
  console.log('\n리포트 확정 지연 (dateCreated → dateReported)');
  console.log(`  표본 ${reportLagMs.length.toLocaleString()}건`);
  console.log(
    `  p50 ${fmtMs(percentile(reportLagMs, 0.5))}` +
      `  p90 ${fmtMs(percentile(reportLagMs, 0.9))}` +
      `  p99 ${fmtMs(percentile(reportLagMs, 0.99))}` +
      `  최대 ${fmtMs(reportLagMs.at(-1) ?? null)}`,
  );

  // ── 3. 조회 응답에 무엇이 실려 오는가 ───────────────────────────
  console.log('\n조회 응답에 실려 오는 것 (설계에 직접 영향)');
  console.log(
    `  customFields 있는 건   ${withCustomFields.toLocaleString()}건 (${((withCustomFields / total) * 100).toFixed(1)}%)`,
  );
  console.log(`    └ 값 최대 길이 ${maxCustomFieldChars}자, 필드 최대 ${maxCustomFieldCount}개`);
  console.log(
    `  text 있는 건            ${withText.toLocaleString()}건 (${((withText / total) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  kakaoOptions.templateId ${withTemplateId.toLocaleString()}건 (${((withTemplateId / total) * 100).toFixed(1)}%)`,
  );
  if (sampleKakaoOptionKeys.length > 0) {
    console.log(`  kakaoOptions 키 목록    ${sampleKakaoOptionKeys.join(', ')}`);
  }

  console.log(`\n호출 제한: ${rateLimited ? '⚠️ 걸림 (위 메시지 참조)' : '걸리지 않음'}`);
  console.log('\n※ 이 출력에는 수신번호·본문 등 개인정보가 포함되지 않습니다.');
}

main().catch((error) => {
  console.error('\n조회 실패:', error instanceof Error ? error.message : error);
  process.exit(1);
});
