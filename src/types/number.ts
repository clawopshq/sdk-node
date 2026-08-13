import { z } from 'zod';

/**
 * 착신 라우팅 모드.
 *
 * - `webhook`   : webhookUrl 의 VoiceML 이 처리.
 * - `agent`     : agentId 의 매니지드 에이전트가 착신.
 * - `callflow`  : callFlowId 의 콜 플로우(ARS)가 착신.
 * - `forward`   : forwardTo(같은 계정 보유 번호)로 내부 착신전환.
 * - `sip`       : sipEndpointId 의 라우트로 외부 PBX 다이얼.
 * - `softphone` : sipCredentialId 의 등록 단말로 착신.
 */
export const ROUTING_TYPES = [
  'webhook',
  'sip',
  'softphone',
  'forward',
  'agent',
  'callflow',
] as const;

export type RoutingType = (typeof ROUTING_TYPES)[number];

export const PhoneNumberSchema = z
  .object({
    number: z.string(),
    numberType: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    // routingType 은 enum 으로 좁히지 않는다. 좁히면 서버가 라우팅 종류를 늘렸을 때 그 번호가
    // 섞인 목록 조회가 통째로 실패한다(0.28.0 까지의 실제 결함: 'agent' 로 라우팅된 번호
    // 하나가 numbers.list() 전체를 깨뜨렸다).
    routingType: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
    callFlowId: z.string().nullable().optional(),
    forwardTo: z.string().nullable().optional(),
    sipEndpointId: z.string().nullable().optional(),
    sipCredentialId: z.string().nullable().optional(),
    webhookUrl: z.string().nullable().optional(),
    webhookMethod: z.string().nullable().optional(),
    webhookHeaders: z.record(z.string()).nullable().optional(),
    callContextUrl: z.string().nullable().optional(),
    statusCallback: z.string().nullable().optional(),
    statusCallbackEvents: z.string().nullable().optional(),
    dictionaryId: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * 전화번호. `routingType` 은 알려진 값에 자동완성이 뜨지만, 서버가 새 라우팅을 추가해도
 * 파싱이 깨지지 않도록 임의의 문자열을 허용한다.
 */
export type PhoneNumber = Omit<z.infer<typeof PhoneNumberSchema>, 'routingType'> & {
  routingType?: RoutingType | (string & {}) | null;
};

export type NumberListItem = PhoneNumber;
export type NumberUpdateResponse = PhoneNumber;
