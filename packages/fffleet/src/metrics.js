// Prometheus metrics in the text exposition format (0.0.4). No dependencies.

import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const DURATION_BUCKETS = [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600, 14400];

const escapeLabel = v => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const formatValue = v => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : String(v));

function labelString(names, values, extra = '') {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? '')}"`);
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(',')}}` : '';
}

class Metric {
  constructor(type, name, help, labelNames = []) {
    this.type = type;
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    /** @type {Map<string, { values: string[], value: any }>} */
    this.series = new Map();
  }

  slot(labels = {}) {
    const values = this.labelNames.map(n => String(labels[n] ?? ''));
    const key = values.join('\u0000');
    let s = this.series.get(key);
    if (!s) {
      s = { values, value: this.initial() };
      this.series.set(key, s);
    }
    return s;
  }

  initial() {
    return 0;
  }

  /** Drops every series (gauges that are rebuilt on each scrape). */
  reset() {
    this.series.clear();
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const s of this.series.values()) lines.push(...this.renderSeries(s));
    return lines.join('\n');
  }

  renderSeries(s) {
    return [`${this.name}${labelString(this.labelNames, s.values)} ${formatValue(s.value)}`];
  }
}

class Counter extends Metric {
  inc(labels, n = 1) {
    this.slot(labels).value += n;
  }
}

class Gauge extends Metric {
  set(labels, v) {
    this.slot(labels).value = v;
  }

  inc(labels, n = 1) {
    this.slot(labels).value += n;
  }
}

class Histogram extends Metric {
  constructor(name, help, labelNames, buckets = DURATION_BUCKETS) {
    super('histogram', name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  initial() {
    return { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
  }

  observe(labels, v) {
    const h = this.slot(labels).value;
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]) h.counts[i]++;
    h.sum += v;
    h.count++;
  }

  renderSeries(s) {
    const h = s.value;
    const lines = this.buckets.map((b, i) => `${this.name}_bucket${labelString(this.labelNames, s.values, `le="${b}"`)} ${h.counts[i]}`);
    lines.push(`${this.name}_bucket${labelString(this.labelNames, s.values, 'le="+Inf"')} ${h.count}`);
    lines.push(`${this.name}_sum${labelString(this.labelNames, s.values)} ${h.sum}`);
    lines.push(`${this.name}_count${labelString(this.labelNames, s.values)} ${h.count}`);
    return lines;
  }
}

/** A set of metrics plus collectors that refresh gauges right before each scrape. */
export class Registry {
  constructor() {
    /** @type {Metric[]} */
    this.metrics = [];
    /** @type {(() => void | Promise<void>)[]} */
    this.collectors = [];
  }

  counter(name, help, labelNames) {
    return this.add(new Counter('counter', name, help, labelNames));
  }

  gauge(name, help, labelNames) {
    return this.add(new Gauge('gauge', name, help, labelNames));
  }

  histogram(name, help, labelNames, buckets) {
    return this.add(new Histogram(name, help, labelNames, buckets));
  }

  add(metric) {
    this.metrics.push(metric);
    return metric;
  }

  collect(fn) {
    this.collectors.push(fn);
  }

  async render() {
    for (const fn of this.collectors) await fn();
    return `${this.metrics.map(m => m.render()).join('\n')}\n`;
  }
}

const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

/**
 * Job metrics shared by the orchestrator and the worker. Call `track(record)` once per new job.
 * @param {Registry} registry
 * @param {() => Iterable<import('./job-record.js').JobRecord>} records   The jobs currently known.
 */
export function jobMetrics(registry, records) {
  const submitted = registry.counter('fffleet_jobs_submitted_total', 'Jobs accepted.', ['owner', 'class', 'kind']);
  const finished = registry.counter('fffleet_jobs_finished_total', 'Jobs that ended, by final state and error code.', ['owner', 'class', 'kind', 'state', 'code']);
  const wait = registry.histogram('fffleet_job_wait_seconds', 'Time from submit until ffmpeg started.', ['class']);
  const duration = registry.histogram('fffleet_job_run_seconds', 'Time from start until the job ended.', ['class', 'kind', 'state']);
  const current = registry.gauge('fffleet_jobs', 'Unfinished jobs by state.', ['owner', 'class', 'state']);
  registry.collect(() => {
    current.reset();
    for (const r of records()) if (!r.final) current.inc({ owner: r.spec.owner, class: r.spec.class, state: r.state });
  });
  return {
    track(record) {
      const { owner, kind } = record.spec;
      const cls = record.spec.class;
      submitted.inc({ owner, class: cls, kind });
      let started = false;
      record.subscribe(record.seq, e => {
        if (e.state === 'running' && !started && record.startedAt) {
          started = true;
          wait.observe({ class: cls }, seconds(record.createdAt, record.startedAt));
        }
        if (['succeeded', 'failed', 'cancelled'].includes(e.state)) {
          finished.inc({ owner, class: cls, kind, state: e.state, code: e.error?.code ?? '' });
          if (record.startedAt) duration.observe({ class: cls, kind, state: e.state }, seconds(record.startedAt, record.finishedAt));
        }
      });
    },
  };
}

/** process_* metrics of this Node process. */
export function processMetrics(registry) {
  const cpu = registry.gauge('process_cpu_seconds_total', 'User and system CPU time of this process.');
  const rss = registry.gauge('process_resident_memory_bytes', 'Resident memory of this process.');
  const start = registry.gauge('process_start_time_seconds', 'Start time of this process since the Unix epoch.');
  const startedAt = Date.now() / 1000 - process.uptime();
  cpu.type = 'counter';
  registry.collect(() => {
    const u = process.cpuUsage();
    cpu.set({}, (u.user + u.system) / 1e6);
    rss.set({}, process.memoryUsage.rss());
    start.set({}, Math.round(startedAt));
  });
}

/** Host metrics a worker reports: CPUs, load, memory and free space under `dir`. */
export function hostMetrics(registry, dir) {
  const ncpu = registry.gauge('fffleet_host_cpus', 'CPUs on this host.');
  const load = registry.gauge('fffleet_host_load1', 'One-minute load average.');
  const memTotal = registry.gauge('fffleet_host_memory_total_bytes', 'Memory on this host.');
  const memFree = registry.gauge('fffleet_host_memory_available_bytes', 'Memory available on this host.');
  const disk = registry.gauge('fffleet_workdir_free_bytes', 'Free space in the work directory.');
  registry.collect(async () => {
    ncpu.set({}, cpus().length);
    load.set({}, loadavg()[0]);
    memTotal.set({}, totalmem());
    memFree.set({}, freemem());
    disk.reset();
    if (dir) {
      try {
        const s = await statfs(dir);
        disk.set({}, s.bavail * s.bsize);
      } catch {
        // The work directory may not exist until the first job.
      }
    }
  });
}

const CLK_TCK = 100;
const PAGE_SIZE = 4096;

/** CPU seconds and resident bytes of a process, from /proc (Linux only; null elsewhere). */
export async function procStats(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesised command name; utime and stime are fields 14 and 15, rss is 24.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { cpuSeconds: (Number(f[11]) + Number(f[12])) / CLK_TCK, rssBytes: Number(f[21]) * PAGE_SIZE };
  } catch {
    return null;
  }
}
