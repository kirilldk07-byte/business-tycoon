import type { ActiveEventKind } from '../types/state';

// Display metadata for match events (logic lives on the server).
export const EVENT_INFO: Record<ActiveEventKind, { title: string; icon: string; desc: string }> = {
  rush: { title: 'RUSH HOUR', icon: '🔥', desc: 'Клиентов в несколько раз больше!' },
  boost: { title: 'BUSINESS BOOST', icon: '⚡', desc: 'Производство x2' },
  festival: { title: 'CITY FESTIVAL', icon: '🎉', desc: 'Праздник в городе: +50% клиентов во всех бизнесах' },
  vip: { title: 'VIP CUSTOMER', icon: '💎', desc: 'К кассе идёт VIP — обслужи его!' },
  delivery: { title: 'BIG DELIVERY', icon: '📦', desc: 'Разгрузи ящики у входа (E) — бонус к производству' },
  power: { title: 'POWER FAILURE', icon: '⚡', desc: 'Включите ОБА генератора почти одновременно!' },
};

/** Every VS event affects both players identically. */
export const VS_EVENTS: ActiveEventKind[] = ['rush', 'festival', 'vip', 'delivery', 'boost'];
export const COOP_EVENTS: ActiveEventKind[] = ['rush', 'delivery', 'power', 'vip', 'festival'];
export const SOLO_EVENTS: ActiveEventKind[] = ['rush', 'delivery', 'vip', 'festival', 'boost'];

/** Customer kinds in CUSTOMERS batches. */
export const CUSTOMER_KIND = { normal: 0, golden: 1, vip: 2 } as const;
