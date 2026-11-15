import { describe, it, expect, vi } from 'vitest';
import {
  SYSTEM_AUDIO_SOURCE_LABEL,
  buildExcludeNodes,
  createSystemAudioController,
  withSystemAudioSource,
  type PatchBayLike,
  type PatchBayModule,
  type SystemAudioDeps,
} from './systemAudio';

/**
 * #358: on Linux Chromium's loopback is the monitor of the whole mix, so the
 * voices Backspace plays reach the viewers. The controller routes every other
 * app's playback into a virtual source instead, and keeps Backspace's own
 * processes out of it.
 */

function fakeModule(options: { pipewire?: boolean; linkResult?: boolean; nodes?: Record<string, unknown>[] } = {}) {
  const link = vi.fn<PatchBayLike['link']>(() => options.linkResult ?? true);
  const list = vi.fn<PatchBayLike['list']>(() => options.nodes ?? []);
  const unlink = vi.fn();
  const constructed = vi.fn();
  class PatchBay implements PatchBayLike {
    constructor() {
      constructed();
    }
    list = list;
    link = link;
    unlink = unlink;
    static hasPipeWire(): boolean {
      return options.pipewire ?? true;
    }
  }
  const module: PatchBayModule = { PatchBay };
  return { module, link, list, unlink, constructed };
}

const stream = (serial: string, extra: Record<string, unknown> = {}) => ({
  'media.class': 'Stream/Output/Audio',
  'object.serial': serial,
  'object.id': '42',
  'application.name': 'Player',
  'application.process.id': '5000',
  'application.process.binary': 'player',
  'media.name': 'Music',
  'node.name': 'player-output',
  ...extra,
});

function routedSerials(nodes: Record<string, unknown>[], options: Parameters<PatchBayLike['link']>[0]): unknown[] {
  return nodes.filter((node) =>
    options.include.some((rule) => Object.entries(rule).every(([key, value]) => node[key] === value)) &&
    !options.exclude.some((rule) => Object.entries(rule).every(([key, value]) => node[key] === value)),
  ).map((node) => node['object.serial']);
}

function controller(overrides: Partial<SystemAudioDeps> = {}, nodes: Record<string, unknown>[] = []) {
  const fake = fakeModule({ nodes });
  const deps: SystemAudioDeps = {
    platform: 'linux',
    loadModule: () => fake.module,
    getPids: () => [4100, 4101, 4102],
    executablePath: '/opt/Backspace/backspace',
    ...overrides,
  };
  return { ...fake, ctl: createSystemAudioController(deps) };
}


describe('buildExcludeNodes', () => {
  it('lists every pid of the app and its binary name', () => {
    expect(buildExcludeNodes([10, 11], '/opt/Backspace/backspace')).toEqual([
      { 'application.process.id': '10' },
      { 'application.process.id': '11' },
      { 'application.process.binary': 'backspace' },
    ]);
  });

  it('drops duplicates and values that are not pids', () => {
    expect(buildExcludeNodes([10, 10, 0, -3, 1.5, Number.NaN], '/x/app')).toEqual([
      { 'application.process.id': '10' },
      { 'application.process.binary': 'app' },
    ]);
  });

  it('reads the binary name from a Windows-style path and omits it when there is none', () => {
    expect(buildExcludeNodes([], 'C:\\Program Files\\Backspace\\Backspace.exe')).toEqual([
      { 'application.process.binary': 'Backspace.exe' },
    ]);
    expect(buildExcludeNodes([7], '')).toEqual([{ 'application.process.id': '7' }]);
  });
});

