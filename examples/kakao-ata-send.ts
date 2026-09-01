/**
 * 카카오 알림톡 발송 — 채널·템플릿을 찾아 한 건 보낸다.
 *
 * ⚠️ **실제로 발송한다.** 알림톡은 건당 과금되고, 실패하면 대체발송 문자가 별도 1건으로
 * 더 청구된다. 시험 삼아 돌릴 때는 본인 번호를 `TO` 로 두는 편이 좋다.
 *
 * ── 환경변수 ──────────────────────────────────────────────────────
 *     export CLAWOPS_API_KEY="sk_..."
 *     export CLAWOPS_ACCOUNT_ID="AC..."
 *     export TO="01012345678"        # 수신번호
 *     export FROM="07052358010"      # 계정에 등록된 발신번호(대체발송에 쓰인다)
 *
 * ── 실행 ──────────────────────────────────────────────────────────
 *     npx tsx examples/kakao-ata-send.ts
 */
import ClawOps, { BadRequestError, UnprocessableEntityError } from '@teamlearners/clawops';

const to = process.env.TO;
const from = process.env.FROM;
if (!to || !from) {
  console.error('TO 와 FROM 을 설정해 주세요.');
  process.exit(1);
}

const client = new ClawOps();

// 1. 연결된 채널
const channels = await client.kakao.channels.list({ status: 'connected' });
const channel = channels.data[0];
if (!channel) {
  console.error('연결된 카카오 채널이 없습니다. 콘솔에서 채널을 먼저 연결하세요.');
  process.exit(1);
}
console.log(`채널: ${channel.name} (@${channel.searchId})`);

// 2. 발송 가능한 템플릿. sendable 이 정본이다 — status 만 보면 휴면 템플릿을 놓친다.
const templates = await client.kakao.templates.list({ channelId: channel.id, pageSize: 100 });
const template = templates.data.find((t) => t.sendable);
if (!template) {
  console.error('발송 가능한(sendable) 템플릿이 없습니다. 카카오 검수 상태를 확인하세요.');
  process.exit(1);
}
console.log(`템플릿: ${template.name}`);
console.log(`채워야 할 변수: ${template.variables.join(', ') || '(없음)'}`);

// 3. 변수는 전부 채워야 한다. 여기서는 데모용으로 이름을 그대로 값에 넣는다.
const variables = Object.fromEntries(template.variables.map((name) => [name, '테스트']));

try {
  const msg = await client.messages.create({
    to,
    from,
    kakao: { channelId: channel.id, templateId: template.id, variables },
    // 생략하면 템플릿 본문이 그대로 문자로 나간다. disabled: true 면 대체발송을 하지 않는다.
    fallback: { body: '알림톡 발송에 실패했습니다.' },
  });
  console.log(`발송: ${msg.messageId} (type=${msg.type}, status=${msg.status})`);
  console.log(`본문(변수 치환 결과): ${msg.body}`);
} catch (e) {
  // 사유는 문구가 아니라 code 로 분기한다.
  if (e instanceof BadRequestError && e.code === 'kakao_variable_missing') {
    console.error('템플릿 변수가 빠졌습니다:', e.message);
  } else if (e instanceof UnprocessableEntityError && e.code === 'recipient_blocked') {
    console.error('수신거부된 번호입니다 — 재시도하지 마세요.');
  } else {
    throw e;
  }
}
