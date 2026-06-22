import { z } from 'zod';

/**
 * SIP 단말(digest credential). 평문 password/ha1 은 조회 응답에 포함되지 않음
 * (생성 시 1회만 노출). softphone 라우팅 설정 시 이 객체의 id 를
 * numbers.update(number, { sipCredentialId }) 로 넘긴다.
 */
export const SipCredentialSchema = z
  .object({
    id: z.string(),
    accountId: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
    realm: z.string().nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    status: z.enum(['active', 'disabled', 'deleted']).nullable().optional(),
    ipAclId: z.string().nullable().optional(),
    allowedNumbers: z.array(z.string()).nullable().optional(),
    lastUsedAt: z.string().nullable().optional(),
    dateCreated: z.string().nullable().optional(),
    dateUpdated: z.string().nullable().optional(),
  })
  .passthrough();

export type SipCredential = z.infer<typeof SipCredentialSchema>;

/**
 * SIP 엔드포인트(외부 PBX 트렁크). sip 라우팅 설정 시 이 객체의 id 를
 * numbers.update(number, { sipEndpointId }) 로 넘긴다.
 */
export const SipEndpointSchema = z
  .object({
    id: z.string(),
    accountId: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    maxConcurrent: z.number().nullable().optional(),
    status: z.enum(['active', 'disabled']).nullable().optional(),
    routes: z.array(z.unknown()).nullable().optional(),
    dateCreated: z.string().nullable().optional(),
    dateUpdated: z.string().nullable().optional(),
  })
  .passthrough();

export type SipEndpoint = z.infer<typeof SipEndpointSchema>;
