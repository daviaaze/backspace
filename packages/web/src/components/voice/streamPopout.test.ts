import { describe, expect, it } from 'vitest';
import { getStreamPopoutName } from './streamPopout';

describe('getStreamPopoutName', () => {
  it('creates stable, distinct names for distinct stream identities', () => {
    expect(getStreamPopoutName('user:screen/1')).toBe('backspace-popout-user%3Ascreen%2F1');
    expect(getStreamPopoutName('user:screen/2')).not.toBe(getStreamPopoutName('user:screen/1'));
  });
});
