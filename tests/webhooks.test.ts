import { describe, it, expect } from 'vitest';
import { Webhooks, WebhookVerificationError } from '../src/webhooks.js';
import { ClawOpsError } from '../src/error.js';

describe('Webhooks', () => {
  const webhooks = new Webhooks();
  const signingKey = 'test-secret-key-12345';
  const url = 'https://example.com/webhook';
  const params = { CallSid: 'CA123', From: '+15551234567', To: '+15559876543' };

  function computeValidSignature(
    testUrl: string,
    testParams: Record<string, string>,
    key: string,
  ): string {
    return Webhooks._computeSignature(testUrl, testParams, key);
  }

  describe('WebhookVerificationError', () => {
    it('extends ClawOpsError', () => {
      const err = new WebhookVerificationError();
      expect(err).toBeInstanceOf(ClawOpsError);
      expect(err.name).toBe('WebhookVerificationError');
    });

    it('has default message', () => {
      const err = new WebhookVerificationError();
      expect(err.message).toContain('서명');
    });

    it('accepts custom message', () => {
      const err = new WebhookVerificationError('custom error');
      expect(err.message).toBe('custom error');
    });
  });

  describe('verify', () => {
    it('returns true for valid signature', () => {
      const signature = computeValidSignature(url, params, signingKey);
      const result = webhooks.verify({ url, params, signature, signingKey });
      expect(result).toBe(true);
    });

    it('throws WebhookVerificationError for invalid signature', () => {
      expect(() =>
        webhooks.verify({
          url,
          params,
          signature: 'invalid-signature-base64==',
          signingKey,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it('throws when signature is tampered (one char changed)', () => {
      const validSig = computeValidSignature(url, params, signingKey);
      // Tamper with the signature
      const tamperedSig = validSig.slice(0, -1) + (validSig.endsWith('A') ? 'B' : 'A');

      expect(() =>
        webhooks.verify({
          url,
          params,
          signature: tamperedSig,
          signingKey,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it('throws when params are tampered', () => {
      const signature = computeValidSignature(url, params, signingKey);
      const tamperedParams = { ...params, From: '+15550000000' };

      expect(() =>
        webhooks.verify({
          url,
          params: tamperedParams,
          signature,
          signingKey,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it('throws when URL is different', () => {
      const signature = computeValidSignature(url, params, signingKey);

      expect(() =>
        webhooks.verify({
          url: 'https://other.com/webhook',
          params,
          signature,
          signingKey,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it('throws when signing key is wrong', () => {
      const signature = computeValidSignature(url, params, signingKey);

      expect(() =>
        webhooks.verify({
          url,
          params,
          signature,
          signingKey: 'wrong-key',
        }),
      ).toThrow(WebhookVerificationError);
    });

    it('works with empty params', () => {
      const emptyParams: Record<string, string> = {};
      const signature = computeValidSignature(url, emptyParams, signingKey);

      const result = webhooks.verify({
        url,
        params: emptyParams,
        signature,
        signingKey,
      });
      expect(result).toBe(true);
    });

    it('params order does not matter (sorted internally)', () => {
      const paramsA = { Zebra: '1', Alpha: '2', Middle: '3' };
      const paramsB = { Alpha: '2', Middle: '3', Zebra: '1' };
      const sigA = computeValidSignature(url, paramsA, signingKey);
      const sigB = computeValidSignature(url, paramsB, signingKey);

      expect(sigA).toBe(sigB);

      expect(webhooks.verify({ url, params: paramsA, signature: sigA, signingKey })).toBe(true);
      expect(webhooks.verify({ url, params: paramsB, signature: sigB, signingKey })).toBe(true);
    });
  });

  describe('_computeSignature', () => {
    it('produces a base64-encoded string', () => {
      const sig = Webhooks._computeSignature(url, params, signingKey);
      // base64 only contains these chars
      expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('produces consistent results for same input', () => {
      const sig1 = Webhooks._computeSignature(url, params, signingKey);
      const sig2 = Webhooks._computeSignature(url, params, signingKey);
      expect(sig1).toBe(sig2);
    });

    it('produces different results for different keys', () => {
      const sig1 = Webhooks._computeSignature(url, params, 'key1');
      const sig2 = Webhooks._computeSignature(url, params, 'key2');
      expect(sig1).not.toBe(sig2);
    });
  });
});
