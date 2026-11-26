/**
 * Playback stream selection is built from PipeWire's current node metadata.
 *
 * Chromium can leave the app out of a loopback capture only on Windows 11 and
 * macOS 14.2+ (docs/systems/voice.md, "System Audio Loopback"). On Linux the
 * capture is the monitor of the whole mix, so the voices Backspace plays come
 * back to the viewers. Here the capture is built from the other side: PipeWire
 * is asked (through `@vencord/venmic`, the module Vesktop uses) to route every
 * playback stream except Backspace's own into a virtual source, and the web
 * client opens that source like a microphone.
 *
 * This file only decides what to exclude and drives the link; the PipeWire
 * work is venmic's. The module is an optional dependency that exists on Linux
 * only, so it is loaded lazily and everything here degrades to "unavailable".
 */

/** Name venmic gives the virtual source; the web client finds the device by it. */
export const SYSTEM_AUDIO_SOURCE_LABEL = 'vencord-screen-share';

/** A PipeWire node's properties, matched by exact string equality. */
export type NodeMatch = Record<string, string>;

/** The part of `@vencord/venmic`'s `PatchBay` used here. */
export type PipeWireNode = Record<string, unknown>;
export interface PatchBayLike {
  list(): PipeWireNode[];
  link(data: { include: NodeMatch[]; exclude: NodeMatch[]; only_speakers: boolean; only_default_speakers: boolean; ignore_devices: boolean; mute: boolean }): boolean;
  unlink(): void;
}
export interface AudioSource {
  id: string;
  name: string;
  application: string;
  pid?: string;
}

export type AudioSelection = { mode: 'all' } | { mode: 'selected'; sourceIds: string[] };

const PLAYBACK_CLASS = 'Stream/Output/Audio';

function cleanDisplay(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function playbackNodes(nodes: PipeWireNode[], pids: readonly number[], executablePath: string): AudioSource[] {
  const excludedPids = new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0).map(String));
  const binary = baseName(executablePath).toLowerCase();
  const sources: AudioSource[] = [];
  for (const node of nodes) {
    if (node['media.class'] !== PLAYBACK_CLASS) continue;
    const id = cleanDisplay(node['object.serial']);
    if (!id) continue;
    const pid = cleanDisplay(node['application.process.id']);
    const processBinary = cleanDisplay(node['application.process.binary']).toLowerCase();
    if ((pid && excludedPids.has(pid)) || (binary && processBinary === binary)) continue;
    const name = cleanDisplay(node['media.name']) || cleanDisplay(node['node.name']);
    const application = cleanDisplay(node['application.name']);
    if (name && application) sources.push({ id, name, application, ...(pid ? { pid } : {}) });
  }
  return sources;
}


 
export interface PatchBayModule {
  PatchBay: (new () => PatchBayLike) & { hasPipeWire(): boolean };
}

export type SystemAudioStart =
  | { ok: true; label: string }
  | { ok: false; reason: 'unsupported-platform' | 'sandboxed' | 'module-missing' | 'no-pipewire' | 'link-failed' | 'no-sources-selected' };

export interface SystemAudioController {
  /** Whether `start` can work on this machine (platform, module, PipeWire). The module load is cached, the probe is not: PipeWire may come up later. */
  isAvailable(): boolean;
  listSources(): AudioSource[];
  start(selection?: AudioSelection): SystemAudioStart;
  stop(): void;
}

export interface SystemAudioDeps {
  platform: NodeJS.Platform;
  loadModule: () => PatchBayModule;
  /** Pids of every process of this Electron app (`app.getAppMetrics()`). */
  getPids: () => number[];
  /** `process.execPath`: the binary every Electron process of the app runs. */
  executablePath: string;
  /**
   * True where the app runs in a sandbox (Flatpak) whose PipeWire access has not been
   * checked against venmic: the Chromium loopback stays in use there.
   */
  isSandboxed?: () => boolean;
  log?: (message: string, ...args: unknown[]) => void;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * What to keep out of the virtual source. Matches are OR'd between entries and
 * AND'd inside one. The playback stream belongs to Chromium's audio-service
 * process, so each of the app's pids is listed; the binary name is added as
 * well because a sandboxed process can report a pid from its own namespace,
 * which no list of host pids would match.
 */
export function buildExcludeNodes(pids: readonly number[], executablePath: string): NodeMatch[] {
  const nodes: NodeMatch[] = [...new Set(pids)]
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => ({ 'application.process.id': String(pid) }));
  const binary = baseName(executablePath);
  if (binary) nodes.push({ 'application.process.binary': binary });
  return nodes;
}

