// A job type that is not ffmpeg: runs until cancelled (stream) or answers at once (batch).
export default {
  type: 'echo',
  async run(spec, rt) {
    rt.setState('running');
    if (spec.kind === 'batch') return { exitCode: 0, outputs: [] };
    await new Promise(resolve => rt.signal.addEventListener('abort', resolve, { once: true }));
    rt.signal.throwIfAborted();
  },
};
