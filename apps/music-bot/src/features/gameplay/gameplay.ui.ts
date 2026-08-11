import type { InlineKeyboardButton } from 'grammy/types';
import { ActionCodec } from '../../codec/action.codec';

/**
 * Gameplay UI - rendering for active game rounds.
 *
 * Ported from bschat-bot's
 * `src/modules/musicGame/features/gameplay/gameplay.ui.ts`. In the old
 * codebase this wasn't consumed by `GameplayHandler` at all - it was
 * injected into `MusicGameService` (via Inversify) and used there to render
 * the round-info message's control buttons (hint/replay/skip/reveal) after
 * each guess. This port keeps that shape: `GameplayHandler` doesn't call
 * `roundControls` either, it's exposed here as the standalone module the
 * acceptance criteria for issue #27 calls for.
 *
 * `apps/music-bot/src/services/music-game.service.ts` currently has its own
 * private, near-identical copy of `roundControls` (see the
 * `TODO(GameplayUi)` comment on that file, left by the ticket that ported
 * `MusicGameService`) instead of importing this class. Wiring that service
 * to use this module instead would touch `services/` and `container.ts`,
 * outside this ticket's `features/gameplay/` scope (kept clear so as not to
 * collide with the lobby/info/upload tickets running in parallel) - flagged
 * as a follow-up in the resolution comment on issue #27 rather than done
 * here.
 *
 * One deliberate difference from the old file: callback_data is built via
 * `ActionCodec.encode` (byte-length guard included) instead of hand-rolled
 * template strings, per this ticket's acceptance criteria.
 */
export class GameplayUi {
  constructor(private readonly codec: ActionCodec) {}

  /**
   * Round control buttons: hint-now, replay, skip, reveal - all keyed to
   * `roundId` so the gameplay callback-query handler can look up the right
   * round regardless of which control was pressed.
   */
  roundControls(roundId: number): InlineKeyboardButton[][] {
    return [
      [
        { text: '💡 Hint Now', callback_data: this.codec.encode('round_hint', roundId) },
        { text: '🔁 Replay', callback_data: this.codec.encode('round_replay', roundId) },
      ],
      [
        { text: '⏭️ Skip', callback_data: this.codec.encode('round_skip', roundId) },
        { text: '🏁 Reveal', callback_data: this.codec.encode('round_reveal', roundId) },
      ],
    ];
  }
}
