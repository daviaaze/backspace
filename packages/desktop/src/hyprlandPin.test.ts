import { describe, it, expect } from 'vitest';
import { findClient, legacyDispatch, luaDispatch, parseClients, planPin, type HyprlandClient } from './hyprlandPin';

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
    expect(planPin(client(), true, false)).toEqual([
      { action: 'float', enable: true, address: '0xabc123' },
      { action: 'pin', enable: true, address: '0xabc123' },
    ]);
  });

  it('does not toggle an already pinned window back off', () => {
    expect(planPin(client({ floating: true, pinned: true }), true, false)).toEqual([]);
  });

  it('unpins and restores tiling only when this feature floated the window', () => {
    const pinned = client({ floating: true, pinned: true });
    expect(planPin(pinned, false, true)).toEqual([
      { action: 'pin', enable: false, address: '0xabc123' },
      { action: 'float', enable: false, address: '0xabc123' },
    ]);
    expect(planPin(pinned, false, false)).toEqual([{ action: 'pin', enable: false, address: '0xabc123' }]);
  });
});

describe('dispatch syntax', () => {
  it('uses explicit enable/disable in the Lua form accepted by Hyprland 0.57', () => {
    expect(luaDispatch({ action: 'pin', enable: true, address: '0xabc123' })).toEqual([
      'dispatch', "hl.dsp.window.pin({ action = 'enable', window = 'address:0xabc123' })",
    ]);
    expect(luaDispatch({ action: 'float', enable: false, address: '0xabc123' })[1]).toContain("action = 'disable'");
  });

  it('maps to hyprlang dispatchers for older compositors', () => {
    expect(legacyDispatch({ action: 'float', enable: true, address: '0xabc123' })).toEqual(['dispatch', 'setfloating', 'address:0xabc123']);
    expect(legacyDispatch({ action: 'float', enable: false, address: '0xabc123' })).toEqual(['dispatch', 'settiled', 'address:0xabc123']);
    expect(legacyDispatch({ action: 'pin', enable: true, address: '0xabc123' })).toEqual(['dispatch', 'pin', 'address:0xabc123']);
  });
});
