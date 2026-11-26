import { execFile } from 'child_process';

/**
 * Wayland has no always-on-top request, so Electron's setAlwaysOnTop is a no-op
 * there. Hyprland offers the equivalent per window ("pin": a floating window
 * shown on every workspace and above tiled windows), reachable through hyprctl.
 */
export interface HyprlandClient {
  address: string;
  pid: number;
  class: string;
  title: string;
  floating: boolean;
  pinned: boolean;
}

const ADDRESS = /^0x[0-9a-f]+$/;

export function parseClients(value: unknown): HyprlandClient[] {
  if (!Array.isArray(value)) return [];
  const clients: HyprlandClient[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (
      typeof c.address === 'string' && ADDRESS.test(c.address)
      && typeof c.pid === 'number'
      && typeof c.class === 'string'
      && typeof c.title === 'string'
      && typeof c.floating === 'boolean'
      && typeof c.pinned === 'boolean'
    ) {
      clients.push({ address: c.address, pid: c.pid, class: c.class, title: c.title, floating: c.floating, pinned: c.pinned });
    }
  }
  return clients;
}

/** The one window this process owns with this class and title; ambiguity means "don't touch anything". */
export function findClient(clients: readonly HyprlandClient[], pid: number, windowClass: string, title: string): HyprlandClient | null {
  const matches = clients.filter((c) => c.pid === pid && c.class === windowClass && c.title === title);
  return matches.length === 1 ? matches[0]! : null;
}

export interface PinStep {
  action: 'float' | 'pin';
  enable: boolean;
  address: string;
}

/** What it takes to get the window to `pinned`. `pin` needs a floating window, and legacy `pin` only toggles, so steps are emitted only on a state change. */
export function planPin(client: HyprlandClient, pinned: boolean, restoreTiling: boolean): PinStep[] {
  const steps: PinStep[] = [];
  if (pinned) {
    if (!client.floating) steps.push({ action: 'float', enable: true, address: client.address });
    if (!client.pinned) steps.push({ action: 'pin', enable: true, address: client.address });
  } else {
    if (client.pinned) steps.push({ action: 'pin', enable: false, address: client.address });
    if (restoreTiling && client.floating) steps.push({ action: 'float', enable: false, address: client.address });
  }
  return steps;
}

/** Hyprland 0.55+ replaced hyprlang dispatchers with Lua: `hyprctl dispatch "hl.dsp.window.pin({...})"`. */
export function luaDispatch(step: PinStep): string[] {
  return ['dispatch', `hl.dsp.window.${step.action}({ action = '${step.enable ? 'enable' : 'disable'}', window = 'address:${step.address}' })`];
}

/** Pre-0.55 hyprlang form. */
export function legacyDispatch(step: PinStep): string[] {
  const target = `address:${step.address}`;
  if (step.action === 'pin') return ['dispatch', 'pin', target];
  return ['dispatch', step.enable ? 'setfloating' : 'settiled', target];
}

// The AppImage FHS profile replaces PATH, so also try where NixOS puts it.
const HYPRCTL_CANDIDATES = ['hyprctl', '/run/current-system/sw/bin/hyprctl'];

async function hyprctl(args: string[]): Promise<string> {
  let lastError: unknown;
  for (const binary of HYPRCTL_CANDIDATES) {
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile(binary, args, { timeout: 3000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw lastError;
}

async function readClient(pid: number, windowClass: string, title: string): Promise<HyprlandClient | null> {
  return findClient(parseClients(JSON.parse(await hyprctl(['-j', 'clients']))), pid, windowClass, title);
}

/**
 * Pin or unpin the window. Returns the pinned state read back from the
 * compositor, or null when it could not be determined (not Hyprland, ambiguous
 * title, hyprctl missing), in which case nothing was changed unless a step ran.
 * `madeFloating` remembers that we floated a tiled window, so unpinning puts it back.
 */
export async function setHyprlandPinned(
  pid: number,
  windowClass: string,
  title: string,
  pinned: boolean,
  madeFloating: { value: boolean },
): Promise<boolean | null> {
  try {
    const client = await readClient(pid, windowClass, title);
    if (!client) {
      console.warn('[Main:Popout] No unique Hyprland window for', { pid, windowClass, title });
      return null;
    }
    if (pinned && !client.floating) madeFloating.value = true;
    for (const step of planPin(client, pinned, madeFloating.value)) {
      try {
        await hyprctl(luaDispatch(step));
      } catch {
        await hyprctl(legacyDispatch(step));
      }
    }
    if (!pinned) madeFloating.value = false;
    return (await readClient(pid, windowClass, title))?.pinned ?? null;
  } catch (error) {
    console.warn('[Main:Popout] Hyprland pin failed:', error);
    return null;
  }
}
