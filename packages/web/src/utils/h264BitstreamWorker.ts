import { normalizeH264ParameterSets } from './h264Bitstream';

interface TransformEvent {
  transformer: {
    readable: ReadableStream<RTCEncodedVideoFrame>;
    writable: WritableStream<RTCEncodedVideoFrame>;
  };
}

const workerScope = self as unknown as {
  onrtctransform: ((event: TransformEvent) => void) | null;
};

workerScope.onrtctransform = (event) => {
  const transformer = event.transformer;
  const transform = new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
    transform(frame, controller) {
      if (frame.type === 'key') {
        const data = frame.data;
        const normalized = normalizeH264ParameterSets(data);
        if (normalized !== data) {
          frame.data = normalized;
        }
      }
      controller.enqueue(frame);
    },
  });
  transformer.readable.pipeThrough(transform).pipeTo(transformer.writable).catch((error) => {
    console.error('[Video] H264 encoded transform failed:', error);
  });
};
