// Test helper: writes a fake `yt-dlp` executable (node script) that behaves according to FAKE_YTDLP_MODE.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const val = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const out = val("--output"); const cookies = val("--cookies");
if (process.env.FAKE_YTDLP_LOG) fs.appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_YTDLP_MODE || "ok";
if (mode === "hang") {
  if (process.env.FAKE_YTDLP_PID) fs.writeFileSync(process.env.FAKE_YTDLP_PID, String(process.pid));
  console.log("[download]   1.0% of 10.00MiB");
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  const cookieText = cookies ? fs.readFileSync(cookies, "utf8") : "";
  const leak = cookieText.split("\\n").find(l => l.includes("\\t")) || "";
  console.error("ERROR: Sign in to confirm you are not a bot");
  console.error("debug: cookie jar at " + cookies);
  console.error(leak);
  process.exit(3);
} else {
  for (const p of ["10.0", "55.5", "100.0"]) console.log("[download]  " + p + "% of 10.00MiB at 1.00MiB/s ETA 00:01");
  fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
  fs.writeFileSync(out, "FAKE-MP4:" + args[args.length - 1]);
  if (cookies && process.env.FAKE_YTDLP_TOUCH_COOKIES) fs.appendFileSync(cookies, "\\n.youtube.com\\tTRUE\\t/\\tTRUE\\t0\\tFRESH\\tnewvalue123456\\n");
}
`;

export async function installFakeYtDlp(dir) {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const file = path.join(bin, "yt-dlp");
  await writeFile(file, SCRIPT);
  await chmod(file, 0o755);
  return bin;
}