describe('createSystemAudioController', () => {
  it('lists only sanitized, stable playback stream sources and excludes this app', () => {
    const { ctl } = controller({}, [
      stream('stable-1', { 'media.name': '  Song\n title  ', 'application.name': '  Music\tApp ' }),
      stream('own-pid', { 'application.process.id': '4101' }),
      stream('own-binary', { 'application.process.binary': 'BACKSPACE' }),
      stream('device', { 'media.class': 'Audio/Sink' }),
      stream('no-serial', { 'object.serial': undefined, 'object.id': '42' }),
    ]);
    expect(ctl.listSources()).toEqual([{ id: 'stable-1', name: 'Song title', application: 'Music App', pid: '5000' }]);
  });

  it('routes playback rather than hardware inputs and keeps this app out of the mix', () => {
    const nodes = [
      stream('music'),
      stream('own', { 'application.process.id': '4101' }),
      stream('microphone', { 'media.class': 'Audio/Source' }),
    ];
    const { ctl, link } = controller({}, nodes);
    expect(ctl.start()).toEqual({ ok: true, label: SYSTEM_AUDIO_SOURCE_LABEL });
    expect(routedSerials(nodes, link.mock.calls[0]![0])).toEqual(['music']);
  });

  it('selected capture uses immutable serial and refuses vanished or reused object IDs', () => {
    const native = fakeModule({ nodes: [stream('serial-a')] });
    const ctl = createSystemAudioController({
      platform: 'linux', loadModule: () => native.module, getPids: () => [],
      executablePath: '/x/backspace',
    });
    expect(ctl.start({ mode: 'selected', sourceIds: ['serial-a'] }).ok).toBe(true);
    expect(routedSerials([stream('serial-a'), stream('other')], native.link.mock.calls[0]![0])).toEqual(['serial-a']);
    native.list.mockReturnValue([stream('serial-b')]);
    expect(ctl.start({ mode: 'selected', sourceIds: ['serial-a'] })).toEqual({
      ok: false, reason: 'no-sources-selected',
    });
    expect(native.link).toHaveBeenCalledTimes(1);
  });
  it('fails closed for an empty selected list even when streams exist', () => {
    const { ctl, link } = controller({}, [stream('available')]);
    expect(ctl.start({ mode: 'selected', sourceIds: [] })).toEqual({
      ok: false, reason: 'no-sources-selected',
    });
    expect(link).not.toHaveBeenCalled();
  });

  it('returns an empty list and link-failed when native listing or linking throws', () => {
    const listing = fakeModule();
    listing.list.mockImplementation(() => { throw new Error('gone'); });
    const listingController = createSystemAudioController({
      platform: 'linux', loadModule: () => listing.module, getPids: () => [],
      executablePath: '/x/app', log: () => undefined,
    });
    expect(listingController.listSources()).toEqual([]);
    expect(listingController.start()).toEqual({ ok: false, reason: 'link-failed' });
  });

  it('is unavailable off Linux without loading the module', () => {
    const loadModule = vi.fn();
    const { ctl } = controller({ platform: 'win32', loadModule });
    expect(ctl.isAvailable()).toBe(false);
    expect(ctl.start()).toEqual({ ok: false, reason: 'unsupported-platform' });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('reports a missing module once and keeps working without it', () => {
    const log = vi.fn();
    const loadModule = vi.fn(() => {
      throw new Error('Cannot find module');
    });
    const { ctl } = controller({ loadModule, log });
    expect(ctl.start()).toEqual({ ok: false, reason: 'module-missing' });
    expect(ctl.isAvailable()).toBe(false);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(() => ctl.stop()).not.toThrow();
  });

  it('is unavailable in a sandbox, without loading the module', () => {
    const loadModule = vi.fn();
    const { ctl } = controller({ loadModule, isSandboxed: () => true });
    expect(ctl.isAvailable()).toBe(false);
    expect(ctl.start()).toEqual({ ok: false, reason: 'sandboxed' });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('is unavailable on a PulseAudio-only system', () => {
    const fake = fakeModule({ pipewire: false });
    const ctl = createSystemAudioController({
      platform: 'linux',
      loadModule: () => fake.module,
      getPids: () => [1],
      executablePath: '/x/app',
    });
    expect(ctl.isAvailable()).toBe(false);
    expect(ctl.start()).toEqual({ ok: false, reason: 'no-pipewire' });
    expect(fake.link).not.toHaveBeenCalled();
  });

  it('treats a failing PipeWire probe as no PipeWire', () => {
    const module: PatchBayModule = {
      PatchBay: class {
        list(): Record<string, unknown>[] { return []; }
        link(): boolean {
          return true;
        }
        unlink(): void {}
        static hasPipeWire(): boolean {
          throw new Error('probe failed');
        }
      },
    };
    const ctl = createSystemAudioController({
      platform: 'linux',
      loadModule: () => module,
      getPids: () => [1],
      executablePath: '/x/app',
      log: () => undefined,
    });
    expect(ctl.start()).toEqual({ ok: false, reason: 'no-pipewire' });
  });

  it('reports a link that venmic refuses, or that throws', () => {
    const refused = fakeModule({ linkResult: false });
    const ctlRefused = createSystemAudioController({
      platform: 'linux',
      loadModule: () => refused.module,
      getPids: () => [1],
      executablePath: '/x/app',
    });
    expect(ctlRefused.start()).toEqual({ ok: false, reason: 'link-failed' });
    ctlRefused.stop();
    expect(refused.unlink).not.toHaveBeenCalled();

    const thrown = fakeModule();
    thrown.link.mockImplementation(() => {
      throw new Error('pipewire gone');
    });
    const ctlThrown = createSystemAudioController({
      platform: 'linux',
      loadModule: () => thrown.module,
      getPids: () => [1],
      executablePath: '/x/app',
      log: () => undefined,
    });
    expect(ctlThrown.start()).toEqual({ ok: false, reason: 'link-failed' });
  });

  it('unlinks once on stop and not at all when nothing was linked', () => {
    const { ctl, unlink } = controller();
    ctl.stop();
    expect(unlink).not.toHaveBeenCalled();
    ctl.start();
    ctl.stop();
    ctl.stop();
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('reuses one PatchBay and relinks with the pids of the moment', () => {
    let pids = [10];
    const { ctl, link, constructed } = controller({ getPids: () => pids });
    ctl.start();
    pids = [10, 20];
    ctl.start();
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledTimes(2);
    expect(link.mock.calls[1]![0].exclude).toContainEqual({ 'application.process.id': '20' });
  });

  it('survives an unlink that throws', () => {
    const { ctl, unlink } = controller({ log: () => undefined });
    ctl.start();
    unlink.mockImplementation(() => {
      throw new Error('already gone');
    });
    expect(() => ctl.stop()).not.toThrow();
  });
});

describe('withSystemAudioSource', () => {
  it('says the app is left out when the client uses the source and it can be built', () => {
    expect(withSystemAudioSource('included', true, () => true)).toBe('excluded');
    expect(withSystemAudioSource('included', true, () => false)).toBe('included');
    expect(withSystemAudioSource('unavailable', true, () => false)).toBe('unavailable');
  });

  it('gives a client that does not use the source the OS verdict, without probing for it', () => {
    // A web client from before the source keeps Chromium's loopback, which carries the app.
    const available = vi.fn(() => true);
    expect(withSystemAudioSource('included', undefined, available)).toBe('included');
    expect(withSystemAudioSource('included', false, available)).toBe('included');
    expect(withSystemAudioSource('included', 'true', available)).toBe('included');
    expect(available).not.toHaveBeenCalled();
  });
});
