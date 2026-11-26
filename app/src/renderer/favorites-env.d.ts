import type { FavoritesBridge } from '../shared/favorites'

declare global {
  interface Window {
    /** 只在 `bao://favorites` 内部页里可用（见 `src/preload/internal.ts`）。 */
    baoFavorites: FavoritesBridge
  }
}

export {}
