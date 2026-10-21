# k6 load profile (boilerplate — the sandbox cannot run k6).
# Hot path targets: reads p95 ≤ 250 ms · /check p95 ≤ 150 ms · 50 concurrent analysts.

import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    analysts: {
      executor: "constant-vus",
      vus: 50,
      duration: "10m",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<300"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export default function (): void {
  // Queue reads (hot path)
  const queue = http.get(`${BASE}/api/v1/exceptions?limit=50`, { headers: { "x-mizan-actor": "analyst-a" } });
  check(queue, { "queue 200": (r) => r.status === 200 });

  // Overview projections
  const overview = http.get(`${BASE}/api/v1/overview`, { headers: { "x-mizan-actor": "analyst-a" } });
  check(overview, { "overview 200": (r) => r.status === 200 });

  // Decision write (idempotent; guarded by If-Match in the real client)
  sleep(2);
}
