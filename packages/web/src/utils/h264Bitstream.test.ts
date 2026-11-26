import { describe, expect, it } from 'vitest';
import { normalizeH264ParameterSets } from './h264Bitstream';

const start = (prefix: 3 | 4, ...nal: number[]) => [...Array(prefix - 1).fill(0), 1, ...nal];
const buffer = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const sps = [0x67, 0x42, 0xe0, 0x1f, 0x80];
const pps = [0x68, 0xce, 0x3c, 0x80];

describe('normalizeH264ParameterSets', () => {
  it('keeps AUD and SEI before the repaired SPS/PPS and preserves payload bytes', () => {
    const input = buffer(
      ...start(4, 0x09, 0xf0), ...start(3, 0x06, 0x22),
      ...start(4, 0x65, 0x11), ...start(4, ...sps), ...start(3, ...pps),
    );
    expect([...new Uint8Array(normalizeH264ParameterSets(input))]).toEqual([
      ...start(4, 0x09, 0xf0), ...start(3, 0x06, 0x22),
      ...start(4, ...sps), ...start(3, ...pps), ...start(4, 0x65, 0x11),
    ]);
  });

  it('preserves multiple IDR slices and mixed start-code lengths', () => {
    const input = buffer(
      ...start(3, 0x65, 1), ...start(4, 0x65, 2), ...start(3, ...sps), ...start(4, ...pps),
    );
    expect([...new Uint8Array(normalizeH264ParameterSets(input))]).toEqual([
      ...start(3, ...sps), ...start(4, ...pps), ...start(3, 0x65, 1), ...start(4, 0x65, 2),
    ]);
  });

  it('does not copy an already valid keyframe or a P frame', () => {
    const valid = buffer(...start(4, ...sps), ...start(3, ...pps), ...start(4, 0x65, 3));
    const pframe = buffer(...start(4, 0x41, 3), ...start(3, ...sps), ...start(4, ...pps));
    expect(normalizeH264ParameterSets(valid)).toBe(valid);
    expect(normalizeH264ParameterSets(pframe)).toBe(pframe);
  });

  it('leaves other codecs, malformed headers and truncated parameter sets untouched', () => {
    const candidates = [
      buffer(0x82, 0x49, 0x83, 0x42),
      buffer(...start(3, 0x65, 1), 0, 0, 1),
      buffer(...start(3, 0x65, 1), ...start(3, 0x67), ...start(3, ...pps)),
      buffer(...start(3, 0x65, 1), ...start(3, ...sps), ...start(3, 0x68)),
      buffer(...start(3, 0xe5, 1), ...start(3, ...sps), ...start(3, ...pps)),
      buffer(...start(3, 0x00, 1), ...start(3, ...sps), ...start(3, ...pps)),
    ];
    for (const input of candidates) expect(normalizeH264ParameterSets(input)).toBe(input);
  });

  it('does not split an emulation-prevention sequence inside an IDR payload', () => {
    const input = buffer(...start(3, 0x65, 0, 0, 3, 1), ...start(4, ...sps), ...start(3, ...pps));
    expect([...new Uint8Array(normalizeH264ParameterSets(input))]).toEqual([
      ...start(4, ...sps), ...start(3, ...pps), ...start(3, 0x65, 0, 0, 3, 1),
    ]);
  });
});
