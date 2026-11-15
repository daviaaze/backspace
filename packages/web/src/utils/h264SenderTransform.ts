import { TrackEvent, type LocalTrack } from 'livekit-client';

interface ActiveTransform {
  sender: RTCRtpSender;
  worker: Worker;
  transform: RTCRtpScriptTransform;
  mediaTrack: MediaStreamTrack;
  ended: () => void;
  restarted: () => void;
}

// LiveKit clears LocalTrack.sender before emitting LocalTrackUnpublished.
// Keep ownership on the stable LocalTrack, including across camera restarts.
const active = new Map<LocalTrack, ActiveTransform>();

export function attachH264SenderTransform(
  localTrack: LocalTrack | null | undefined,
  mediaTrack: MediaStreamTrack,
  codec: 'h264' | null,
): void {
  if (!localTrack) return;
  if (codec !== 'h264') {
    detachH264SenderTransform(localTrack);
    return;
  }
  if (typeof RTCRtpScriptTransform === 'undefined' || typeof Worker === 'undefined') return;
  const sender = localTrack.sender;
  if (!sender) return;
  const existing = active.get(localTrack);
  if (existing?.sender === sender && sender.transform === existing.transform) {
    if (existing.mediaTrack !== mediaTrack) {
      existing.mediaTrack.removeEventListener('ended', existing.ended);
      existing.mediaTrack = mediaTrack;
      mediaTrack.addEventListener('ended', existing.ended, { once: true });
    }
    return;
  }
  if (existing) detachH264SenderTransform(localTrack);
  if (sender.transform) {
    console.error('[Video] H264 repair conflicts with an existing sender transform; leaving it untouched.');
    return;
  }
  const worker = new Worker(new URL('./h264BitstreamWorker.ts', import.meta.url), { type: 'module' });
  let transform: RTCRtpScriptTransform;
  try {
    transform = new RTCRtpScriptTransform(worker);
    sender.transform = transform;
  } catch (error) {
    worker.terminate();
    console.error('[Video] Could not attach H264 repair transform:', error);
    return;
  }
  const ended = () => {
    const entry = active.get(localTrack);
    if (entry && sender.track === entry.mediaTrack) detachH264SenderTransform(localTrack);
  };
  const restarted = () => {
    attachH264SenderTransform(localTrack, localTrack.mediaStreamTrack, 'h264');
  };
  active.set(localTrack, { sender, worker, transform, mediaTrack, ended, restarted });
  mediaTrack.addEventListener('ended', ended, { once: true });
  localTrack.on(TrackEvent.Restarted, restarted);
}

export function detachH264SenderTransform(localTrack: LocalTrack | null | undefined): void {
  if (!localTrack) return;
  const entry = active.get(localTrack);
  if (!entry) return;
  entry.mediaTrack.removeEventListener('ended', entry.ended);
  localTrack.off(TrackEvent.Restarted, entry.restarted);
  try {
    if (entry.sender.transform === entry.transform) entry.sender.transform = null;
  } finally {
    entry.worker.terminate();
    active.delete(localTrack);
  }
}
