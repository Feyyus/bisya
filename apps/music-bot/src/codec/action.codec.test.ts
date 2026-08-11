import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ActionCodec } from './action.codec.js';

describe('ActionCodec', () => {
  describe('round-trips for real action patterns', () => {
    // guess: round + answer, e.g. "guess:42:7"
    test('guess (round + answer)', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('guess', 42, 7);
      assert.equal(encoded, 'guess:42:7');
      assert.deepEqual(codec.decode(encoded), { action: 'guess', args: ['42', '7'] });
    });

    // lobby: start/join/leave (no-arg lobby transitions)
    test('lobby: start', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('lobby', 'start');
      assert.equal(encoded, 'lobby:start');
      assert.deepEqual(codec.decode(encoded), { action: 'lobby', args: ['start'] });
    });

    test('lobby: join', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('lobby', 'join');
      assert.equal(encoded, 'lobby:join');
      assert.deepEqual(codec.decode(encoded), { action: 'lobby', args: ['join'] });
    });

    test('lobby: leave', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('lobby', 'leave');
      assert.equal(encoded, 'lobby:leave');
      assert.deepEqual(codec.decode(encoded), { action: 'lobby', args: ['leave'] });
    });

    // settings: config toggles/presets/delays
    test('settings: toggle a config key', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('settings', 'toggle', 'explicitLyrics');
      assert.equal(encoded, 'settings:toggle:explicitLyrics');
      assert.deepEqual(codec.decode(encoded), {
        action: 'settings',
        args: ['toggle', 'explicitLyrics'],
      });
    });

    test('settings: apply a preset', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('settings', 'preset', 'hard');
      assert.deepEqual(codec.decode(encoded), { action: 'settings', args: ['preset', 'hard'] });
    });

    test('settings: set a numeric delay', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('settings', 'delay', 'hintDelay', 5);
      assert.equal(encoded, 'settings:delay:hintDelay:5');
      assert.deepEqual(codec.decode(encoded), {
        action: 'settings',
        args: ['delay', 'hintDelay', '5'],
      });
    });

    // players: list/kick
    test('players: list', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('players', 'list');
      assert.deepEqual(codec.decode(encoded), { action: 'players', args: ['list'] });
    });

    test('players: kick a specific player', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('players', 'kick', 123456789);
      assert.equal(encoded, 'players:kick:123456789');
      assert.deepEqual(codec.decode(encoded), {
        action: 'players',
        args: ['kick', '123456789'],
      });
    });

    // gameplay: advance/hint/end a round
    test('gameplay: advance a round', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('round', 'advance', 42);
      assert.deepEqual(codec.decode(encoded), { action: 'round', args: ['advance', '42'] });
    });

    test('gameplay: request a hint for a round', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('round', 'hint', 42);
      assert.equal(encoded, 'round:hint:42');
      assert.deepEqual(codec.decode(encoded), { action: 'round', args: ['hint', '42'] });
    });

    test('gameplay: end a round', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('round', 'end', 42);
      assert.deepEqual(codec.decode(encoded), { action: 'round', args: ['end', '42'] });
    });

    // bigint args (e.g. Telegram user/chat IDs that may exceed Number range)
    test('supports bigint args', () => {
      const codec = new ActionCodec();
      const encoded = codec.encode('guess', 42, 9007199254740993n);
      assert.equal(encoded, 'guess:42:9007199254740993');
      assert.deepEqual(codec.decode(encoded), {
        action: 'guess',
        args: ['42', '9007199254740993'],
      });
    });
  });

  describe('decode edge cases', () => {
    test('returns null for empty string', () => {
      const codec = new ActionCodec();
      assert.equal(codec.decode(''), null);
    });

    test('returns null when there is no action segment', () => {
      const codec = new ActionCodec();
      assert.equal(codec.decode(':start'), null);
    });

    test('returns an empty args array for an action with no arguments', () => {
      const codec = new ActionCodec();
      assert.deepEqual(codec.decode('lobby'), { action: 'lobby', args: [] });
    });
  });

  describe('B4: byte-length guard', () => {
    test('encode throws when the encoded callback_data exceeds 64 bytes', () => {
      const codec = new ActionCodec();
      const longArg = 'x'.repeat(64);
      assert.throws(
        () => codec.encode('settings', 'toggle', longArg),
        /callback_data exceeds 64 bytes/,
      );
    });

    test('error message names the offending action and its actual byte length', () => {
      const codec = new ActionCodec();
      const longArg = 'y'.repeat(64);
      const expectedData = `settings:toggle:${longArg}`;
      const expectedBytes = Buffer.byteLength(expectedData, 'utf8');

      assert.throws(
        () => codec.encode('settings', 'toggle', longArg),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, new RegExp(`^callback_data exceeds 64 bytes: "${expectedData}"`));
          assert.match(err.message, new RegExp(`\\(${expectedBytes} bytes\\)$`));
          return true;
        },
      );
    });

    test('encode does not throw at exactly 64 bytes (boundary)', () => {
      const codec = new ActionCodec();
      // 'guess:' (6 bytes) + 58 'a's = exactly 64 bytes
      const arg = 'a'.repeat(58);
      const encoded = codec.encode('guess', arg);
      assert.equal(Buffer.byteLength(encoded, 'utf8'), 64);
    });

    test('accounts for multi-byte UTF-8 characters, not just character count', () => {
      const codec = new ActionCodec();
      // Each '你' is 3 bytes in UTF-8. 20 of them = 60 bytes, plus "guess:" (6 bytes) = 66 bytes,
      // which exceeds 64 even though the character count (26) looks small.
      const arg = '你'.repeat(20);
      assert.throws(() => codec.encode('guess', arg), /callback_data exceeds 64 bytes/);
    });
  });
});
