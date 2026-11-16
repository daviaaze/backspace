import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  startSystemAudio: vi.fn(),
  stopSystemAudio: vi.fn(),
}));
const platform = vi.hoisted(() => ({ getElectronAPI: vi.fn() }));
vi.mock('../platform/platform', () => platform);

import { isAppSystemAudioSource, userDevicesSignature } from './systemAudioSource';

// The module keeps the shared-link count between calls; each test gets a fresh copy.
let acquireAppExcludedSystemAudio: typeof import('./systemAudioSource').acquireAppExcludedSystemAudio;

/**
 * #358: on the Linux desktop app the system audio of a share is the virtual
 * source the main process builds without Backspace's own playback. The track
 * must come from that source and take it down again when it stops.
 */

function fakeTrack() {
  const listeners = new Map<string, () => void>();
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    }),
  };
  return { track: track as unknown as MediaStreamTrack, raw: track, listeners };
}

function stubMedia(devices: Array<Partial<MediaDeviceInfo>>, track: MediaStreamTrack | undefined) {
  const getUserMedia = vi.fn(async () => ({
    getAudioTracks: () => (track ? [track] : []),
    getTracks: () => (track ? [track] : []),
  }));
  const enumerateDevices = vi.fn(async () => devices as MediaDeviceInfo[]);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });
  return { getUserMedia, enumerateDevices };
}

