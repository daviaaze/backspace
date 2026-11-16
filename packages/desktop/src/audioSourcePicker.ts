import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import type { AudioSelection, AudioSource } from './systemAudio';

const CHANNEL = 'audio-source-picker';
let pending: Promise<AudioSelection | null> | null = null;
let activePicker: BrowserWindow | null = null;

/** The renderer releases its last acquisition while the native chooser is open. */
export function cancelAudioSourcePicker(): void {
  if (activePicker && !activePicker.isDestroyed()) activePicker.close();
}

export function chooseAudioSources(
  parentWindow: BrowserWindow,
  listSources: () => Array<AudioSource>,
): Promise<AudioSelection | null> {
  if (pending) {
    activePicker?.show();
    activePicker?.focus();
    return pending;
  }
  const parentBounds = parentWindow.getBounds();
  const workArea = screen.getDisplayMatching(parentBounds).workArea;
  const width = Math.min(640, workArea.width - 32);
  const height = Math.min(600, workArea.height - 32);
  const picker = new BrowserWindow({
    width,
    height,
    x: Math.round(Math.max(workArea.x, Math.min(parentBounds.x + (parentBounds.width - width) / 2, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(parentBounds.y + (parentBounds.height - height) / 2, workArea.y + workArea.height - height))),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#13131a',
    parent: parentWindow,
    modal: true,
    show: false,
    title: 'Compartilhar áudio',
    webPreferences: {
      preload: path.join(__dirname, 'audioSourcePickerPreload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  let resolveSelection!: (selection: AudioSelection | null) => void;
  const promise = new Promise<AudioSelection | null>((resolve) => { resolveSelection = resolve; });
  pending = promise;
  activePicker = picker;
  let settled = false;
  const finish = (result: AudioSelection | null) => {
    if (settled) return;
    settled = true;
    pending = null;
    activePicker = null;
    ipcMain.removeHandler(`${CHANNEL}:list`);
    ipcMain.removeHandler(`${CHANNEL}:select`);
    ipcMain.removeHandler(`${CHANNEL}:all`);
    ipcMain.removeHandler(`${CHANNEL}:cancel`);
    if (!picker.isDestroyed()) picker.close();
    resolveSelection(result);
  };
  const validSender = (event: Electron.IpcMainInvokeEvent) => event.sender === picker.webContents;

  ipcMain.handle(`${CHANNEL}:list`, (event) => {
    if (!validSender(event)) throw new Error('Invalid audio picker sender');
    return listSources();
  });
  ipcMain.handle(`${CHANNEL}:select`, (event, sourceIds: unknown) => {
    if (!validSender(event)) throw new Error('Invalid audio picker sender');
    if (!Array.isArray(sourceIds) || !sourceIds.every((id) => typeof id === 'string')) return;
    finish({ mode: 'selected', sourceIds });
  });
  ipcMain.handle(`${CHANNEL}:all`, (event) => {
    if (!validSender(event)) throw new Error('Invalid audio picker sender');
    finish({ mode: 'all' });
  });
  ipcMain.handle(`${CHANNEL}:cancel`, (event) => {
    if (!validSender(event)) throw new Error('Invalid audio picker sender');
    finish(null);
  });
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.webContents.on('will-navigate', (event, url) => {
    if (url !== `file://${path.join(__dirname, '..', 'resources', 'audio-source-picker.html')}`) event.preventDefault();
  });
  picker.on('closed', () => finish(null));
  void picker.loadFile(path.join(__dirname, '..', 'resources', 'audio-source-picker.html')).then(
    () => undefined,
    () => finish(null),
  );
  picker.once('ready-to-show', () => picker.show());
  return promise;
}
