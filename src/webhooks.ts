import { createHmac, timingSafeEqual } from 'node:crypto';
import { ClawOpsError } from './error.js';

export class WebhookVerificationError extends ClawOpsError {
  constructor(message = 'Webhook 서명이 일치하지 않습니다.') {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export class Webhooks {
  verify(options: {
    url: string;
    params: Record<string, string>;
    signature: string;
    signingKey: string;
  }): boolean {
    const expected = Webhooks._computeSignature(options.url, options.params, options.signingKey);
    const expectedBuf = Buffer.from(expected, 'utf-8');
    const signatureBuf = Buffer.from(options.signature, 'utf-8');

    if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
      throw new WebhookVerificationError();
    }
    return true;
  }

  static _computeSignature(
    url: string,
    params: Record<string, string>,
    signingKey: string,
  ): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join('');
    const dataToSign = url + sortedParams;
    const digest = createHmac('sha256', signingKey).update(dataToSign, 'utf-8').digest();
    return digest.toString('base64');
  }
}
