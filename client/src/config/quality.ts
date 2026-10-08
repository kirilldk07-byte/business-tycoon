import { LocalStore } from '../platform/LocalStore';
import { isTouch } from './client';

export type QualityName = 'auto' | 'low' | 'medium' | 'high';

export interface Quality {
  name: Exclude<QualityName, 'auto'>;
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMap: number;
  maxNpcs: number; // visible customer NPCs per business
  pedestrians: number;
  cars: number;
  clouds: number;
}

const PRESETS: Record<Exclude<QualityName, 'auto'>, Quality> = {
  low: { name: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMap: 512, maxNpcs: 14, pedestrians: 8, cars: 6, clouds: 6 },
  medium: { name: 'medium', pixelRatio: 1.5, antialias: false, shadows: true, shadowMap: 1024, maxNpcs: 24, pedestrians: 16, cars: 10, clouds: 10 },
  high: { name: 'high', pixelRatio: 2, antialias: true, shadows: true, shadowMap: 2048, maxNpcs: 36, pedestrians: 26, cars: 14, clouds: 14 },
};

/** AUTO: phones and weak CPUs start on low/medium; FPS watchdog can step down further. */
function autoPreset(): Quality {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (isTouch) return cores >= 8 && mem >= 6 ? PRESETS.medium : PRESETS.low;
  return cores >= 6 ? PRESETS.high : PRESETS.medium;
}

export function qualitySetting(): QualityName {
  return (LocalStore.get().quality as QualityName | undefined) ?? 'auto';
}

export function resolveQuality(name: QualityName = qualitySetting()): Quality {
  const q = name === 'auto' ? autoPreset() : PRESETS[name];
  return { ...q, pixelRatio: Math.min(q.pixelRatio, window.devicePixelRatio || 1) };
}

export function lowerQuality(q: Quality): Quality | null {
  if (q.name === 'high') return { ...PRESETS.medium, pixelRatio: Math.min(1.5, window.devicePixelRatio || 1) };
  if (q.name === 'medium') return { ...PRESETS.low };
  return null;
}
