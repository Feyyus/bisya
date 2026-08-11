/**
 * ActionCodec
 *
 * Encodes/decodes Telegram inline-button `callback_data` strings.
 *
 * Format: `action:arg1:arg2:...` (colon-separated, action first).
 * Example: `encode('guess', 42, 7)` -> `"guess:42:7"`.
 *
 * Telegram enforces a hard 64-byte limit on `callback_data` (measured in
 * UTF-8 bytes, not characters). `sendMessage`/`editMessageReplyMarkup` calls
 * fail at call time with an opaque Bad Request error if any button exceeds
 * it. `encode()` guards against this by throwing eagerly, at the point the
 * offending action was built, so the failure is traceable to its cause
 * instead of surfacing later as a generic Telegram API error.
 */
export class ActionCodec {
  /**
   * Builds a `callback_data` string from an action name and its arguments.
   *
   * @throws {Error} if the encoded string exceeds Telegram's 64-byte limit.
   */
  encode(action: string, ...args: (string | number | bigint)[]): string {
    const data = [action, ...args.map(String)].join(':');
    const byteLength = Buffer.byteLength(data, 'utf8');
    if (byteLength > 64) {
      throw new Error(`callback_data exceeds 64 bytes: "${data}" (${byteLength} bytes)`);
    }
    return data;
  }

  /**
   * Reverses `encode()`: splits `callback_data` on `:` into an action name
   * and its remaining arguments (always strings - callers are responsible
   * for parsing numeric args back out).
   *
   * Returns `null` for empty/falsy input or input with no action segment
   * (e.g. a string starting with `:`).
   */
  decode(data: string): { action: string; args: string[] } | null {
    if (!data) return null;
    const [action, ...args] = data.split(':');
    if (!action) return null;
    return { action, args };
  }
}
