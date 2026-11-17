/**
 * World rules: what is decided once per world (by its host), as opposed to per player.
 * DESIGN M2 联机: "游戏模式（创造 / 生存）按玩家设置；方块被挤掉、炸掉时是否掉落按世界设置".
 *
 * Who decides what:
 *  - the MINING player's mode: whether a mined block drops (creative: never);
 *  - the TARGET player's mode: whether damage hurts that player;
 *  - dropsEnabled: blocks squeezed out by a blockify or a dock, destroyed by a pinned ship,
 *    blown up, popped off by a block update (lost support) or washed away;
 *  - defaultMode: the mode a new player joins with, and whether creatures can be harmed
 *    (the rabbit crush limit, blast damage to rabbits): only in a survival world.
 * Nothing in the simulation reads some player's mode to decide a world effect.
 */
import type { GameMode } from '../entities/entity';

export interface WorldRules {
  /** The mode a player who joins for the first time starts in. */
  defaultMode: GameMode;
  /** Displaced, pinned-off, blown-up, popped-off and washed-away blocks drop their item. */
  dropsEnabled: boolean;
}

/** The rules of a new world created in `mode`: a survival world drops, a creative one does not. */
export function worldRulesFor(mode: GameMode): WorldRules {
  return { defaultMode: mode, dropsEnabled: mode === 'survival' };
}