export function createSystemAudioController(deps: SystemAudioDeps): SystemAudioController {
  const log = deps.log ?? (() => undefined);
  let module: PatchBayModule | null | undefined;
  let bay: PatchBayLike | null = null;
  let linked = false;

  function load(): PatchBayModule | null {
    if (module !== undefined) return module;
    if (deps.platform !== 'linux') return (module = null);
    try {
      module = deps.loadModule();
    } catch (err) {
      log('venmic could not be loaded:', err);
      module = null;
    }
    return module;
  }

  function reason(): Extract<SystemAudioStart, { ok: false }>['reason'] | null {
    if (deps.platform !== 'linux') return 'unsupported-platform';
    if (deps.isSandboxed?.()) return 'sandboxed';
    const loaded = load();
    if (!loaded) return 'module-missing';
    try {
      if (!loaded.PatchBay.hasPipeWire()) return 'no-pipewire';
    } catch (err) {
      log('PipeWire probe failed:', err);
      return 'no-pipewire';
    }
    return null;
  }

  return {
    isAvailable: () => reason() === null,

    listSources(): AudioSource[] {
      if (reason() !== null) return [];
      try {
        bay ??= new (module as PatchBayModule).PatchBay();
        return playbackNodes(bay.list(), deps.getPids(), deps.executablePath);
      } catch (err) {
        log('venmic source listing failed:', err);
        return [];
      }
    },

    start(selection: AudioSelection = { mode: 'all' }): SystemAudioStart {
      const unavailable = reason();
      if (unavailable) return { ok: false, reason: unavailable };
      try {
        bay ??= new (module as PatchBayModule).PatchBay();
        const current = playbackNodes(bay.list(), deps.getPids(), deps.executablePath);
        const eligible = selection.mode === 'selected'
          ? current.filter((source) => selection.sourceIds.includes(source.id))
          : current;
        if (selection.mode === 'selected' && eligible.length === 0) {
          if (linked) bay.unlink();
          linked = false;
          return { ok: false, reason: 'no-sources-selected' };
        }
        const rules: NodeMatch[] = selection.mode === 'selected'
          ? eligible.map((source) => ({ 'object.serial': source.id, 'media.class': PLAYBACK_CLASS }))
          : [{ 'media.class': PLAYBACK_CLASS }];
        const ok = bay.link({
          include: rules,
          exclude: buildExcludeNodes(deps.getPids(), deps.executablePath),
          only_speakers: false,
          only_default_speakers: false,
          ignore_devices: true,
          mute: false,
        });
        linked = ok;
        if (!ok) return { ok: false, reason: 'link-failed' };
        return { ok: true, label: SYSTEM_AUDIO_SOURCE_LABEL };
      } catch (err) {
        log('venmic link failed:', err);
        linked = false;
        return { ok: false, reason: 'link-failed' };
      }
    },

    stop(): void {
      if (!bay || !linked) return;
      linked = false;
      try {
        bay.unlink();
      } catch (err) {
        log('venmic unlink failed:', err);
      }
    },
  };
}

/**
 * `ownAudioInSystemAudio()` describes what Chromium's loopback does. A web
 * client that opens the source this module builds says so when it asks
 * (`clientUsesSource`), and for it Backspace's own playback is left out
 * whatever the OS table says. A web client from before the source never opens
 * it and keeps the loopback, so it gets the OS verdict, and the module is not
 * loaded for it. Only `true` counts: the argument comes from the renderer.
 */
export function withSystemAudioSource<T extends string>(
  base: T,
  clientUsesSource: unknown,
  sourceAvailable: () => boolean,
): T | 'excluded' {
  return clientUsesSource === true && sourceAvailable() ? 'excluded' : base;
}
