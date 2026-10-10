# Multi-IP DNS Resolution & Failover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically detect, benchmark, and failover across multiple DNS A-records for upstream IPTV hosts while preserving HTTP Host headers and TLS SNI.

**Architecture:** A dedicated `server/dns-resolver.ts` module resolves all IPv4 A-records, caches the pool with a TTL, tracks per-IP latency/health, and creates targeted Node HTTP/HTTPS agents that route TCP sockets to specific IPs while retaining domain semantics (Host header & SNI). `server/hosts.ts` benchmarks candidate IPs and selects the fastest healthy node; `server/routes/proxy.ts` and `server/multiplexer/stream-hub.ts` implement transparent per-IP failover before switching fallback host URLs; the frontend UI in `src/components/index.tsx` displays multi-IP cluster badges with latency details.

**Tech Stack:** Node.js `dns` module, `http.Agent`/`https.Agent` custom lookup, Axios, TypeScript, Vitest, React, Tailwind CSS.

---

### Task 1: DNS Resolver & Multi-IP Agent Core Module

**Files:**
- Create: `server/dns-resolver.ts`
- Test: `server/dns-resolver.test.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing unit tests**
Create `server/dns-resolver.test.ts` testing:
1. `resolveHostIps`: resolves multiple A records, ignores invalid/private IPs if requested, caches results.
2. `createIpPinnedAgent`: creates `http.Agent` and `https.Agent` whose `lookup` properly responds to both `{ all: true }` and standard single address lookups, pinning the socket to the chosen IP while keeping original hostname.
3. `measureIpLatency`: probes a target IP with the specified Host header and measures response time.
4. `rankHostIps`: sorts IPs by latency, marking responsive ones as healthy.

**Step 2: Run test to verify it fails**
Run: `npm run test -- server/dns-resolver.test.ts`
Expected: FAIL with module not found.

**Step 3: Implement `server/dns-resolver.ts`**
- In-memory DNS cache with configurable TTL (default 5 minutes).
- `resolveHostIps(hostname: string)` using `dns.promises.resolve4` with fallback to `dns.promises.lookup`.
- `createIpPinnedAgent(targetIp: string, isHttps: boolean)` handling Node 20's `options.all` (Happy Eyeballs) signature `callback(null, [{ address: targetIp, family: 4 }])` and single lookup `callback(null, targetIp, 4)`.
- `measureIpLatency(hostname: string, ip: string, port: number, isHttps: boolean, timeoutMs: number)`
- `rankHostIps(hostname: string, port: number, isHttps: boolean, timeoutMs: number)`

**Step 4: Run tests and verify they pass**
Run: `npm run test -- server/dns-resolver.test.ts`
Expected: PASS.

---

### Task 2: Integrate Multi-IP Detection & Benchmarking into Hosts Module

**Files:**
- Modify: `src/types.ts:15-35`
- Modify: `server/hosts.ts`
- Test: `server/hosts.test.ts`

**Step 1: Update `SourceHost` type in `src/types.ts`**
Add:
```ts
export interface SourceHostResolvedIp {
  ip: string;
  latencyMs: number | null;
  healthy: boolean;
}
```
Add to `SourceHost`:
```ts
resolvedIps?: SourceHostResolvedIp[];
ipCount?: number;
```

**Step 2: Write tests in `server/hosts.test.ts`**
Verify that when `normalizeHosts` and `benchmarkSourceHosts` run, `resolvedIps` and `ipCount` are preserved and populated when multiple IPs are detected.

**Step 3: Update `server/hosts.ts`**
- In `detectHostNetwork`: use `resolveHostIps` to find all IPs; if multi-IP detected, set `ipCount`.
- In `benchmarkSourceHosts`: for each host, if it has multiple IPs, probe/rank them and choose the lowest-latency healthy IP as `resolvedIp`, attaching `resolvedIps` and `ipCount` to the host object and history logs.

**Step 4: Run tests and verify they pass**
Run: `npm run test -- server/hosts.test.ts`
Expected: PASS.

---

### Task 3: IP-Level Stream Proxying & Failover

**Files:**
- Modify: `server/routes/proxy.ts:265-310`
- Test: `server/routes/proxy.ts` (vitest or test coverage)

**Step 1: Write tests for multi-IP stream failover**
Add test in `server/routes/proxy-multi-ip.test.ts` verifying that when a host has multiple resolved IPs and the first IP fails (e.g. 500 or timeout), proxy falls over to the second IP of that same host before giving up.

**Step 2: Update `server/routes/proxy.ts`**
In `handleStreamProxy`:
- For each `hostUrl`:
  - Extract hostname and protocol.
  - Query candidate IPs via `resolveHostIps` or `host.resolvedIps`.
  - Iterate through candidate IPs (starting with fastest/active):
    - Create `createIpPinnedAgent(targetIp, isHttps)`.
    - Pass agent to `axios` via `httpAgent` / `httpsAgent`.
    - If response status < 400, proceed with streaming (Live or VOD).
    - If status >= 400 or error, log failover attempt and try next IP.
    - If all IPs of that host fail, proceed to next host in `hostUrls`.

**Step 3: Run tests and verify they pass**
Run: `npm run test`
Expected: PASS.

---

### Task 4: StreamHub In-Place Reconnect with IP Rotation

**Files:**
- Modify: `server/multiplexer/stream-hub.ts:580-625`
- Test: `server/multiplexer/stream-hub.test.ts`

**Step 1: Write test for IP rotation on reconnect in `stream-hub.test.ts`**
Verify that if reconnect fails or on gap reconnect, StreamHub uses the alternate IP from the host's candidate pool.

**Step 2: Update `server/multiplexer/stream-hub.ts`**
- Store `candidateIps?: string[]` and `currentIpIndex?: number` in `channel.upstreamConfig`.
- When `reconnectChannel` is invoked:
  - Select the next IP in the pool using `createIpPinnedAgent`.
  - Log which IP is being used for the reconnect.

**Step 3: Run tests and verify they pass**
Run: `npm run test -- server/multiplexer/stream-hub.test.ts`
Expected: PASS.

---

### Task 5: UI Display for Multi-IP Clusters in Source Manager

**Files:**
- Modify: `src/components/index.tsx:1990-2070`

**Step 1: Add Multi-IP Cluster Indicator**
In the Hosts table of `SourceManager`:
- If `h.ipCount && h.ipCount > 1`:
  - Show a small pill/badge: `[11 IPs]` next to `Direct`.
  - Tooltip / hover popover displaying the sorted list of IPs:
    - Best/Active IP highlighted in emerald.
    - Latency for each IP (e.g. `31 ms`, `32 ms`, `93 ms`).

**Step 2: Verify TypeScript Compilation**
Run: `npm run lint`
Expected: PASS with 0 errors.

---

### Task 6: Verification & Documentation Updates

**Files:**
- Modify: `AGENTS.md`
- Create: `.antigravity/memory/2026-10-10-multi-ip-dns.md`

**Step 1: Run full test suite and linter**
Run: `npm run lint && npm run test`
Expected: All tests pass.

**Step 2: Update `AGENTS.md` and `.antigravity/` memory**
- Update backend modules table in `AGENTS.md` to document `server/dns-resolver.ts`.
- Document findings and design decisions in `.antigravity/memory/2026-10-10-multi-ip-dns.md`.
