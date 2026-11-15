import { contextBridge, ipcRenderer } from 'electron';

const channel = 'audio-source-picker';

contextBridge.exposeInMainWorld('audioSourcePicker', {
  list: () => ipcRenderer.invoke(`${channel}:list`),
  select: (sourceIds: string[]) => ipcRenderer.invoke(`${channel}:select`, sourceIds),
  all: () => ipcRenderer.invoke(`${channel}:all`),
  cancel: () => ipcRenderer.invoke(`${channel}:cancel`),
});
