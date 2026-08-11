# Research note: Telegram long-poll hangs forever through `ssh -D` SOCKS5 + node-fetch v2

## Question

Why does a Telegram Bot API long-polling request (grammY, Node.js, `node-fetch` v2 +
`socks-proxy-agent`'s `SocksProxyAgent`, tunneled through an SSH `ssh -D` dynamic SOCKS5
forward) hang indefinitely with **no error at all** — no resolve, no reject, not even after
several minutes — while short requests (`getMe`, or `getUpdates` when updates are already
pending) succeed reliably through the same tunnel?

## TL;DR

There is no single "smoking gun" bug. The evidence — read directly from the source of every
component in the chain — supports a **two-part explanation**:

1. **Every layer of this specific stack has no active timeout on an already-established
   connection**, by default. `node-fetch` v2 defaults to `timeout: 0` (disabled).
   `socks-proxy-agent` only arms a socket timeout if you explicitly pass one (it doesn't by
   default). The underlying `socks` library's own 30s timeout applies only to the SOCKS5
   handshake and is cleared the moment the tunnel reaches the `established` state. grammY
   does have its own watchdog (`AbortController` + `setTimeout`), but it defaults to **500
   seconds** — far longer than the "several minutes" the reported hang was observed for. So
   a genuinely dead/stalled TCP stream, once past the SOCKS handshake, has **no code left
   anywhere in this call path that will ever notice and report it** until grammY's own
   500s watchdog eventually fires. This part is fully confirmed by reading the actual
   source of `node-fetch` v2, `socks-proxy-agent`, `socks`, and grammY.
2. **What actually kills the long-poll's TCP stream mid-flight is not confirmed by a
   primary source.** No OpenSSH documentation, mailing list, or issue tracker was found
   describing a bug where `ssh -D` silently drops a long-idle forwarded stream at a
   ~25–30s scale. All of the standard idle-timeout mechanisms that *are* documented
   (`TCPKeepAlive`, `ServerAliveInterval`, Linux `nf_conntrack`, OpenSSH's newer
   `ChannelTimeout`) either default to "off"/multi-hour timescales, or (for `ChannelTimeout`)
   aren't even present in the OpenSSH client version Debian 12 ships. This is the part of
   the investigation that stayed a hypothesis rather than becoming a confirmed fact —
   diagnosing it further needs a packet capture on the tunnel during a live hang, not more
   documentation reading.

**Practical takeaway:** regardless of which exact network event breaks the tunnel, the fix
that is unambiguously correct and directly supported by source-level evidence is to make
sure *something* in the request path has a timeout shorter than "500 seconds and hope,"
so a stalled poll turns into a catchable error within tens of seconds instead of hanging
silently.

---

## Root-cause hypotheses, ranked by likelihood

### 1. (Most likely) No timeout is active anywhere in the stack once the SOCKS tunnel is established — a stalled/dead connection is architecturally invisible to the application

**Evidence (all primary, read directly from source):**

