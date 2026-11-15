/** Reorders complete Annex-B SPS/PPS NALs before the first VCL NAL. */
export function normalizeH264ParameterSets(data: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(data);
  const starts: { start: number; prefix: number }[] = [];
  for (let i = 0; i + 3 <= bytes.length;) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push({ start: i, prefix: 3 });
      i += 3;
    } else if (i + 4 <= bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      starts.push({ start: i, prefix: 4 });
      i += 4;
    } else i++;
  }
  if (!starts.length || starts[0]!.start !== 0) return data;
  const nals: { start: number; end: number; type: number }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const current = starts[i]!;
    const end = starts[i + 1]?.start ?? bytes.length;
    const header = current.start + current.prefix;
    if (header >= end) return data;
    const nalHeader = bytes[header]!;
    const type = nalHeader & 0x1f;
    if ((nalHeader & 0x80) !== 0 || type === 0 || type > 23) return data;
    if ((type === 7 || type === 8) && header + 2 >= end) return data;
    nals.push({ start: current.start, end, type });
  }
  const firstVcl = nals.findIndex(nal => nal.type >= 1 && nal.type <= 5);
  if (firstVcl < 0) return data;
  if (nals[firstVcl]!.type !== 5) return data;
  let hasTrailingSps = false;
  let hasTrailingPps = false;
  for (let i = firstVcl + 1; i < nals.length; i++) {
    if (nals[i]!.type === 7) hasTrailingSps = true;
    if (nals[i]!.type === 8) hasTrailingPps = true;
  }
  if (!hasTrailingSps || !hasTrailingPps) return data;

  const parameterSets = nals.filter(nal => nal.type === 7 || nal.type === 8);
  const parameterSetIndices = new Set<number>();
  nals.forEach((nal, index) => {
    if (nal.type === 7 || nal.type === 8) parameterSetIndices.add(index);
  });
  const reordered = [
    ...nals.slice(0, firstVcl).filter((_nal, index) => !parameterSetIndices.has(index)),
    ...parameterSets,
    ...nals.slice(firstVcl).filter((_nal, index) => !parameterSetIndices.has(firstVcl + index)),
  ];
  const output = new Uint8Array(data.byteLength);
  let offset = 0;
  for (const nal of reordered) {
    output.set(bytes.subarray(nal.start, nal.end), offset);
    offset += nal.end - nal.start;
  }
  return output.buffer;
}
