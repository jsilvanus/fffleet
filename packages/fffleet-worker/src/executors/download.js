// Built-in executor for yt-dlp downloads (job type "download").
//
// Enable it on a worker with FFFLEET_EXECUTORS=fffleet-worker/executors/download (yt-dlp must be on the PATH, or set
// YTDLP_PATH). The worker image `fffleet-worker-ytdlp` has both.
//
// Spec:    spec.download = { url, format?, extraArgs? }   (url is http(s); format is a yt-dlp format selector)
// Inputs:  "cookies" (optional)  Netscape cookies.txt; s3:, http(s): or file:. Copied into the work directory, because
//                                yt-dlp rewrites the cookie file it is given.
// Outputs: "video"               the downloaded mp4 (s3:, file: or http(s) PUT)
//          "cookies-out" (opt.)  the cookie file after the run, uploaded only when yt-dlp changed it
//
// Cookie contents are never logged and never put into errors: error text is built from yt-dlp's stderr after cookie
// values, the cookie file path and cookie-shaped lines are removed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FORMAT = "bv*+ba/b";
const KILL_GRACE_MS = 5000;
const TAIL_CHARS = 2000;
// Options that would let a job spec run commands, read other files or move the output elsewhere.
const FORBIDDEN_ARGS = /^(?:-o|-a|-P|--output|--paths|--exec(?:-before-download)?|--config(?:-location|-locations)?|--plugin-dirs|--batch-file|--cookies|--cookies-from-browser|--load-info-json|--netrc-cmd|--ffmpeg-location|--no-config|--write-.*|--print-to-file)(?:=|$)/;

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function parseS3(uri) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw fail("BAD_SPEC", `not an s3://bucket/key URI: ${uri}`);
  return { bucket: m[1], key: m[2] };
}

function endpoint(list, name) {
  return Array.isArray(list) ? list.find(e => e.name === name) : undefined;
}