beforeEach(async () => {
  vi.resetModules();
  ({ acquireAppExcludedSystemAudio } = await import('./systemAudioSource'));
  api.startSystemAudio.mockReset();
  api.stopSystemAudio.mockReset().mockResolvedValue(undefined);
  platform.getElectronAPI.mockReset().mockReturnValue(api);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('acquireAppExcludedSystemAudio', () => {
  it('returns null in a browser and on a desktop app without the bridge', async () => {
    platform.getElectronAPI.mockReturnValue(undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    platform.getElectronAPI.mockReturnValue({});
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
  });

  it('returns null, and opens nothing, when the main process has no source', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: false, reason: 'no-pipewire' });
    const media = stubMedia([], undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
  });

  it('surfaces a start failure instead of broadening capture to loopback', async () => {
    api.startSystemAudio.mockRejectedValue(new Error('ipc'));
    await expect(acquireAppExcludedSystemAudio()).rejects.toThrow('ipc');
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('opens the virtual source by its device id, without voice processing', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const { track } = fakeTrack();
    const media = stubMedia(
      [
        { kind: 'audioinput', label: 'Default', deviceId: 'default' },
        { kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'virt-1' },
      ],
      track,
    );
    expect(await acquireAppExcludedSystemAudio()).toBe(track);
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'virt-1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
  });

  it('takes the source down when the track stops or ends', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const stopped = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], stopped.track);
    const originalStop = stopped.raw.stop;
    const track = await acquireAppExcludedSystemAudio();
    track!.stop();
    expect(originalStop).toHaveBeenCalledTimes(1);
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);

    api.stopSystemAudio.mockClear();
    const ended = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], ended.track);
    await acquireAppExcludedSystemAudio();
    ended.listeners.get('ended')!();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('waits for a source that shows up late', async () => {
    vi.useFakeTimers();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const { track } = fakeTrack();
    const media = stubMedia([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }], track);
    media.enumerateDevices
      .mockResolvedValueOnce([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }] as MediaDeviceInfo[])
      .mockResolvedValueOnce([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'late' }] as MediaDeviceInfo[]);
    const pending = acquireAppExcludedSystemAudio();
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toBe(track);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('gives up, and unlinks, when the source never appears', async () => {
    vi.useFakeTimers();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }], undefined);
    const rejected = expect(acquireAppExcludedSystemAudio()).rejects.toMatchObject({ name: 'NotFoundError' });
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('unlinks when the device cannot be opened', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], undefined);
    media.getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    await expect(acquireAppExcludedSystemAudio()).rejects.toMatchObject({ name: 'NotReadableError' });
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('unlinks when the opened stream has no audio track', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], undefined);
    await expect(acquireAppExcludedSystemAudio()).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('shares one link between overlapping captures and unlinks with the last one', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const first = fakeTrack();
    const second = fakeTrack();
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], first.track);
    const a = await acquireAppExcludedSystemAudio();
    media.getUserMedia.mockResolvedValue({ getAudioTracks: () => [second.track], getTracks: () => [second.track] });
    const b = await acquireAppExcludedSystemAudio();
    expect(api.startSystemAudio).toHaveBeenCalledTimes(1);

    a!.stop();
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
    a!.stop(); // stopping twice is still one release
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
    b!.stop();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('links again for a capture that starts after the last one ended', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const first = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], first.track);
    (await acquireAppExcludedSystemAudio())!.stop();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
    await acquireAppExcludedSystemAudio();
    expect(api.startSystemAudio).toHaveBeenCalledTimes(2);
  });

  it('starts once for two captures that begin together', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const first = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], first.track);
    await Promise.all([acquireAppExcludedSystemAudio(), acquireAppExcludedSystemAudio()]);
    expect(api.startSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('allows the user more than ten seconds to finish choosing audio sources', async () => {
    vi.useFakeTimers();
    let choose!: (result: { ok: true; label: string }) => void;
    api.startSystemAudio.mockReturnValue(new Promise((resolve) => { choose = resolve; }));
    const { track } = fakeTrack();
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'native' }], track);
    const pending = acquireAppExcludedSystemAudio();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    choose({ ok: true, label: 'vencord-screen-share' });
    expect(await pending).toBe(track);
    track.stop();
  });

  it('aborts a chooser that never replies and does not capture after a late reply', async () => {
    let choose!: (result: { ok: true; label: string }) => void;
    api.startSystemAudio.mockReturnValue(new Promise((resolve) => { choose = resolve; }));
    const media = stubMedia([], undefined);
    const controller = new AbortController();
    const rejected = expect(acquireAppExcludedSystemAudio(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
    choose({ ok: true, label: 'vencord-screen-share' });
    await Promise.resolve();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
  it('does not start IPC when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const media = stubMedia([], undefined);
    await expect(acquireAppExcludedSystemAudio(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.startSystemAudio).not.toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it('stops tracks from a GUM promise that resolves after abort', async () => {
    let finishCapture!: (stream: { getAudioTracks: () => MediaStreamTrack[]; getTracks: () => MediaStreamTrack[] }) => void;
    let gumEntered!: () => void;
    const enteredGum = new Promise<void>((resolve) => { gumEntered = resolve; });
    const { track } = fakeTrack();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'native' }], track);
    media.getUserMedia.mockImplementation(() => {
      gumEntered();
      return new Promise((resolve) => { finishCapture = resolve; });
    });
    const controller = new AbortController();
    const acquisition = acquireAppExcludedSystemAudio(controller.signal);
    const rejected = expect(acquisition).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await enteredGum;
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);
      controller.abort();
      await rejected;
      expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
      finishCapture({ getAudioTracks: () => [track], getTracks: () => [track] });
      await Promise.resolve();
      expect(track.stop).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await rejected;
    }
  });


  it('does not cancel another holder when only one overlapping acquisition is aborted', async () => {
    let choose!: (result: { ok: true; label: string }) => void;
    api.startSystemAudio.mockReturnValue(new Promise((resolve) => { choose = resolve; }));
    const { track } = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'native' }], track);
    const controller = new AbortController();
    const first = expect(acquireAppExcludedSystemAudio(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const second = acquireAppExcludedSystemAudio();
    controller.abort();
    await first;
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
    choose({ ok: true, label: 'vencord-screen-share' });
    expect(await second).toBe(track);
    track.stop();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('surfaces a cancelled selection without opening a default input or loopback', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: false, reason: 'cancelled' });
    const media = stubMedia([], undefined);
    await expect(acquireAppExcludedSystemAudio()).rejects.toMatchObject({ name: 'AbortError' });
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('isAppSystemAudioSource', () => {
  it('recognises the virtual source and nothing else', () => {
    expect(isAppSystemAudioSource({ kind: 'audioinput', label: 'vencord-screen-share' })).toBe(true);
    expect(isAppSystemAudioSource({ kind: 'audioinput', label: 'Built-in Audio Analog Stereo' })).toBe(false);
    expect(isAppSystemAudioSource({ kind: 'audiooutput', label: 'vencord-screen-share' })).toBe(false);
  });
});

describe('userDevicesSignature', () => {
  const mic = { kind: 'audioinput', deviceId: 'mic-1', groupId: 'g1', label: 'USB Mic' } as MediaDeviceInfo;
  const def = { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - USB Mic' } as MediaDeviceInfo;
  const source = {
    kind: 'audioinput', deviceId: 'vs-1', groupId: 'g9', label: 'vencord-screen-share',
  } as MediaDeviceInfo;

  it('does not change when only the share source appears or goes', () => {
    expect(userDevicesSignature([def, mic, source])).toBe(userDevicesSignature([def, mic]));
  });

  it('does not depend on the order of the list', () => {
    expect(userDevicesSignature([mic, def])).toBe(userDevicesSignature([def, mic]));
  });

  it('changes when a device is added or removed', () => {
    const headset = { kind: 'audioinput', deviceId: 'hs-1', groupId: 'g2', label: 'Headset' } as MediaDeviceInfo;
    expect(userDevicesSignature([def, mic, headset])).not.toBe(userDevicesSignature([def, mic]));
  });

  it('changes when the OS default moves to another device, though no deviceId changes', () => {
    // Chromium keeps the `default` entry's id and relabels it; the handler re-acquires on this.
    const movedDefault = { ...def, groupId: 'g2', label: 'Default - Headset' } as MediaDeviceInfo;
    const headset = { kind: 'audioinput', deviceId: 'hs-1', groupId: 'g2', label: 'Headset' } as MediaDeviceInfo;
    expect(userDevicesSignature([movedDefault, mic, headset])).not.toBe(userDevicesSignature([def, mic, headset]));
  });
});
