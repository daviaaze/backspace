import { describe, it, expect } from 'vitest';
import { findClient, parseClients, planPin, type HyprlandClient } from './hyprlandPin';

const client = (over: Partial<HyprlandClient> = {}): HyprlandClient => ({
  address: '0xabc123', pid: 42, class: 'io.github.TheZwiss.backspace', title: 'Stream de Ana', floating: false, pinned: false, ...over,
});

describe('findClient', () => {
  it('refuses to guess when two windows of this process share a title', () => {
    const clients = [client(), client({ address: '0xdef456' })];
    expect(findClient(clients, 42, 'io.github.TheZwiss.backspace', 'Stream de Ana')).toBeNull();
  });

  it('ignores same-titled windows of other processes or classes', () => {
    const clients = [client({ pid: 7 }), client({ address: '0xdef456', class: 'firefox' }), client({ address: '0x999' })];
    expect(findClient(clients, 42, 'io.github.TheZwiss.backspace', 'Stream de Ana')?.address).toBe('0x999');
  });
});

describe('parseClients', () => {
  it('drops malformed entries and addresses that are not hex window ids', () => {
    const parsed = parseClients([client(), { ...client(), address: '0x1; exec evil' }, { ...client(), pid: '42' }, null]);
    expect(parsed).toHaveLength(1);
  });
});

describe('planPin', () => {
  it('floats a tiled window first because pin only works on floating windows', () => {
    expect(planPin(client(), true, false)).toEqual([['setfloating', 'address:0xabc123'], ['pin', 'address:0xabc123']]);
  });

  it('does not toggle an already pinned window back off', () => {
    expect(planPin(client({ floating: true, pinned: true }), true, false)).toEqual([]);
  });

  it('unpins and restores tiling only when this feature floated the window', () => {
    const pinned = client({ floating: true, pinned: true });
    expect(planPin(pinned, false, true)).toEqual([['pin', 'address:0xabc123'], ['settiled', 'address:0xabc123']]);
    expect(planPin(pinned, false, false)).toEqual([['pin', 'address:0xabc123']]);
  });
});
