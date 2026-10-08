import type { ActiveEventKind } from '../types/state';

// Display metadata for match events (logic lives on the server).
export const EVENT_INFO: Record<ActiveEventKind, { title: string; icon: string; desc: string }> = {
  rush: { title: 'RUSH HOUR', icon: '🔥', desc: 'Клиентов больше в несколько раз!' },
  boost: { title: 'BUSINESS BOOST', icon: '⚡', desc: 'Производство x2' },
  golden: { title: 'GOLDEN CUSTOMER', icon: '💰', desc: 'Богатый клиент уже в пути!' },
  delivery: { title: 'DELIVERY ARRIVED', icon: '🚚', desc: 'Разгрузите ящики у кафе (E) — бонус товара и денег' },
  power: { title: 'POWER FAILURE', icon: '🔌', desc: 'Включите ОБА рубильника почти одновременно!' },
};

export const VS_EVENTS: ActiveEventKind[] = ['rush', 'golden', 'boost'];
export const COOP_EVENTS: ActiveEventKind[] = ['rush', 'delivery', 'power', 'golden'];
export const SOLO_EVENTS: ActiveEventKind[] = ['rush', 'delivery', 'golden', 'boost'];
