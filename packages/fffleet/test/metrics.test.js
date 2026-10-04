import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../src/job-manager.js';
import { Registry, jobMetrics } from '../src/metrics.js';
import { fakeExecutor, fakeSpec, until } from './helpers.js';

test('renders counters, gauges and histograms in the Prometheus text format', async () => {
  const r = new Registry();
  const c = r.counter('x_total', 'Things.', ['kind']);
  const g = r.gauge('x_gauge', 'A gauge.');
  const h = r.histogram('x_seconds', 'Durations.', ['class'], [1, 10]);
  c.inc({ kind: 'a"b\\c\nd' });
  c.inc({ kind: 'a"b\\c\nd' }, 2);
  g.set({}, 1.5);
  h.observe({ class: 'default' }, 0.5);
  h.observe({ class: 'default' }, 5);
  h.observe({ class: 'default' }, 50);
  r.collect(() => g.set({}, 7));
  const text = await r.render();
  assert.match(text, /# HELP x_total Things\.\n# TYPE x_total counter\n/);
  assert.match(text, /x_total\{kind="a\\"b\\\\c\\nd"\} 3\n/);
  assert.match(text, /x_gauge 7\n/, 'collectors run before rendering');
  assert.match(text, /x_seconds_bucket\{class="default",le="1"\} 1\n/);
  assert.match(text, /x_seconds_bucket\{class="default",le="10"\} 2\n/);
  assert.match(text, /x_seconds_bucket\{class="default",le="\+Inf"\} 3\n/);
  assert.match(text, /x_seconds_sum\{class="default"\} 55\.5\n/);
  assert.match(text, /x_seconds_count\{class="default"\} 3\n/);
  assert.ok(text.endsWith('\n'));
});

test('job metrics count submitted and finished jobs, waits and runs, and unfinished jobs by state', async () => {
  const fake = fakeExecutor();
  const m = new JobManager({ slots: { default: 1 }, executors: { fake: fake.executor } });
  const r = new Registry();
  const stats = jobMetrics(r, () => m.jobs.values());
  m.on('job', rec => stats.track(rec));

  m.submit(fakeSpec('a', { owner: 'app1' }));
  m.submit(fakeSpec('b', { owner: 'app2' }));
  await until(() => fake.controls.has('a'));
  let text = await r.render();
  assert.match(text, /fffleet_jobs_submitted_total\{owner="app1",class="default",kind="batch"\} 1/);
  assert.match(text, /fffleet_jobs\{owner="app1",class="default",state="running"\} 1/);
  assert.match(text, /fffleet_jobs\{owner="app2",class="default",state="queued"\} 1/);
  assert.match(text, /fffleet_job_wait_seconds_count\{class="default"\} 1/);

  fake.controls.get('a').release();
  await until(() => fake.controls.has('b'));
  fake.controls.get('b').fail(Object.assign(new Error('boom'), { code: 'FFMPEG_EXIT' }));
  await until(() => m.get('b').state === 'failed');
  text = await r.render();
  assert.match(text, /fffleet_jobs_finished_total\{owner="app1",class="default",kind="batch",state="succeeded",code=""\} 1/);
  assert.match(text, /fffleet_jobs_finished_total\{owner="app2",class="default",kind="batch",state="failed",code="FFMPEG_EXIT"\} 1/);
  assert.match(text, /fffleet_job_run_seconds_count\{class="default",kind="batch",state="succeeded"\} 1/);
  assert.doesNotMatch(text, /fffleet_jobs\{/, 'no unfinished jobs left');
  await m.close();
});
