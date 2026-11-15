import { describe, expect, it } from 'vitest';
import { isPopoutWindowName, isPopoutWindowOpenAllowed } from './popoutPolicy';

describe('pop-out window policy', () => {
  it('accepts generated stream names with a non-empty safe key', () => {
    expect(isPopoutWindowName('backspace-popout-user:stream-1')).toBe(true);
    expect(isPopoutWindowName('backspace-popout-')).toBe(false);
    expect(isPopoutWindowName('backspace-popout-<script>')).toBe(false);
    expect(isPopoutWindowName('unrelated-window')).toBe(false);
  });

  it('allows only blank initial URLs for named pop-out windows', () => {
    expect(isPopoutWindowOpenAllowed('backspace-popout-user:stream-1', '')).toBe(true);
    expect(isPopoutWindowOpenAllowed('backspace-popout-user:stream-1', 'about:blank')).toBe(true);
    expect(isPopoutWindowOpenAllowed('backspace-popout-user:stream-1', 'https://evil.test')).toBe(false);
    expect(isPopoutWindowOpenAllowed('other-window', '')).toBe(false);
  });
});
