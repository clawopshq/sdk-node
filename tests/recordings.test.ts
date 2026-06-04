import { describe, expect, it, vi } from 'vitest';

import { Recordings } from '../src/resources/recordings.js';

describe('Recordings.delete', () => {
  it('calls _delete with the recording path', async () => {
    const client = { _delete: vi.fn().mockResolvedValue(undefined) } as any;
    const res = new Recordings(client, 'ACtest');

    await res.delete('CAabc123');

    expect(client._delete).toHaveBeenCalledWith('/v1/accounts/ACtest/recordings/CAabc123', {});
  });
});
