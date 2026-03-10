import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClawOps } from '../src/client.js';
import { ClawOpsError } from '../src/error.js';
import { Calls } from '../src/resources/calls.js';
import { Messages } from '../src/resources/messages.js';
import { Numbers } from '../src/resources/numbers.js';
import { WebhookLogs } from '../src/resources/webhook-logs.js';
import { Webhooks } from '../src/webhooks.js';
import { AccountContext } from '../src/resources/accounts.js';

function mockFetch(): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('ClawOps client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CLAWOPS_API_KEY;
    delete process.env.CLAWOPS_ACCOUNT_ID;
    delete process.env.CLAWOPS_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('initialization', () => {
    it('creates client with apiKey and accountId', () => {
      const client = new ClawOps({
        apiKey: 'sk_test_123',
        accountId: 'AC_test_456',
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });

      expect(client).toBeInstanceOf(ClawOps);
    });

    it('throws ClawOpsError when apiKey is missing', () => {
      expect(
        () =>
          new ClawOps({
            accountId: 'AC_test',
            fetch: mockFetch(),
            baseURL: 'http://localhost:3000',
          }),
      ).toThrow(ClawOpsError);
    });

    it('throws ClawOpsError when accountId is missing', () => {
      expect(
        () =>
          new ClawOps({
            apiKey: 'sk_test',
            fetch: mockFetch(),
            baseURL: 'http://localhost:3000',
          }),
      ).toThrow(ClawOpsError);
    });

    it('throws when both apiKey and accountId are missing', () => {
      expect(
        () => new ClawOps({ fetch: mockFetch(), baseURL: 'http://localhost:3000' }),
      ).toThrow(ClawOpsError);
    });
  });

  describe('environment variable fallback', () => {
    it('reads apiKey from CLAWOPS_API_KEY env var', () => {
      process.env.CLAWOPS_API_KEY = 'sk_env_key';
      process.env.CLAWOPS_ACCOUNT_ID = 'AC_env_account';

      const client = new ClawOps({
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });
      expect(client).toBeInstanceOf(ClawOps);
    });

    it('reads accountId from CLAWOPS_ACCOUNT_ID env var', () => {
      process.env.CLAWOPS_API_KEY = 'sk_env_key';
      process.env.CLAWOPS_ACCOUNT_ID = 'AC_env_account';

      const client = new ClawOps({
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });
      expect(client).toBeInstanceOf(ClawOps);
    });

    it('options override env vars', () => {
      process.env.CLAWOPS_API_KEY = 'sk_env_key';
      process.env.CLAWOPS_ACCOUNT_ID = 'AC_env_account';

      // Should not throw because options take precedence
      const client = new ClawOps({
        apiKey: 'sk_option_key',
        accountId: 'AC_option_account',
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });
      expect(client).toBeInstanceOf(ClawOps);
    });

    it('reads baseURL from CLAWOPS_BASE_URL env var', () => {
      process.env.CLAWOPS_API_KEY = 'sk_test';
      process.env.CLAWOPS_ACCOUNT_ID = 'AC_test';
      process.env.CLAWOPS_BASE_URL = 'http://localhost:8080';

      const client = new ClawOps({ fetch: mockFetch() });
      expect(client).toBeInstanceOf(ClawOps);
    });
  });

  describe('resource getters', () => {
    let client: ClawOps;

    beforeEach(() => {
      client = new ClawOps({
        apiKey: 'sk_test',
        accountId: 'AC_test',
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });
    });

    it('calls getter returns Calls instance', () => {
      expect(client.calls).toBeInstanceOf(Calls);
    });

    it('messages getter returns Messages instance', () => {
      expect(client.messages).toBeInstanceOf(Messages);
    });

    it('numbers getter returns Numbers instance', () => {
      expect(client.numbers).toBeInstanceOf(Numbers);
    });

    it('webhookLogs getter returns WebhookLogs instance', () => {
      expect(client.webhookLogs).toBeInstanceOf(WebhookLogs);
    });

    it('webhooks getter returns Webhooks instance', () => {
      expect(client.webhooks).toBeInstanceOf(Webhooks);
    });

    it('each call to getter creates a new instance', () => {
      const calls1 = client.calls;
      const calls2 = client.calls;
      expect(calls1).not.toBe(calls2);
      expect(calls1).toBeInstanceOf(Calls);
    });
  });

  describe('accounts()', () => {
    it('returns AccountContext for the given accountId', () => {
      const client = new ClawOps({
        apiKey: 'sk_test',
        accountId: 'AC_default',
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });

      const ctx = client.accounts('AC_other');
      expect(ctx).toBeInstanceOf(AccountContext);
    });

    it('AccountContext has resource getters', () => {
      const client = new ClawOps({
        apiKey: 'sk_test',
        accountId: 'AC_default',
        fetch: mockFetch(),
        baseURL: 'http://localhost:3000',
      });

      const ctx = client.accounts('AC_other');
      expect(ctx.calls).toBeInstanceOf(Calls);
      expect(ctx.messages).toBeInstanceOf(Messages);
      expect(ctx.numbers).toBeInstanceOf(Numbers);
      expect(ctx.webhookLogs).toBeInstanceOf(WebhookLogs);
    });
  });
});
