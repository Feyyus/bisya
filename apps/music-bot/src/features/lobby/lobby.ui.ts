import { MusicGameStatus, User } from "@bisya/db";
import type { InlineKeyboardButton } from "grammy/types";
import type { GameConfigInput } from "../../repository/music-game.repository";

/**
 * Ported from bschat-bot's `src/modules/musicGame/features/lobby/lobby.ui.ts`.
 *
 * Pure object/keyboard/text construction - no framework imports survive the
 * port. The original imported `InlineKeyboardButton` from
 * `telegraf/typings/core/types/typegram`; grammY's `grammy/types` re-exports
 * the same Telegram Bot API shape, so that's a same-name swap, not a rewrite.
 *
 * The original also imported `GameConfig` from a zod schema module
 * (`src/modules/musicGame/config/game-config.ts`) that hasn't been ported
 * into music-bot yet (see the `TODO(GameConfig)` note in
 * `music-game.service.ts`, which already worked around the same gap with an
 * inline `Required<GameConfigInput>` stand-in). `LobbyGameConfig` below is
 * that same stand-in, defined locally so this file doesn't need to import
 * from `music-game.service.ts` just for a type. Swap both for the real
 * `GameConfig` once that module lands.
 */
export type LobbyGameConfig = Required<GameConfigInput>;

/** Slice of `User` the lobby panel needs to render a "who's ready" list. */
export type ReadyPlayer = Pick<User, "id" | "name" | "tag">;

export class LobbyUi {
  /**
   * Generate lobby keyboard with action buttons.
   */
  lobbyKeyboard(actions: { start: string; settings: string; info: string; players: string }) {
    return {
      inline_keyboard: [
        [
          { text: "🎮 Start Game", callback_data: actions.start },
          { text: "⚙️ Settings", callback_data: actions.settings },
        ],
        [
          { text: "📊 Game Info", callback_data: actions.info },
          { text: "👥 Players", callback_data: actions.players },
        ],
      ],
    };
  }

  /**
   * Lobby panel text: game status plus who's submitted a track so far. New
   * relative to the old lobby.handler.ts, which hardcoded a static
   * "Choose an option" string with no readiness info - this is the piece
   * that actually lets the organizer "see who's ready" per the ticket.
   */
  lobbyText(status: MusicGameStatus | null, readyPlayers: ReadyPlayer[]): string {
    const statusLine =
      status === MusicGameStatus.ACTIVE
        ? "🟢 A game is currently in progress."
        : status === MusicGameStatus.LOBBY
          ? "🟡 Lobby open - waiting for the organizer to start."
          : "⚪ No game yet - waiting for players to submit tracks.";

    const readyLine = readyPlayers.length
      ? `✅ Ready (${readyPlayers.length}): ${readyPlayers
          .map((player) => (player.tag ? `${player.name} (@${player.tag})` : player.name))
          .join(", ")}`
      : "🚫 No one has submitted a track yet.";

    return `🎵 <b>Music Game Lobby</b>\n\n${statusLine}\n${readyLine}\n\nChoose an option:`;
  }

