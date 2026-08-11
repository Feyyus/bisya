import axios from "axios";

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

/**
 * Cached photo entry with expiration
 */
interface CacheEntry {
  url: string;
  author?: string;
  expiresAt: number;
}

/**
 * In-memory cache for photo URLs (1-hour TTL)
 */
const photoCache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 2;
const UNSPLASH_BASE_URL = "https://api.unsplash.com/photos/random";

/**
 * Fetches a random photo from Unsplash for the given search query
 * Implements caching and retry logic
 */
async function fetchPhoto(
  searchQuery: string
): Promise<{ url: string; author?: string } | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    console.error("UNSPLASH_ACCESS_KEY environment variable is not set");
    return null;
  }

  // Check cache first
  const cached = photoCache.get(searchQuery);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`Using cached photo for: ${searchQuery}`);
    return { url: cached.url, author: cached.author };
  }

  // Remove expired cache entry
  if (cached) {
    photoCache.delete(searchQuery);
  }

  // Fetch from API with retries
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<UnsplashPhoto>(UNSPLASH_BASE_URL, {
        params: {
          query: searchQuery,
          client_id: accessKey,
        },
      });

      const photo = response.data;

      if (!photo.urls?.regular && !photo.urls?.small) {
        console.error("Invalid Unsplash response: missing URLs");
        return null;
      }

      const photoUrl = photo.urls.regular || photo.urls.small;
      const author = photo.user?.name || photo.user?.username;

      // Cache the result
      photoCache.set(searchQuery, {
        url: photoUrl,
        author,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

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

/**
 * Clears expired cache entries
 */
function clearExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of photoCache.entries()) {
    if (entry.expiresAt <= now) {
      photoCache.delete(key);
    }
  }
}

export const UnsplashService = {
  fetchPhoto,
  generateCaption,
  clearExpiredCache,
};
