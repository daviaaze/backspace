import { getElectronAPI } from '../platform/platform';

/**
 * System audio without Backspace's own playback, on the desktop app where
 * Chromium's loopback cannot leave it out (#358, Linux). The main process
 * routes every other app's playback into a virtual PipeWire source
 * (packages/desktop/src/systemAudio.ts); here that source is opened like a
 * microphone and its track replaces the loopback track of the share.
 */

/** How long the virtual source gets to show up in the device list after the link is made. */
const DEVICE_WAIT_MS = 3000;
const DEVICE_POLL_MS = 150;

/** Name the main process gives the virtual source (`SYSTEM_AUDIO_SOURCE_LABEL` in packages/desktop/src/systemAudio.ts). */
const SOURCE_LABEL = 'vencord-screen-share';

/** The virtual source is a capture device the app creates itself; it is not a microphone the user plugged in. */
export function isAppSystemAudioSource(device: Pick<MediaDeviceInfo, 'kind' | 'label'>): boolean {
  return device.kind === 'audioinput' && device.label.includes(SOURCE_LABEL);
}

/**
 * Whether this desktop app has the bridge the source needs. The web client
 * tells the main process so when it asks what a system-audio share carries
 * (`getSystemAudioCapability`): only a client that opens the source leaves
 * Backspace's own playback out on Linux.
 */
export function canOpenAppSystemAudioSource(): boolean {
  const api = getElectronAPI();
  return typeof api?.startSystemAudio === 'function' && typeof api.stopSystemAudio === 'function';
}

/**
 * The device list as the hot-plug handler compares it, without the virtual
 * source: that device comes and goes with a share and is no change the user
 * made. groupId and label are part of it because a change of the OS default
 * keeps every deviceId (the `default` entry included) and only relabels the
 * `default` entry, and the handler must still follow it.
 */
export function userDevicesSignature(devices: readonly MediaDeviceInfo[]): string {
  return devices
    .filter((d) => !isAppSystemAudioSource(d))
    .map((d) => JSON.stringify([d.kind, d.deviceId, d.groupId, d.label]))
    .sort()
    .join('\n');
}

type StartResult = Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof getElectronAPI>>['startSystemAudio']>>>;

/**
 * Captures that are starting or hold the source. The main process has one
 * link, shared by all of them: it is made by the first and taken down by the
 * last, so one capture stopping (the setup screen discarding a preview, a late
 * toggle capture) never removes the source another one is reading.
 */
let holders = 0;
let starting: Promise<StartResult> | null = null;

/** `null` only when this desktop has no native source; a failed/cancelled selection never widens to loopback. */
export async function acquireAppExcludedSystemAudio(signal?: AbortSignal): Promise<MediaStreamTrack | null> {
  signal?.throwIfAborted();
  const api = getElectronAPI();
  if (!api?.startSystemAudio || !api.stopSystemAudio) return null;

  holders++;
  let dropped = false;
  const drop = (unlink: boolean): void => {
    if (dropped) return;
    dropped = true;
    if (--holders > 0) return;
    starting = null;
    if (unlink) {
      void api.stopSystemAudio?.().catch((error) => {
        console.warn('[ScreenShare] Could not release the system-audio source:', error);
      });
    }
  };
  const onAbort = () => drop(true);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    starting ??= api.startSystemAudio();
    const result = await abortableCapture(starting, signal);
    if (!result.ok) {
      const unavailable = ['unsupported-platform', 'sandboxed', 'module-missing', 'no-pipewire'].includes(result.reason);
      drop(!unavailable && result.reason !== 'cancelled' && result.reason !== 'no-sources-selected');
      if (unavailable) return null;
      if (result.reason === 'cancelled') throw new DOMException('Audio selection cancelled', 'AbortError');
      throw new DOMException(
        result.reason === 'no-sources-selected' ? 'The selected audio sources are no longer available' : 'Could not link the selected audio sources',
        result.reason === 'no-sources-selected' ? 'NotFoundError' : 'NotReadableError',
      );
    }

    const deviceId = await waitForDevice(result.label, signal);
    if (!deviceId) throw new DOMException('The system-audio source did not appear', 'NotFoundError');
    signal?.throwIfAborted();
    const capture = navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    const stream = await abortableCapture(capture, signal, (late) => late.getTracks().forEach((track) => track.stop()));
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((other) => other.stop());
      throw new DOMException('The selected source returned no audio track', 'NotFoundError');
    }
    const stopTrack = track.stop.bind(track);
    const ended = () => drop(true);
    track.stop = (): void => {
      track.removeEventListener('ended', ended);
      stopTrack();
      drop(true);
    };
    track.addEventListener('ended', ended, { once: true });
    return track;
  } catch (error) {
    drop(true);
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      console.warn('[ScreenShare] Could not open the selected system-audio source:', error);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Media APIs cannot abort in-flight GUM; discard its track if it arrives after cancellation. */
function abortableCapture<T>(operation: Promise<T>, signal?: AbortSignal, discard?: (late: T) => void): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Audio acquisition cancelled', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        discard?.(value);
        abort();
      } else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function waitForDevice(label: string, signal?: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + DEVICE_WAIT_MS;
  for (;;) {
    const devices = await abortableCapture(navigator.mediaDevices.enumerateDevices(), signal);
    const found = devices.find((device) => device.kind === 'audioinput' && device.label.includes(label));
    if (found) return found.deviceId;
    if (Date.now() >= deadline) return null;
    await abortableCapture(new Promise<void>((resolve) => setTimeout(resolve, DEVICE_POLL_MS)), signal);
  }
}
