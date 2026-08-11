import {
  GameStatus,
  Guess,
  Prisma,
  RoundPhase,
  ScoringPreset,
  User,
  prisma as defaultPrisma,
} from '@bisya/db';

const roundWithGuesses = Prisma.validator<Prisma.GameRoundInclude>()({
  guesses: {
    include: {
      user: true,
    },
  },
  user: true,
  game: true,
});

const gameWithData = Prisma.validator<Prisma.GameInclude>()({
  rounds: {
    include: roundWithGuesses,
  },
});

export type GameWithData = Prisma.GameGetPayload<{
  include: typeof gameWithData;
}>;

export type RoundWithGuesses = Prisma.GameRoundGetPayload<{
  include: typeof roundWithGuesses;
}>;

// Prisma's `$transaction(async (tx) => ...)` callback doesn't infer `tx`'s
// type through a `private readonly prisma = defaultPrisma` constructor
// default parameter, so it needs an explicit annotation (same workaround as
// packages/wallet/src/wallet.service.ts).
type TransactionClient = Prisma.TransactionClient;

/**
 * TODO: `GameConfig` in the old bschat-bot codebase was a zod schema
 * (src/modules/musicGame/config/game-config.ts) that validated these same
 * fields and converted them to a Prisma update payload via
 * `gameConfigToPrisma`. That config module hasn't been ported into music-bot
 * yet (out of scope for this repository-layer ticket). This inline type
 * mirrors its shape so callers can pass game config through untyped for now;
 * replace it with the real `GameConfig` type (and reintroduce validation)
 * once that module is ported.
 */
export type GameConfigInput = Partial<{
  hintDelaySec: number;
  autoAdvance: boolean;
  advanceDelaySec: number;
  allowSelfGuess: boolean;
  shuffle: boolean;
  scoringPreset: ScoringPreset;
}>;

export class MusicGameRepository {
  constructor(private readonly prisma = defaultPrisma) {}

  async getGameById(id: number): Promise<GameWithData | null> {
    return this.prisma.game.findUnique({
      where: { id },
      include: gameWithData,
    });
  }

  async findRoundById(id: number): Promise<RoundWithGuesses | null> {
    return this.prisma.gameRound.findUnique({
      where: { id },
      include: roundWithGuesses,
    });
  }

  /**
   * B3 fix: the old implementation went through `Chat.activeGameId`/
   * `activeGame`, which could point at a stale/finished game, and fell back
   * to a second manual re-fetch (plus a pile of debug logging) to work
   * around that unreliability. `Chat.activeGameId` no longer exists in the
   * schema - this queries `Game.status` directly instead, which is the
   * source of truth and needs no re-fetch.
   */
  async getCurrentGameByChatId(chatId: number): Promise<GameWithData | null> {
    return this.prisma.game.findFirst({
      where: { chatId: BigInt(chatId), status: { in: [GameStatus.LOBBY, GameStatus.ACTIVE] } },
      orderBy: { createdAt: 'desc' },
      include: gameWithData,
    });
  }

  async endGame(gameId: number): Promise<void> {
    await this.prisma.$transaction(async (tx: TransactionClient) => {
      // Set all LIVE rounds to COMPLETED
      await tx.gameRound.updateMany({
        where: {
          gameId: gameId,
          phase: RoundPhase.LIVE,
        },
        data: {
          phase: RoundPhase.COMPLETED,
          endedAt: new Date(),
        },
      });

      // Update game status
      await tx.game.update({
        where: { id: gameId },
        data: {
          status: GameStatus.ENDED,
        },
      });
    });
  }

  async getRoundByDatabaseId(roundId: number): Promise<RoundWithGuesses | null> {
    return this.prisma.gameRound.findUnique({
      where: { id: roundId },
      include: roundWithGuesses,
    });
  }

  async getRoundBySequence(gameId: number, gameSequence: number) {
    return this.prisma.gameRound.findUnique({
      where: {
        gameId_sequence: {
          gameId: gameId,
          sequence: gameSequence,
        },
      },
      include: roundWithGuesses,
    });
  }

  /**
   * Creates an empty LOBBY game for a chat
   */
  async createEmptyLobby(chatId: number): Promise<GameWithData> {
    const game = await this.prisma.game.create({
      data: {
        status: GameStatus.LOBBY,
        chatId: BigInt(chatId),
      },
      include: gameWithData,
    });

    return game;
  }

