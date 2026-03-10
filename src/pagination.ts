import { z } from 'zod';
import type { APIClient } from './base-client.js';
import { PaginationMetaSchema } from './types/shared.js';

export function PageSchema<T>(itemSchema: z.ZodType<T>) {
  return z
    .object({
      data: z.array(itemSchema),
      meta: PaginationMetaSchema,
    })
    .passthrough();
}

export class Page<T> {
  data: T[];
  meta: { total: number; page: number; pageSize: number };

  private _client: APIClient | null = null;
  private _path = '';
  private _itemSchema: z.ZodType<T> | null = null;
  private _query: Record<string, unknown> = {};

  constructor(data: T[], meta: { total: number; page: number; pageSize: number }) {
    this.data = data;
    this.meta = meta;
  }

  /** @internal */
  _setClient(
    client: APIClient,
    path: string,
    itemSchema: z.ZodType<T>,
    query: Record<string, unknown>,
  ): void {
    this._client = client;
    this._path = path;
    this._itemSchema = itemSchema;
    this._query = query;
  }

  hasNextPage(): boolean {
    return (this.meta.page + 1) * this.meta.pageSize < this.meta.total;
  }

  async nextPage(): Promise<Page<T>> {
    if (!this._client || !this._itemSchema) {
      throw new Error('Page client is not set');
    }
    if (!this.hasNextPage()) {
      throw new Error('No more pages');
    }
    const nextQuery = { ...this._query, page: this.meta.page + 1 };
    const schema = PageSchema(this._itemSchema);

    const raw = await this._client._get(this._path, {
      castTo: schema,
      query: nextQuery,
    });

    const page = new Page<T>(raw.data, raw.meta);
    page._setClient(this._client, this._path, this._itemSchema, this._query);
    return page;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.data[Symbol.iterator]();
  }

  async *autoPagingIter(): AsyncGenerator<T> {
    let page: Page<T> = this;
    while (true) {
      for (const item of page.data) {
        yield item;
      }
      if (!page.hasNextPage()) break;
      page = await page.nextPage();
    }
  }
}
