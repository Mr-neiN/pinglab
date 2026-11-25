/**
 * Bufferbloat in both directions, against a local HTTP server instead of the internet.
 *
 * The old test only loaded the download direction: `bufferbloat()` had no upload path at
 * all, so "ping when someone uploads" could never be measured and the API ignored the
 * direction. This runs the real saturators, real TCP latency probes and real grading over
 * injectable URLs, so the down and up paths are both proven without depending on
 * speed.cloudflare.com being reachable from a test machine.
 */
import assert from "node:assert/strict";
import http from "node:http";

import { bufferbloat } from "./bufferbloat.mjs";

const RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const payload = Buffer.alloc(2 * 1024 * 1024);

/** Serves downloads fast and accepts uploads; one path refuses uploads. */
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    if (req.url.startsWith("/blocked")) {
      res.writeHead(405, { Connection: "close" });
      res.end("no");
      return;
    }
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Received": String(received) });
      res.end("ok");
    });
    req.on("error", () => {});
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length });
  res.end(payload);
});
server.on("clientError", (_err, socket) => socket.destroy());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const urls = {
  down: `http://127.0.0.1:${port}/down`,
  up: `http://127.0.0.1:${port}/up`,
};

try {
  // 1. Both directions, sequentially. Each phase must actually move at least 3 MB,
  //    because below that the line was never loaded and a grade would be invented.
  const both = await bufferbloat({ host: "127.0.0.1", port, seconds: 2, streams: 2, urls });
  assert.equal(both.mode, "both");
  assert.ok(both.download, "download phase missing");
  assert.ok(both.upload, "upload phase missing");
  assert.ok(both.download.bytes >= 3_000_000, `download moved ${both.download.bytes} bytes`);
  assert.ok(both.upload.bytes >= 3_000_000, `upload moved ${both.upload.bytes} bytes`);
  assert.ok(both.download.mbps > 0, "download throughput was not measured");
  assert.ok(both.upload.mbps > 0, "upload throughput was not measured");
  assert.ok(RANK[both.download.grade] !== undefined, `download grade ${both.download.grade}`);
  assert.ok(RANK[both.upload.grade] !== undefined, `upload grade ${both.upload.grade}`);
  assert.equal(
    RANK[both.grade],
    Math.max(RANK[both.download.grade], RANK[both.upload.grade]),
    "the overall grade is the worse direction",
  );
  assert.equal(both.download.direction, "download");
  assert.equal(both.upload.direction, "upload");

  // 2. Upload alone: no download phase is invented.
  const up = await bufferbloat({ host: "127.0.0.1", port, seconds: 2, streams: 2, direction: "up", urls });
  assert.equal(up.mode, "up");
  assert.equal(up.download, null);
  assert.ok(up.upload);
  assert.ok(up.upload.bytes >= 3_000_000);
  assert.equal(up.grade, up.upload.grade);

  // 3. Both at once. One loaded window, two direction figures.
  const duplex = await bufferbloat({ host: "127.0.0.1", port, seconds: 2, streams: 2, direction: "duplex", urls });
  assert.equal(duplex.mode, "duplex");
  assert.ok(duplex.download && duplex.upload);
  assert.ok(duplex.download.bytes >= 3_000_000);
  assert.ok(duplex.upload.bytes >= 3_000_000);

  // 4. Upload blocked: the download result stands, the upload says why it is not a grade,
  //    and the overall grade cannot be better than the direction that was measured.
  const half = await bufferbloat({
    host: "127.0.0.1",
    port,
    seconds: 2,
    streams: 2,
    urls: { down: urls.down, up: `http://127.0.0.1:${port}/blocked` },
  });
  assert.ok(RANK[half.download.grade] !== undefined, "download should still be graded");
  assert.equal(half.upload.grade, "n/a", "a blocked upload must not get a grade");
  assert.match(half.upload.error, /not enough upload traffic/);
  assert.equal(half.ok, true, "the measured direction keeps the test useful");
  assert.equal(half.overallGrade, half.download.grade);

  // 5. A target that cannot resolve is a refusal, not a made-up grade.
  const unresolved = await bufferbloat({ host: "no-such-host.invalid", seconds: 1, direction: "down", urls });
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.error, /resolve/i);
  assert.equal(unresolved.grade, "n/a");

  console.log("\nbufferbloat");
  console.log(
    `  both        down grade ${both.download.grade} (${both.download.bytes} B) · up grade ${both.upload.grade} (${both.upload.bytes} B) · overall ${both.grade}`,
  );
  console.log(`  up only     down=${up.download} · upload grade ${up.upload.grade}`);
  console.log(`  duplex      down ${duplex.download.bytes} B · up ${duplex.upload.bytes} B`);
  console.log(`  blocked up  download ${half.download.grade}, upload ${half.upload.grade}: ${half.upload.error}`);
  console.log("\nall bufferbloat checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
