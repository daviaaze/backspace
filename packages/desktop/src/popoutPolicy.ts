export const POPOUT_WINDOW_NAME_PREFIX = 'backspace-popout-';

export function isPopoutWindowName(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(POPOUT_WINDOW_NAME_PREFIX)
    && /^[A-Za-z0-9._:%-]+$/.test(value.slice(POPOUT_WINDOW_NAME_PREFIX.length))
    && value.length > POPOUT_WINDOW_NAME_PREFIX.length;
}
export function isPopoutWindowOpenAllowed(frameName: unknown, url: unknown): boolean {
  return isPopoutWindowName(frameName) && (url === '' || url === 'about:blank');
}
