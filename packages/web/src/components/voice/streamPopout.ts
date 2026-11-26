import type { Track } from 'livekit-client';

const openPopouts = new Map<string, Window>();

export interface StreamPopout {
  window: Window;
  video: HTMLVideoElement;
  close(): void;
}

export function getStreamPopoutName(streamKey: string): string {
  const encoded = encodeURIComponent(streamKey).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `backspace-popout-${encoded}`;
}
export function openStreamPopout(
  streamKey: string,
  title: string,
  track: Track | null,
  labels: { pin: string; unpin: string; close: string },
  onClosed: () => void,
): StreamPopout | null {
  const existing = openPopouts.get(streamKey);
  if (existing && !existing.closed) {
    existing.focus();
    return null;
  }
  const name = getStreamPopoutName(streamKey);
  const popup = window.open('', name, 'popup,width=960,height=540');
  if (!popup) return null;
  openPopouts.set(streamKey, popup);
  const doc = popup.document;
  doc.title = title;
  const style = doc.createElement('style');
  style.textContent = 'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0b10;color:#f2f3f5;font:14px system-ui,sans-serif}body{display:flex;flex-direction:column}.bar{height:42px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#18191c}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.controls{display:flex;gap:8px}button{border:1px solid #45464c;border-radius:6px;background:#24252a;color:inherit;padding:6px 10px;cursor:pointer}button:hover{background:#34353b}video{width:100%;height:calc(100% - 42px);object-fit:contain;background:#000}';
  doc.head.append(style);
  const bar = doc.createElement('header');
  bar.className = 'bar';
  const caption = doc.createElement('span');
  caption.className = 'title';
  caption.textContent = title;
  const controls = doc.createElement('div');
  controls.className = 'controls';
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = labels.close;
  closeButton.addEventListener('click', () => popup.close());
  controls.append(closeButton);
  const api = window.backspace;
  if (api?.setPopoutAlwaysOnTop) {
    const pinButton = doc.createElement('button');
    pinButton.type = 'button';
    pinButton.textContent = labels.pin;
    let pinned = false;
    void api.getPopoutAlwaysOnTop?.(name).then((value) => {
      if (!popup.closed) {
        pinned = value;
        pinButton.textContent = pinned ? labels.unpin : labels.pin;
      }
    }).catch(() => {});
    pinButton.addEventListener('click', () => {
      void api.setPopoutAlwaysOnTop?.(name, !pinned).then((value) => {
        pinned = value;
        pinButton.textContent = pinned ? labels.unpin : labels.pin;
      }).catch(() => {});
    });
    controls.prepend(pinButton);
  }
  bar.append(caption, controls);
  const video = doc.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Audio is delivered by the existing stream audio pipeline; duplicating the
  // attached video track here would otherwise play it twice.
  video.muted = true;
  doc.body.replaceChildren(bar, video);
  if (track) track.attach(video);
  const onWindowClosed = () => {
    if (openPopouts.get(streamKey) === popup) openPopouts.delete(streamKey);
    onClosed();
  };
  popup.addEventListener('pagehide', onWindowClosed, { once: true });
  let closedNotified = false;
  const notifyClosed = () => {
    if (closedNotified) return;
    closedNotified = true;
    if (track) track.detach(video);
    if (openPopouts.get(streamKey) === popup) openPopouts.delete(streamKey);
    onClosed();
  };
  popup.removeEventListener('pagehide', onWindowClosed);
  popup.addEventListener('pagehide', notifyClosed, { once: true });
  // Poll closed because popup.close() from the title bar or user chrome does
  // not consistently dispatch pagehide in every browser/Electron version.
  const closePoll = window.setInterval(() => {
    if (popup.closed) {
      window.clearInterval(closePoll);
      notifyClosed();
    }
  }, 300);
  const close = () => {
    window.clearInterval(closePoll);
    if (track) track.detach(video);
    notifyClosed();
    if (!popup.closed) popup.close();
    if (openPopouts.get(streamKey) === popup) openPopouts.delete(streamKey);
  };
  return { window: popup, video, close };
}