- `node-fetch` v2's `Request` constructor: `timeout: init.timeout || input.timeout || 0` — a
  value of `0` means "no timeout," and nothing else in `node-fetch` v2 imposes one.
  Source: [`node-fetch` 2.x `src/request.js`](https://github.com/node-fetch/node-fetch/blob/2.x/src/request.js).
- `socks-proxy-agent`'s constructor: `this.timeout = opts?.timeout ?? null;` — if the
  caller (grammY, via `baseFetchConfig.agent`) doesn't pass a `timeout` option, this stays
  `null`. In `connect()`, the socket-level timeout is only armed conditionally:
  `if (timeout !== null) { socket.setTimeout(timeout); socket.on('timeout', () => cleanup()); }`
  — so with the default config, **no `socket.setTimeout()` call ever happens** on the
  established socket. Source:
  [`proxy-agents/packages/socks-proxy-agent/src/index.ts`](https://github.com/TooTallNate/proxy-agents/blob/main/packages/socks-proxy-agent/src/index.ts).
- The underlying `socks` npm library (`JoshGlazebrook/socks`, which `socks-proxy-agent`
  delegates to) does have a `DEFAULT_TIMEOUT` of 30 seconds, but it is a **handshake-only**
  timeout: `const timer = setTimeout(() => this.onEstablishedTimeout(), this.options.timeout || DEFAULT_TIMEOUT);`
  and `onEstablishedTimeout()` only tears the connection down if the state is *not* already
  `established`. Once the SOCKS5 `CONNECT` completes, this timer's job is done and nothing
  replaces it. Source:
  [`socks/src/client/socksclient.ts`](https://github.com/JoshGlazebrook/socks/blob/master/src/client/socksclient.ts).
- grammY's own client **does** have a watchdog: `timeoutSeconds: options.timeoutSeconds ?? 500`,
  implemented with `createTimeout(controller, opts.timeoutSeconds, method)` wrapping an
  `AbortController` around the `fetch` call. Default is 500 seconds (grammY's docs note this
  intentionally matches the hard 500s cap of the official Bot API server itself). This
  watchdog is real and will eventually fire — but the reported hang was observed for only
  "several minutes," well under 500s, so its absence during the observation window is
  exactly what the source predicts, not evidence that grammY itself is silently swallowing
  the failure. Source: [`grammY` `src/core/client.ts`](https://github.com/grammyjs/grammY/blob/main/src/core/client.ts).
- `node-fetch` v2 does correctly support `AbortSignal` (added ~v2.6.0): on `abort`, it calls
  `req.abort()` directly on the underlying `http`/`https` `ClientRequest`, which is a local,
  synchronous operation that does not require any response from the dead peer — so grammY's
  500s watchdog, once it does fire, should reliably turn the hang into a rejected promise
  (an `AbortError` / "Request to '...' timed out after 500 seconds"). Recommendation: leave
  the bot running past the 500s mark once to confirm this actually happens; if it *doesn't*,
  that would point to a different, deeper problem (see Hypothesis 3).
  Source: [`node-fetch` 2.x `src/index.js`](https://github.com/node-fetch/node-fetch/blob/2.x/src/index.js).

**Why this fits the symptom so well:** it explains *precisely* the asymmetry in the report.
`getMe` and an already-pending `getUpdates` both return before any of this matters — there's
no idle window during which a stalled/dead socket could go unnoticed, because data is
flowing (or immediately available) the whole time. A **genuinely idle** long-poll is the
only case that exercises the "connection is established but stalled and nothing is
watching it" code path, which is exactly the one case in the report that was never
verified to work.

**Corroborating (secondary but relevant) issue reports:**
- [`TooTallNate/node-socks-proxy-agent` #26](https://github.com/TooTallNate/node-socks-proxy-agent/issues/26)
  — a user found their Node process wouldn't exit because "the underlying socket used by
  `socks` remains open for the default timeout of 30s" even after the agent's own timeout
  fired, and had to manually pass `timeout` through to the `socks` client to fix it. This is
  the same "nobody is watching the established socket by default" gap, from the
  library's own (now-archived) first-party issue tracker.
- [`TooTallNate/node-socks-proxy-agent` #68](https://github.com/TooTallNate/node-socks-proxy-agent/issues/68)
  — a 2021 feature request asking for `keepAlive` support on the agent, closed with no
  maintainer fix; the repo was archived in May 2023 and folded into the `proxy-agents`
  monorepo, whose current source (checked above) still does not set any default timeout or
  keepAlive behavior. Not the same bug, but reinforces that socket-lifecycle edge cases in
  this specific library have a history of going unaddressed.
- [`openclaw/openclaw` #56061](https://github.com/openclaw/openclaw/issues/56061) — a
  first-party GitHub issue from a **different** (non-grammY) Telegram bot framework,
  describing the exact same generic failure class: `getUpdates` hangs indefinitely because
  the configured `timeout: 30` is "the Telegram API hold time, NOT a socket-level read
  timeout," so when the TCP connection dies without FIN/RST, "Node's fetch/http client waits
  indefinitely." The maintainer's fix, confirmed shipped in that project's `2026.3.22`
  release, was to add an explicit **45-second hard timeout** on `getUpdates` specifically
  (5–15s longer than the 30s poll) via an aborting wrapper around the fetch call. This is
  not evidence about SSH/SOCKS5 specifically — that project doesn't use an SSH tunnel — but
  it is a real, closed-as-fixed, first-party confirmation that "long-poll hangs forever with
  no error because nothing times out the socket" is a recurring, well-understood failure
  mode for Telegram long-polling in Node in general, and that a tight explicit timeout is
  the accepted fix pattern for it.

### 2. (Plausible, not confirmed) Something on the tunnel path silently breaks the idle TCP stream without sending FIN/RST

No primary source was found that pins this on a specific, named defect. What was checked
and ruled in/out:

- **OpenSSH `ChannelTimeout`** — the one OpenSSH feature that explicitly closes
  long-idle forwarded channels — is opt-in (disabled unless configured) and was only added
  to `sshd` in OpenSSH 9.2 (Feb 2023) and to the **ssh client** in 9.6 (Dec 2023). Debian 12
  "bookworm" ships `openssh-client 1:9.2p1-2+deb12u10`
  ([packages.debian.org](https://packages.debian.org/bookworm/openssh-client)) — i.e. the
  client binary running this tunnel **predates `ChannelTimeout` entirely** and cannot be
  invoking it even by accident. Source:
  [OpenSSH 9.6 release notes](https://www.openssh.com/txt/release-9.6) /
  [OpenSSH release notes index](https://www.openssh.com/releasenotes.html).
- **`TCPKeepAlive`** (`ssh_config`, default `yes`) only enables the OS's `SO_KEEPALIVE` on
  the socket; the actual probe timing comes from Linux sysctls
  `tcp_keepalive_time` (default **7200s** / 2h), `tcp_keepalive_intvl` (default 75s), and
  `tcp_keepalive_probes` (default 9) — i.e. even in the worst case this mechanism wouldn't
  report a dead connection for roughly 2 hours, nowhere near the observed timescale of
  minutes. Source: [`man7.org tcp(7)`](https://man7.org/linux/man-pages/man7/tcp.7.html).
- **`ServerAliveInterval`** (`ssh_config`) defaults to `0` (disabled) — by default, `ssh`
  does nothing proactive to detect that its peer has gone silent. Source:
  [`man.openbsd.org ssh_config(5)`](https://man.openbsd.org/ssh_config).
- **SOCKS5 itself (RFC 1928)** is silent on idle-connection timeouts. The only
  time-bound requirement in the RFC concerns *failure* replies ("the SOCKS server MUST
  terminate the TCP connection shortly after sending the reply... no more than 10 seconds
  after detecting the condition that caused a failure") — nothing about how long an
  established, silent relay must be kept open. Source:
  [RFC 1928](https://www.rfc-editor.org/rfc/rfc1928).
- **Docker's `host.docker.internal` / `extra_hosts: host-gateway`** just resolves a
  hostname to the host's bridge-gateway IP; the resulting container→host TCP connection is
  tracked by the host's own Linux `nf_conntrack`, whose default established-TCP timeout is
  on the order of days, not seconds — not a plausible source of a sub-minute cutoff.
- No OpenSSH mailing list thread, `openssh-portable` GitHub issue, or Server Fault/Stack
  Overflow report was found that specifically describes `ssh -D` dropping a genuinely-idle
  forwarded stream at a ~25–30s scale. Related-but-different reports that surfaced instead:
  `ssh -D` blocking on slow/unresponsive DNS lookups
  ([Linode community](https://www.linode.com/community/questions/7117/ssh-d-tunnel-blocks-on-slow-or-unresponsive-dns-servers)),
  and unrelated dynamic-forwarding crash/hang bugs in other SSH implementations (Teleport's
  `tsh`, not OpenSSH). Neither matches this symptom closely enough to cite as the cause.

**Assessment:** given the report says the hang happens on essentially the very first idle
long-poll (not "after N successful cycles, then it starts failing"), a generic multi-minute
NAT/conntrack idle-eviction theory doesn't fit the timing either — those thresholds are
typically 60s–5 days, not "fails on attempt #1 at the 25–30s mark." Nothing in the
documentation surveyed here explains a clean, first-attempt cutoff at that specific
timescale. This part of the question is **not resolved** by this research pass; a packet
capture (`tcpdump` on the VPS's public interface and on the container's `veth`) taken during
a live hang, showing whether any FIN/RST/retransmission traffic occurs at all, is the next
concrete diagnostic step.

### 3. (Low likelihood, worth ruling out) A bug specific to `node-fetch` v2 + a proxy `agent` that prevents the request from ever being sent/flushed

Searches surfaced various `node-fetch`/proxy-agent "socket hang up" and timeout-not-working
issues (e.g. a "Timeout doesn't work with node-fetch" report against
`TooTallNate/proxy-agents`, and `node-fetch/node-fetch` issue #494 "socket hang up... when I
hit my GET request using node-fetch"), but none of the ones found describe a **silent,
error-free** hang — they describe explicit `ECONNRESET`/"socket hang up" *errors*, which is
a different (and, per this report, absent) symptom. This weakens rather than supports this
hypothesis as the explanation for a hang with literally no error surfaced. Ranked lowest
because it isn't well corroborated by matching symptoms in the sources found.

---

## Recommended fixes

Ranked by how directly they address the confirmed gap (Hypothesis 1) vs. the unconfirmed
one (Hypothesis 2). Each is attributed to the source that recommends or demonstrates it.

1. **Give the SOCKS agent itself an explicit idle timeout**, e.g.
   `new SocksProxyAgent(url, { timeout: 40_000 })`. Per `socks-proxy-agent`'s own source,
   this both (a) is forwarded to the `socks` library's handshake timeout and (b) — more
   importantly — causes `socks-proxy-agent` to call `socket.setTimeout(timeout)` on the
   **established** socket, which is the exact code path that is skipped by default.
   *Attributed to:* reading
   [`proxy-agents/packages/socks-proxy-agent/src/index.ts`](https://github.com/TooTallNate/proxy-agents/blob/main/packages/socks-proxy-agent/src/index.ts)
   directly, and the pattern requested (and confirmed working) in
   [`TooTallNate/node-socks-proxy-agent` #26](https://github.com/TooTallNate/node-socks-proxy-agent/issues/26)
   ("we just have to pass the `timeout` property to the socks client").

2. **Pass an explicit `timeout` in `node-fetch` v2's request options** (via
   `baseFetchConfig`, since `Request`'s constructor reads `init.timeout` directly) shorter
   than grammY's 500s default — e.g. 45s for a 30s poll — so a stalled request surfaces as a
   `FetchError` instead of relying solely on the agent-level timeout above.
   *Attributed to:* reading
   [`node-fetch` 2.x `src/request.js`](https://github.com/node-fetch/node-fetch/blob/2.x/src/request.js)
   (`timeout: init.timeout || input.timeout || 0`).

3. **Lower grammY's own `client.timeoutSeconds`** from the 500s default to something close
   to the poll timeout plus margin (e.g. `new Bot(token, { client: { timeoutSeconds: 45 } })` —
   confirm the exact config key against the installed grammY version), so grammY's built-in
   `AbortController` watchdog fires in tens of seconds instead of 500. *Attributed to:*
   grammY's own [`src/core/client.ts`](https://github.com/grammyjs/grammY/blob/main/src/core/client.ts)
   default (`timeoutSeconds: options.timeoutSeconds ?? 500`), and directly corroborated by
   [`openclaw/openclaw` #56061](https://github.com/openclaw/openclaw/issues/56061), whose
   maintainer closed the issue as fixed after shipping exactly this pattern — a **45-second
   hard timeout** wrapped around `getUpdates` for a 30-second poll — in a structurally
   identical Telegram-long-poll-through-flaky-network scenario (different project, not
   SSH/SOCKS-specific, but the same underlying "no socket-level timeout" defect and fix).

4. **Tune the `ssh -D` tunnel's liveness detection**: set `ServerAliveInterval 15` and
   `ServerAliveCountMax 3` (client disconnects after ~45s of the server not answering
   protocol-level keepalive requests) on the systemd-managed `ssh -N -D` invocation, and
   confirm `TCPKeepAlive yes` (the default) is not disabled. This won't necessarily explain
   *why* the stream dies, but it bounds how long a genuinely-dead SSH session can sit
   silently un-detected, converting a silent multi-minute (or longer) stall into a
   `ssh` client exit within under a minute, which — because it also tears down the local
   `:1080` listener/connection — should propagate as a socket error to the Node process
   instead of an indefinite hang. *Attributed to:*
   [`man.openbsd.org ssh_config(5)`](https://man.openbsd.org/ssh_config) documentation for
   `ServerAliveInterval`/`ServerAliveCountMax`/`TCPKeepAlive` (this is a direct application
   of the documented option semantics, not a fix anyone else was found explicitly
   recommending for this exact bug pattern).

5. **Consider switching from `node-fetch` v2 + `socks-proxy-agent` to Node's native `fetch`
   (undici) with undici's own `Socks5ProxyAgent`.** Undici's `Client` applies finite
   defaults — `headersTimeout: 300_000` and `bodyTimeout: 300_000` (5 minutes) — out of the
   box, unlike `node-fetch` v2's `timeout: 0` (disabled). Undici also ships a native
   `Socks5ProxyAgent` dispatcher (marked *Experimental* as of the version checked) that
   removes the `socks-proxy-agent`/`agent-base` layer entirely.
   *Attributed to:* reading
   [`undici` `lib/dispatcher/client.js`](https://github.com/nodejs/undici/blob/main/lib/dispatcher/client.js)
   directly for the timeout defaults, and the
   [undici `Socks5ProxyAgent` docs](https://undici.nodejs.org/api/Socks5ProxyAgent) for the
   built-in SOCKS5 support. Caveat: this repo's own investigation already confirmed grammY's
   Node shim uses `node-fetch` v2 internally (per `grammy/out/shim.node.js`), so adopting
   this would mean overriding grammY's `fetch` implementation via its documented advanced
   configuration rather than a drop-in change — not verified end-to-end here.

6. **(Unattributed engineering judgment, not a sourced fix)** If the tunnel needs to be a
   long-lived, always-on service rather than an ad hoc `ssh -D`, a purpose-built SOCKS5
   daemon (Dante, microsocks) run as its own systemd service is a more conventional choice
   for that use case than repurposing `ssh -N -D`. No primary source was found asserting
   that this specifically fixes the hang described here — this is general engineering
   practice, flagged explicitly as such rather than as a confirmed fix.

7. **Verify Hypothesis 1's prediction directly**: leave the current setup running
   unmodified past the 500-second mark on a single stuck poll and confirm grammY's own
   watchdog does eventually reject with a timeout error. If it does, that's strong
   confirmatory evidence for Hypothesis 1 (nothing lower in the stack was ever going to
   fire) and validates fixes #1–#3 above as sufficient. If it does *not* error even past
   500s, that would falsify part of Hypothesis 1 and point instead to `req.abort()` itself
   getting stuck on a sufficiently broken socket — in which case the network-layer
   diagnosis in Hypothesis 2 (packet capture) becomes the priority.

---

## Sources

**Primary (official docs, source code, specs, first-party issue trackers):**

- [`node-fetch` 2.x `src/request.js`](https://github.com/node-fetch/node-fetch/blob/2.x/src/request.js) — default `timeout: 0`.
- [`node-fetch` 2.x `src/index.js`](https://github.com/node-fetch/node-fetch/blob/2.x/src/index.js) — `AbortSignal` handling, `req.abort()`.
- [`proxy-agents/packages/socks-proxy-agent/src/index.ts`](https://github.com/TooTallNate/proxy-agents/blob/main/packages/socks-proxy-agent/src/index.ts) — default `timeout: null`, conditional `socket.setTimeout()`.
- [`proxy-agents/packages/agent-base/src/index.ts`](https://github.com/TooTallNate/proxy-agents/blob/main/packages/agent-base/src/index.ts) — base `Agent` class, no default keep-alive/timeout handling.
- [`socks/src/client/socksclient.ts`](https://github.com/JoshGlazebrook/socks/blob/master/src/client/socksclient.ts) — `DEFAULT_TIMEOUT` (30s), handshake-only scope.
- [`grammY` `src/core/client.ts`](https://github.com/grammyjs/grammY/blob/main/src/core/client.ts) — `timeoutSeconds: options.timeoutSeconds ?? 500`, `createTimeout`/`AbortController` watchdog.
- [grammy.dev/advanced/proxy](https://grammy.dev/advanced/proxy) — official grammY proxy configuration guidance; explicitly states "Getting a proxy to work can be difficult."
- [`man.openbsd.org ssh_config(5)`](https://man.openbsd.org/ssh_config) — `TCPKeepAlive` (default yes), `ServerAliveInterval` (default 0), `ServerAliveCountMax` (default 3).
- [OpenSSH release notes index](https://www.openssh.com/releasenotes.html) and [OpenSSH 9.6 release notes](https://www.openssh.com/txt/release-9.6) — `ChannelTimeout` added to `sshd` in 9.2, to the `ssh` client in 9.6.
- [packages.debian.org — `openssh-client` in bookworm](https://packages.debian.org/bookworm/openssh-client) — Debian 12 ships `openssh-client 1:9.2p1-2+deb12u10` (predates client-side `ChannelTimeout`).
- [`man7.org tcp(7)`](https://man7.org/linux/man-pages/man7/tcp.7.html) — Linux `tcp_keepalive_time` (7200s default), `tcp_keepalive_intvl` (75s), `tcp_keepalive_probes` (9).
- [RFC 1928 — SOCKS Protocol Version 5](https://www.rfc-editor.org/rfc/rfc1928) — silent on idle-connection timeouts; only specifies a 10s teardown bound after a *failure* reply.
- [Telegram Bot API — `getUpdates`](https://core.telegram.org/bots/api#getupdates) — `timeout` parameter semantics ("Timeout in seconds for long polling. Defaults to 0... short polling should be used for testing purposes only").
- [`TooTallNate/node-socks-proxy-agent` #26](https://github.com/TooTallNate/node-socks-proxy-agent/issues/26) — first-party issue confirming sockets stay open past the agent's own timeout unless `timeout` is passed through to the `socks` client.
- [`TooTallNate/node-socks-proxy-agent` #68](https://github.com/TooTallNate/node-socks-proxy-agent/issues/68) — first-party `keepAlive` feature request, unresolved, repo archived.
- [`openclaw/openclaw` #56061](https://github.com/openclaw/openclaw/issues/56061) — first-party issue and fix (closed, shipped in `2026.3.22`) in a different Telegram-bot project describing and resolving the identical "long-poll hangs forever, no socket-level timeout" failure class.
- [`undici` `lib/dispatcher/client.js`](https://github.com/nodejs/undici/blob/main/lib/dispatcher/client.js) — default `headersTimeout`/`bodyTimeout` of 300,000ms.
- [undici `Socks5ProxyAgent` docs](https://undici.nodejs.org/api/Socks5ProxyAgent) — native SOCKS5 dispatcher for undici/native `fetch`.

**Secondary (corroborating, not sole citation for any claim):**

- [Linode Community — "ssh -D tunnel blocks on slow or unresponsive DNS servers"](https://www.linode.com/community/questions/7117/ssh-d-tunnel-blocks-on-slow-or-unresponsive-dns-servers) — related but distinct `ssh -D` hang mode (DNS, not idle-stream).
- [DigitalOcean Community — "Socks5 proxy requests stopped working"](https://www.digitalocean.com/community/questions/socks5-proxy-requests-stopped-working) — general SOCKS5 idle-timeout discussion, no primary citation given by the source itself.
- General web search summaries used only to locate the primary sources above, not cited as standalone evidence.

**Explicitly not confirmed:** no primary source was found describing a specific OpenSSH
`ssh -D` defect that silently drops a genuinely-idle forwarded stream at a ~25–30 second
timescale. This is flagged in Hypothesis 2 as an open question rather than asserted as fact.