export function readPayload(spec) {
  const d = spec.download;
  if (!d || typeof d !== "object" || typeof d.url !== "string") throw fail("BAD_SPEC", "spec.download.url is required");
  let url;
  try { url = new URL(d.url); } catch { throw fail("BAD_SPEC", "spec.download.url is not a URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("BAD_SPEC", "spec.download.url must be http(s)");
  const extraArgs = d.extraArgs ?? [];
  if (!Array.isArray(extraArgs) || extraArgs.some(a => typeof a !== "string")) throw fail("BAD_SPEC", "spec.download.extraArgs must be an array of strings");
  const bad = extraArgs.find(a => FORBIDDEN_ARGS.test(a));
  if (bad) throw fail("BAD_SPEC", `yt-dlp option not allowed in extraArgs: ${bad.split("=")[0]}`);
  const format = typeof d.format === "string" && d.format ? d.format : DEFAULT_FORMAT;
  return { url: url.href, format, extraArgs };
}

async function stageCookies(input, dest, rt) {
  await mkdir(dirname(dest), { recursive: true });
  const url = new URL(input.uri);
  try {
    if (url.protocol === "s3:") {
      if (!rt.s3) throw fail("UNSUPPORTED_SCHEME", "this runner has no S3 credentials for s3: URIs");
      const { bucket, key } = parseS3(input.uri);
      await rt.s3.getFile(bucket, key, dest, { signal: rt.signal });
    } else if (url.protocol === "file:") {
      await copyFile(fileURLToPath(url), dest);
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      const res = await (rt.fetch ?? globalThis.fetch)(input.uri, { signal: rt.signal });
      if (!res.ok) throw fail("INPUT_FAILED", `HTTP ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    } else {
      throw fail("UNSUPPORTED_SCHEME", `unsupported scheme ${url.protocol}`);
    }
  } catch (err) {
    if (rt.signal.aborted) throw rt.signal.reason;
    // Only the endpoint name, never the URI (it may carry a signature) or file contents.
    throw fail(err.code ?? "INPUT_FAILED", `could not fetch input "${input.name}": ${err.message}`);
  }
}

async function deliver(output, file, rt, contentType) {
  const url = new URL(output.uri);
  if (url.protocol === "s3:") {
    if (!rt.s3) throw fail("UNSUPPORTED_SCHEME", "this runner has no S3 credentials for s3: URIs");
    const { bucket, key } = parseS3(output.uri);
    await rt.s3.putFile(bucket, key, file, { contentType, signal: rt.signal });
  } else if (url.protocol === "file:") {
    const target = fileURLToPath(url);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  } else if (url.protocol === "http:" || url.protocol === "https:") {
    const body = await readFile(file);
    const res = await (rt.fetch ?? globalThis.fetch)(output.uri, { method: "PUT", headers: { "content-type": contentType ?? "application/octet-stream" }, body, signal: rt.signal });
    if (!res.ok) throw fail("UPLOAD_FAILED", `upload of output "${output.name}" failed: HTTP ${res.status}`);
  } else {
    throw fail("UNSUPPORTED_SCHEME", `unsupported scheme ${url.protocol}`);
  }
}

const sha = buf => createHash("sha256").update(buf).digest("hex");

/** Removes everything that could reveal cookies from yt-dlp's output before it goes into an error. */
export function scrub(text, { cookiePath, secrets = [] }) {
  let out = text;
  if (cookiePath) out = out.split(cookiePath).join("<cookies>");
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out
    .split("\n")
    .filter(line => (line.match(/\t/g) ?? []).length < 5) // Netscape cookie lines have 6 or 7 tab-separated fields.
    .join("\n");
}

/** Cookie values and names long enough to be worth masking. */
function cookieSecrets(text) {
  const secrets = new Set();
  for (const line of text.split(/\r?\n/)) {
    const f = line.replace(/^#HttpOnly_/, "").split("\t");
    if (f.length >= 7) for (const v of [f[5], f[6]]) if (v && v.length >= 6) secrets.add(v.trim());
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

const PROGRESS_RE = /\[download\]\s+(\d+(?:\.\d+)?)%/;

function runYtDlp(command, args, rt, onLine) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (err) {
      reject(fail("YTDLP_SPAWN", `could not start yt-dlp: ${err.message}`));
      return;
    }
    let stderr = "";
    let buffered = "";
    let killTimer;
    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => kill();
    if (rt.signal.aborted) kill();
    else rt.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n|\r/);
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16 * 1024); });
    child.on("error", err => {
      clearTimeout(killTimer);
      rt.signal.removeEventListener("abort", onAbort);
      reject(fail("YTDLP_SPAWN", `could not start yt-dlp: ${err.code === "ENOENT" ? "yt-dlp is not installed on this worker" : err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      rt.signal.removeEventListener("abort", onAbort);
      if (buffered) onLine(buffered);
      resolve({ code, signal, stderr });
    });
  });
}

export async function runDownload(spec, rt) {
  const { url, format, extraArgs } = readPayload(spec);
  const videoOut = endpoint(spec.outputs, "video");
  if (!videoOut) throw fail("BAD_SPEC", 'output "video" is required');
  const cookiesIn = endpoint(spec.inputs, "cookies");
  const cookiesOut = endpoint(spec.outputs, "cookies-out");

  const videoPath = join(rt.workDir, "out", "video.mp4");
  await mkdir(dirname(videoPath), { recursive: true });

  let cookiePath;
  let cookieHash;
  let secrets = [];
  if (cookiesIn) {
    rt.setState("staging");
    cookiePath = join(rt.workDir, "cookies", "cookies.txt");
    await stageCookies(cookiesIn, cookiePath, rt);
    const bytes = await readFile(cookiePath);
    cookieHash = sha(bytes);
    secrets = cookieSecrets(bytes.toString("utf8"));
  }
  rt.signal.throwIfAborted();

  const args = [
    "--no-playlist", "--format", format, "--merge-output-format", "mp4", "--newline", "--progress", "--no-colors",
    ...(cookiePath ? ["--cookies", cookiePath] : []),
    ...extraArgs,
    "--output", videoPath,
    "--", url,
  ];
  rt.setState("running");
  const { code, signal, stderr } = await runYtDlp(process.env.YTDLP_PATH || "yt-dlp", args, rt, line => {
    const m = PROGRESS_RE.exec(line);
    if (m) rt.progress({ pct: Math.max(0, Math.min(100, Number(m[1]))), outTimeMs: null, speed: null, fps: null, frame: null });
  });

  if (rt.signal.aborted) throw rt.signal.reason ?? fail("CANCELLED", "cancelled");
  if (code !== 0) {
    const tail = scrub(stderr, { cookiePath, secrets }).trim().slice(-TAIL_CHARS);
    const how = code === null ? `was killed by ${signal}` : `exited with code ${code}`;
    throw fail("YTDLP_EXIT", `yt-dlp ${how}${tail ? `: ${tail}` : ""}`, { exitCode: code });
  }

  let size;
  try { size = (await stat(videoPath)).size; } catch { size = 0; }
  if (!size) throw fail("OUTPUT_MISSING", "yt-dlp finished but wrote no video file");

  rt.setState("uploading");
  const results = [];
  await deliver(videoOut, videoPath, rt, "video/mp4");
  results.push({ name: "video", uri: videoOut.uri, bytes: size });

  if (cookiesOut && cookiePath) {
    let after;
    try { after = await readFile(cookiePath); } catch { after = null; }
    // Upload only a changed file: an unchanged one means nothing to write back.
    if (after && sha(after) !== cookieHash) {
      await deliver(cookiesOut, cookiePath, rt, "text/plain");
      results.push({ name: "cookies-out", uri: cookiesOut.uri, bytes: after.length });
    }
  }
  return { exitCode: 0, outputs: results, stderrTail: null };
}

export default { type: "download", run: runDownload };
