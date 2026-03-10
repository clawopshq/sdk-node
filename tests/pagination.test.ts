import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Page, PageSchema } from '../src/pagination.js';
import { APIClient } from '../src/base-client.js';

const ItemSchema = z.object({ id: z.string(), name: z.string() });
type Item = z.infer<typeof ItemSchema>;

function createMockClient(pages: Array<{ data: Item[]; meta: { total: number; page: number; pageSize: number } }>): APIClient {
  let callCount = 0;

  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
    const pageData = pages[callCount] ?? pages[pages.length - 1];
    callCount++;
    return new Response(JSON.stringify(pageData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return new APIClient({
    apiKey: 'sk_test',
    baseURL: 'http://localhost:3000',
    fetch: fetchFn,
    maxRetries: 0,
  });
}

describe('Page', () => {
  describe('hasNextPage', () => {
    it('returns true when there are more pages', () => {
      const page = new Page<Item>(
        [{ id: '1', name: 'a' }, { id: '2', name: 'b' }],
        { total: 10, page: 0, pageSize: 2 },
      );
      expect(page.hasNextPage()).toBe(true);
    });

    it('returns false on the last page', () => {
      const page = new Page<Item>(
        [{ id: '1', name: 'a' }],
        { total: 3, page: 1, pageSize: 2 },
      );
      // (1 + 1) * 2 = 4 >= 3
      expect(page.hasNextPage()).toBe(false);
    });

    it('returns false when exactly at the boundary', () => {
      const page = new Page<Item>(
        [{ id: '1', name: 'a' }, { id: '2', name: 'b' }],
        { total: 4, page: 1, pageSize: 2 },
      );
      // (1 + 1) * 2 = 4, 4 < 4 is false
      expect(page.hasNextPage()).toBe(false);
    });

    it('returns true when on first page with many items', () => {
      const page = new Page<Item>(
        [{ id: '1', name: 'a' }],
        { total: 100, page: 0, pageSize: 10 },
      );
      expect(page.hasNextPage()).toBe(true);
    });

    it('returns false when total is 0', () => {
      const page = new Page<Item>([], { total: 0, page: 0, pageSize: 10 });
      expect(page.hasNextPage()).toBe(false);
    });
  });

  describe('iterator', () => {
    it('iterates over data items with for...of', () => {
      const items: Item[] = [
        { id: '1', name: 'a' },
        { id: '2', name: 'b' },
        { id: '3', name: 'c' },
      ];
      const page = new Page<Item>(items, { total: 3, page: 0, pageSize: 10 });

      const collected: Item[] = [];
      for (const item of page) {
        collected.push(item);
      }
      expect(collected).toEqual(items);
    });

    it('spread operator works', () => {
      const items: Item[] = [{ id: '1', name: 'a' }];
      const page = new Page<Item>(items, { total: 1, page: 0, pageSize: 10 });
      expect([...page]).toEqual(items);
    });
  });

  describe('nextPage', () => {
    it('throws when client is not set', async () => {
      const page = new Page<Item>(
        [{ id: '1', name: 'a' }],
        { total: 10, page: 0, pageSize: 1 },
      );
      await expect(page.nextPage()).rejects.toThrow('Page client is not set');
    });

    it('throws when there are no more pages', async () => {
      const client = createMockClient([]);
      const page = new Page<Item>(
        [{ id: '1', name: 'a' }],
        { total: 1, page: 0, pageSize: 10 },
      );
      page._setClient(client, '/items', ItemSchema, {});

      await expect(page.nextPage()).rejects.toThrow('No more pages');
    });

    it('fetches the next page correctly', async () => {
      const page2Data = {
        data: [{ id: '3', name: 'c' }, { id: '4', name: 'd' }],
        meta: { total: 4, page: 1, pageSize: 2 },
      };
      const client = createMockClient([page2Data]);

      const page1 = new Page<Item>(
        [{ id: '1', name: 'a' }, { id: '2', name: 'b' }],
        { total: 4, page: 0, pageSize: 2 },
      );
      page1._setClient(client, '/items', ItemSchema, {});

      const page2 = await page1.nextPage();
      expect(page2.data).toEqual(page2Data.data);
      expect(page2.meta.page).toBe(1);
      expect(page2.hasNextPage()).toBe(false);
    });
  });

  describe('autoPagingIter', () => {
    it('iterates across multiple pages', async () => {
      const page2Data = {
        data: [{ id: '3', name: 'c' }],
        meta: { total: 3, page: 1, pageSize: 2 },
      };
      const client = createMockClient([page2Data]);

      const page1 = new Page<Item>(
        [{ id: '1', name: 'a' }, { id: '2', name: 'b' }],
        { total: 3, page: 0, pageSize: 2 },
      );
      page1._setClient(client, '/items', ItemSchema, {});

      const allItems: Item[] = [];
      for await (const item of page1.autoPagingIter()) {
        allItems.push(item);
      }

      expect(allItems).toHaveLength(3);
      expect(allItems[0].id).toBe('1');
      expect(allItems[1].id).toBe('2');
      expect(allItems[2].id).toBe('3');
    });

    it('works with a single page', async () => {
      const page = new Page<Item>(
        [{ id: '1', name: 'only' }],
        { total: 1, page: 0, pageSize: 10 },
      );
      // No client needed since there is no next page
      page._setClient(createMockClient([]), '/items', ItemSchema, {});

      const allItems: Item[] = [];
      for await (const item of page.autoPagingIter()) {
        allItems.push(item);
      }

      expect(allItems).toHaveLength(1);
      expect(allItems[0].id).toBe('1');
    });

    it('works with empty first page', async () => {
      const page = new Page<Item>([], { total: 0, page: 0, pageSize: 10 });
      page._setClient(createMockClient([]), '/items', ItemSchema, {});

      const allItems: Item[] = [];
      for await (const item of page.autoPagingIter()) {
        allItems.push(item);
      }

      expect(allItems).toHaveLength(0);
    });

    it('iterates across three pages', async () => {
      const page2Data = {
        data: [{ id: '3', name: 'c' }, { id: '4', name: 'd' }],
        meta: { total: 5, page: 1, pageSize: 2 },
      };
      const page3Data = {
        data: [{ id: '5', name: 'e' }],
        meta: { total: 5, page: 2, pageSize: 2 },
      };
      const client = createMockClient([page2Data, page3Data]);

      const page1 = new Page<Item>(
        [{ id: '1', name: 'a' }, { id: '2', name: 'b' }],
        { total: 5, page: 0, pageSize: 2 },
      );
      page1._setClient(client, '/items', ItemSchema, {});

      const allItems: Item[] = [];
      for await (const item of page1.autoPagingIter()) {
        allItems.push(item);
      }

      expect(allItems).toHaveLength(5);
      expect(allItems.map((i) => i.id)).toEqual(['1', '2', '3', '4', '5']);
    });
  });

  describe('PageSchema', () => {
    it('validates correct page response', () => {
      const schema = PageSchema(ItemSchema);
      const result = schema.parse({
        data: [{ id: '1', name: 'test' }],
        meta: { total: 1, page: 0, pageSize: 10 },
      });
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('allows extra fields via passthrough', () => {
      const schema = PageSchema(ItemSchema);
      const result = schema.parse({
        data: [],
        meta: { total: 0, page: 0, pageSize: 10 },
        extra: 'field',
      });
      expect((result as Record<string, unknown>).extra).toBe('field');
    });

    it('rejects invalid data', () => {
      const schema = PageSchema(ItemSchema);
      expect(() =>
        schema.parse({
          data: [{ id: 123 }], // id should be string
          meta: { total: 1, page: 0, pageSize: 10 },
        }),
      ).toThrow();
    });
  });
});