  /**
   * Upserts a DRAFT round for a user in a lobby game
   */
  async upsertDraftRound(
    gameId: number,
    data: {
      userId: number;
      musicFileId: string;
      hintChatId?: number;
      hintMessageId?: number;
    },
  ): Promise<void> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { rounds: { where: { phase: RoundPhase.DRAFT } } },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== GameStatus.LOBBY) {
      throw new Error('Can only add tracks to LOBBY games');
    }

    // Check if user already has a DRAFT round
    const existingRound = await this.prisma.gameRound.findUnique({
      where: {
        gameId_userId: {
          gameId,
          userId: BigInt(data.userId),
        },
      },
    });

    if (existingRound) {
      // Update existing DRAFT round
      await this.prisma.gameRound.update({
        where: { id: existingRound.id },
        data: {
          musicFileId: data.musicFileId,
          hintChatId: data.hintChatId ? BigInt(data.hintChatId) : null,
          hintMessageId: data.hintMessageId ? BigInt(data.hintMessageId) : null,
        },
      });
    } else {
      // Create new DRAFT round with next sequence
      const maxSequence =
        game.rounds.length > 0
          ? Math.max(...game.rounds.map((r: { sequence: number }) => r.sequence))
          : -1;

      await this.prisma.gameRound.create({
        data: {
          gameId,
          userId: BigInt(data.userId),
          sequence: maxSequence + 1,
          musicFileId: data.musicFileId,
          hintChatId: data.hintChatId ? BigInt(data.hintChatId) : null,
          hintMessageId: data.hintMessageId ? BigInt(data.hintMessageId) : null,
          phase: RoundPhase.DRAFT,
        },
      });
    }
  }

  /**
   * Deletes a user's DRAFT round from a lobby game
   */
  async deleteDraftRound(gameId: number, userId: number): Promise<void> {
    await this.prisma.gameRound.deleteMany({
      where: {
        gameId,
        userId: BigInt(userId),
        phase: RoundPhase.DRAFT,
      },
    });

    // Reindex remaining DRAFT rounds
    const draftRounds = await this.prisma.gameRound.findMany({
      where: {
        gameId,
        phase: RoundPhase.DRAFT,
      },
      orderBy: { createdAt: 'asc' },
    });

    for (let i = 0; i < draftRounds.length; i++) {
      await this.prisma.gameRound.update({
        where: { id: draftRounds[i]!.id },
        data: { sequence: i },
      });
    }
  }

  /**
   * Gets all users who have DRAFT rounds in a lobby game
   */
  async getDraftSubmissionUsers(chatId: number): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        gameRounds: {
          some: {
            game: {
              chatId: BigInt(chatId),
              status: GameStatus.LOBBY,
            },
            phase: RoundPhase.DRAFT,
          },
        },
      },
    });
  }

  /**
   * Transitions a game from LOBBY to ACTIVE:
   * - Shuffles DRAFT rounds
   * - Flips all DRAFT rounds to LIVE
   * - Sets game status to ACTIVE
   */
  async startGameFromLobby(gameId: number, config?: GameConfigInput): Promise<GameWithData> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { rounds: { where: { phase: RoundPhase.DRAFT } } },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== GameStatus.LOBBY) {
      throw new Error('Game is not in LOBBY state');
    }

    if (game.rounds.length === 0) {
      throw new Error('Cannot start game with no tracks');
    }

    // Shuffle DRAFT rounds
    const shuffledRounds = this.shuffleArray([...game.rounds]);

    // Transaction: shuffle, flip rounds to LIVE, set game to ACTIVE
    const updatedGame = await this.prisma.$transaction(async (tx: TransactionClient) => {
      // Update round sequence to shuffle, and flip each to LIVE (see B1:
      // `setRoundLive` below is the other reliable place `startedAt` gets
      // set - this is the initial transition out of the lobby).
      for (let i = 0; i < shuffledRounds.length; i++) {
        await tx.gameRound.update({
          where: { id: shuffledRounds[i]!.id },
          data: {
            sequence: i,
            phase: RoundPhase.LIVE,
            startedAt: new Date(),
          },
        });
      }

      // Update game status and config
      const updateData: Prisma.GameUpdateInput = {
        status: GameStatus.ACTIVE,
      };
      if (config) {
        Object.assign(updateData, config);
      }
      const updated = await tx.game.update({
        where: { id: gameId },
        data: updateData,
        include: gameWithData,
      });

      return updated;
    });

    return updatedGame;
  }

  shuffleArray<T>(array: T[]): T[] {
    if (array.length < 2) {
      return [...array];
    }
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j]!, newArray[i]!];
    }
    return newArray;
  }

  async updateGameRound(gameId: number, currentSequence: number): Promise<GameWithData> {
    return this.prisma.game.update({
      where: { id: gameId },
      data: { currentSequence },
      include: gameWithData,
    });
  }

  async updateGameConfig(
    gameId: number,
    data: { status?: GameStatus; config?: GameConfigInput },
  ): Promise<void> {
    const updateData: Prisma.GameUpdateInput = {};
    if (data.status !== undefined) {
      updateData.status = data.status;
    }
    if (data.config !== undefined) {
      Object.assign(updateData, data.config);
    }
    await this.prisma.game.update({
      where: { id: gameId },
      data: updateData,
    });
  }

  async showHint(roundId: number): Promise<void> {
    await this.prisma.gameRound.update({
      where: { id: roundId },
      data: { hintShownAt: new Date() },
    });
  }

  /**
   * B1 fix: nothing reliably set `GameRound.startedAt` once a round moved
   * past its initial lobby-to-live transition (see `startGameFromLobby`),
   * even though scoring depends on it for time-elapsed calculation. This is
   * the one place callers advancing a round to LIVE should go through, so
   * `startedAt` is always set at that transition.
   */
  async setRoundLive(roundId: number): Promise<void> {
    await this.prisma.gameRound.update({
      where: { id: roundId },
      data: { phase: RoundPhase.LIVE, startedAt: new Date() },
    });
  }

  async createGuess(data: {
    roundId: number;
    userId: number;
    guessedId: number;
    isCorrect: boolean;
    points: number;
    isLateGuess: boolean;
  }): Promise<Guess> {
    return this.prisma.guess.upsert({
      where: {
        roundId_userId: {
          roundId: data.roundId,
          userId: BigInt(data.userId),
        },
      },
      create: {
        roundId: data.roundId,
        userId: BigInt(data.userId),
        guessedId: BigInt(data.guessedId),
        points: data.points,
      },
      update: {
        guessedId: BigInt(data.guessedId),
        points: data.points,
      },
    });
  }

  async findGuess(roundId: number, userId: number): Promise<Guess | null> {
    return this.prisma.guess.findUnique({
      where: {
        roundId_userId: {
          roundId,
          userId: BigInt(userId),
        },
      },
    });
  }

  async getParticipants(gameId: number): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        gameRounds: {
          some: {
            gameId: gameId,
          },
        },
      },
    });
  }

  async getUsersNotGuessed(roundId: number): Promise<User[]> {
    const round = await this.prisma.gameRound.findUnique({
      where: { id: roundId },
      select: { gameId: true },
    });

    if (!round) {
      throw new Error(`Round with ID ${roundId} not found`);
    }

    return this.prisma.user.findMany({
      where: {
        gameRounds: {
          some: {
            gameId: round.gameId,
          },
        },
        AND: {
          NOT: {
            guesses: {
              some: {
                roundId,
              },
            },
          },
        },
      },
    });
  }

  async updateRoundMessageInfo(roundId: number, messageId: number) {
    await this.prisma.gameRound.update({
      where: { id: roundId },
      data: { infoMessageId: BigInt(messageId) },
    });
  }

  async getGamesOfChat(chatId: number): Promise<GameWithData[]> {
    return this.prisma.game.findMany({
      where: { chatId: BigInt(chatId) },
      orderBy: {
        createdAt: 'desc',
      },
      include: gameWithData,
    });
  }

  /**
   * Get LIVE rounds count for a game
   */
  async getLiveRoundsCount(gameId: number): Promise<number> {
    return this.prisma.gameRound.count({
      where: {
        gameId,
        phase: RoundPhase.LIVE,
      },
    });
  }

  /**
   * Get current LIVE round by game sequence
   */
  async getLiveRoundBySequence(gameId: number, gameSequence: number) {
    return this.prisma.gameRound.findFirst({
      where: {
        gameId,
        sequence: gameSequence,
        phase: RoundPhase.LIVE,
      },
      include: roundWithGuesses,
    });
  }
}
