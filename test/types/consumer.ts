// Compiles against the published type declarations; `npm run test:types` fails when they drift from how the API is used.
import { createFleet, parseSpec, isFinal, JobManager, FleetError } from 'fffleet';
import type { JobHandle, JobSnapshot, JobSpecInput } from 'fffleet';
import { createApiHandler, listen, close } from 'fffleet/server';

const input: JobSpecInput = {
  kind: 'batch',
  timeoutMs: 60_000,
  requires: ['filter:ass'],
  inputs: [{ name: 'src', uri: 'https://example.com/in.mp4' }],
  outputs: [{ name: 'dst', uri: 'file:///tmp/out.mp4' }],
  ffmpeg: { args: ['-i', '{{input:src}}', '{{output:dst}}'], durationMs: 1000 },
};

const fleet = createFleet({ url: 'http://localhost:7000', fallback: 'local' });
const job: JobHandle = await fleet.submit(input);
job.on('progress', p => p.outTimeMs);
job.on('stderr', (tail: string) => tail.length);
job.on('state', (state: string) => isFinal(state));
const last: string | null = job.stderrTail;
const snapshot: JobSnapshot = await job.done;
snapshot.state satisfies string;
await job.cancel();
await fleet.close();

parseSpec(input).kind satisfies 'batch' | 'stream';
const manager = new JobManager({ ffmpegPath: 'ffmpeg' });
manager.submit(input);
await manager.close();

try {
  await job.done;
} catch (err) {
  if (err instanceof FleetError) err.code satisfies string;
}

void [last, createApiHandler, listen, close];
