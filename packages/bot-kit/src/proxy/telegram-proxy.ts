import * as https from "https";
import { BotConfig, Context } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";

/**
 * A minimal Fetch-API-compatible wrapper around Node's raw https.request,
 * used instead of node-fetch v2 (grammY's default Node client) when
 * proxying through a custom Agent.
 *
 * node-fetch v2's fetch() wrapper doesn't reliably propagate abort/timeout
 * signals down into a custom agent's connect() (confirmed by reading
 * socks-proxy-agent's source: the SocksClient.createConnection() call it
 * awaits has no cancellation path at all), so a stalled SOCKS handshake
 * just hangs forever regardless of any timeout set elsewhere. Telegraf,
 * proven working in production through this exact tunnel/agent (see
 * bschat-bot), passes the agent straight to https.request() with no such
 * wrapper - this mirrors that. Full writeup:
 * docs/research/ssh-socks5-longpoll-hang.md (in the music-guess-bot repo).
 */
function createHttpsFetch(agent: https.Agent): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { hostname, pathname, search } = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body as string | undefined;

    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          agent,
          hostname,
          path: pathname + search,
          method,
          headers,
          // Longer than the short long-poll window callers should request via
          // bot.start({ timeout: 10 }), so a healthy empty poll never trips
          // this - only a genuinely stalled connection does.
          timeout: 25000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const responseBody = Buffer.concat(chunks);
            resolve(
              new Response(responseBody, {
                status: res.statusCode,
                headers: res.headers as Record<string, string>,
              })
            );
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("Request timed out after 25 seconds"));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }) as typeof fetch;
}

/**
 * Builds grammY's `client` config for a bot that needs to reach Telegram
 * through an SSH SOCKS5 tunnel - the homelab this bot family deploys to has
 * Telegram (and other services) blocked at the network level.
 *
 * Returns `undefined` when `proxyHost` isn't set, so callers can spread this
 * straight into `new Bot(token, { client: buildTelegramProxyClientConfig(...) })`
 * unconditionally and get grammY's normal direct-connection behavior for
 * local dev (where Telegram isn't blocked).
 */
export function buildTelegramProxyClientConfig<C extends Context>(
  proxyHost: string | undefined,
  proxyPort: string = "1080"
): BotConfig<C>["client"] {
  if (!proxyHost) return undefined;

  const socksAgent = new SocksProxyAgent(`socks5://${proxyHost}:${proxyPort}`);
  console.log(`Routing Telegram API calls through SOCKS5 proxy at ${proxyHost}:${proxyPort}`);

  return {
    // grammY's default node-fetch v2 client doesn't propagate cancellation
    // into a custom agent's connect(), so a stalled SOCKS handshake hangs
    // forever no matter what timeout is set elsewhere. See createHttpsFetch
    // above.
    fetch: createHttpsFetch(socksAgent),
    timeoutSeconds: 30,
  };
}