  /**
   * Generate settings panel keyboard.
   */
  settingsKeyboard(
    config: LobbyGameConfig,
    actions: {
      toggle: (key: string) => string;
      setPreset: (preset: string) => string;
      setDelay: (key: string, value: number) => string;
      back: string;
    },
  ) {
    // Helper to cycle through delay values
    const nextHintDelay =
      config.hintDelaySec === 30
        ? 60
        : config.hintDelaySec === 60
          ? 90
          : config.hintDelaySec === 90
            ? 120
            : 30;
    const nextAdvanceDelay =
      config.advanceDelaySec === 60 // 1 min
        ? 90 // 1.5 min
        : config.advanceDelaySec === 90
          ? 120 // 2 min
          : config.advanceDelaySec === 120
            ? 150 // 2.5 min
            : config.advanceDelaySec === 150
              ? 180 // 3 min (max)
              : 60; // Default to 1 min
    const nextPreset =
      config.scoringPreset === "classic"
        ? "aggressive"
        : config.scoringPreset === "aggressive"
          ? "gentle"
          : "classic";

    const buttons: InlineKeyboardButton[][] = [
      [
        {
          text: `⏱️ Hint Delay: ${this.formatDelay(config.hintDelaySec)} → ${this.formatDelay(nextHintDelay)}`,
          callback_data: actions.setDelay("hintDelaySec", nextHintDelay),
        },
      ],
      [
        {
          text: `⏭️ Auto Advance: ${config.autoAdvance ? "✅ ON" : "❌ OFF"}`,
          callback_data: actions.toggle("autoAdvance"),
        },
      ],
      config.autoAdvance
        ? [
            {
              text: `⏱️ Advance Delay: ${this.formatDelay(config.advanceDelaySec)} → ${this.formatDelay(nextAdvanceDelay)}`,
              callback_data: actions.setDelay("advanceDelaySec", nextAdvanceDelay),
            },
          ]
        : [],
      [
        {
          text: `🔀 Shuffle: ${config.shuffle ? "✅ ON" : "❌ OFF"}`,
          callback_data: actions.toggle("shuffle"),
        },
      ],
      [
        {
          text: `🎯 Scoring: ${config.scoringPreset} → ${nextPreset}`,
          callback_data: actions.setPreset(nextPreset),
        },
      ],
      [
        {
          text: `👤 Self Guess: ${config.allowSelfGuess ? "✅ ON" : "❌ OFF"}`,
          callback_data: actions.toggle("allowSelfGuess"),
        },
      ],
      [{ text: "🔙 Back to Lobby", callback_data: actions.back }],
    ];

    return {
      inline_keyboard: buttons.filter((row) => row.length > 0),
    };
  }

  /**
   * Format settings text.
   */
  settingsText(config: LobbyGameConfig): string {
    return `⚙️ <b>Game Settings</b>

⏱️ <b>Hint Delay:</b> ${this.formatDelay(config.hintDelaySec)}
⏭️ <b>Auto Advance:</b> ${config.autoAdvance ? "Enabled" : "Disabled"}
${config.autoAdvance ? `⏱️ <b>Advance Delay:</b> ${this.formatDelay(config.advanceDelaySec)}\n` : ""}🔀 <b>Shuffle:</b> ${config.shuffle ? "Enabled" : "Disabled"}
🎯 <b>Scoring Preset:</b> ${config.scoringPreset}
👤 <b>Allow Self Guess:</b> ${config.allowSelfGuess ? "Yes" : "No"}`;
  }

  /**
   * Generate players panel keyboard.
   */
  playersKeyboard(
    players: ReadyPlayer[],
    actions: {
      remove: (userId: string) => string;
      ping: string;
      back: string;
    },
  ) {
    const buttons: InlineKeyboardButton[][] = players.map((player) => [
      {
        text: `❌ ${player.name}`,
        callback_data: actions.remove(player.id.toString()),
      },
    ]);

    buttons.push([
      { text: "📢 Ping All", callback_data: actions.ping },
      { text: "🔙 Back to Lobby", callback_data: actions.back },
    ]);

    return {
      inline_keyboard: buttons,
    };
  }

  /**
   * Format players text.
   */
  playersText(players: ReadyPlayer[]): string {
    if (players.length === 0) {
      return "👥 <b>Players</b>\n\nNo players have submitted tracks yet.";
    }

    const playersList = players
      .map((player, index) => {
        const tag = player.tag ? `@${player.tag}` : "";
        return `${index + 1}. ${player.name}${tag ? ` ${tag}` : ""}`;
      })
      .join("\n");

    return `👥 <b>Players</b> (${players.length})

${playersList}

<i>Click on a player to remove their track</i>`;
  }

  /**
   * Format delay in seconds to human-readable format.
   */
  private formatDelay(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = seconds / 60;
    return `${minutes}min`;
  }
}
