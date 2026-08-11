import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";

/**
 * Unsplash photo data structure
 */
interface UnsplashPhoto {
  urls: {
    small: string;
    regular: string;
  };
  user?: {
    name: string;
    username: string;
  };
}

const MAX_RETRIES = 2;
const UNSPLASH_BASE_URL = "https://api.unsplash.com/photos/random";
const REQUEST_TIMEOUT_MS = 15000;

// api.unsplash.com is unreachable directly from the homelab network, same
// as Telegram - route through the same SSH SOCKS5 tunnel when configured.
// axios's own httpAgent/httpsAgent support (unlike grammY's default
// node-fetch client) has no known abort-propagation issue, so this can use
// axios directly rather than needing a raw https.request wrapper.
const proxyHost = process.env.TELEGRAM_PROXY_HOST;
const proxyPort = process.env.TELEGRAM_PROXY_PORT ?? "1080";
const socksAgent = proxyHost
  ? new SocksProxyAgent(`socks5://${proxyHost}:${proxyPort}`)
  : undefined;

/**
 * Fetches a fresh random photo from Unsplash for the given search query
 */
async function fetchPhoto(
  searchQuery: string
): Promise<{ url: string; author?: string } | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    console.error("UNSPLASH_ACCESS_KEY environment variable is not set");
    return null;
  }

  // Fetch from API with retries
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<UnsplashPhoto>(UNSPLASH_BASE_URL, {
        params: {
          query: searchQuery,
          client_id: accessKey,
        },
        httpsAgent: socksAgent,
        timeout: REQUEST_TIMEOUT_MS,
      });

      const photo = response.data;

      if (!photo.urls?.regular && !photo.urls?.small) {
        console.error("Invalid Unsplash response: missing URLs");
        return null;
      }

      const photoUrl = photo.urls.regular || photo.urls.small;
      const author = photo.user?.name || photo.user?.username;

      return { url: photoUrl, author };
    } catch (err) {
      const error = err as axios.AxiosError | Error;

      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          // Rate limited
          console.error("Unsplash API rate limit exceeded");
          return null;
        }
        if (error.response?.status === 401) {
          // Unauthorized
          console.error("Unsplash API unauthorized");
          return null;
        }
      }

      console.error(
        `Attempt ${attempt + 1} to fetch Unsplash photo failed:`,
        error
      );

      if (attempt < MAX_RETRIES) {
        // Wait before retrying (exponential backoff: 500ms, 1000ms)
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt))
        );
      }
    }
  }

  console.error(`Failed to fetch photo from Unsplash after ${MAX_RETRIES + 1} attempts`);
  return null;
}

/**
 * Generates a caption for the photo with attribution
 */
function generateCaption(trigger: string, author?: string): string {
  let caption = `Found: 🍕 ${trigger}`;

  if (author) {
    caption += `\n📸 Photo by ${author} on Unsplash`;
  }

  return caption;
}

export const UnsplashService = {
  fetchPhoto,
  generateCaption,
};
