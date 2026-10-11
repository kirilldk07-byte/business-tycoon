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
  /** Half-size (m) of the sun's shadow box that follows the player: smaller = sharper, cheaper. */
  shadowRange: number;
  /** Particle count multiplier (effects never cover the screen on weak phones). */
  particleScale: number;
}

const PRESETS: Record<Exclude<QualityName, 'auto'>, Quality> = {
  // DPR is capped per preset (a phone may report 3 — rendering 3× pixels is never worth it).
  low: { name: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMap: 512, maxNpcs: 14, pedestrians: 8, cars: 6, clouds: 6, shadowRange: 26, particleScale: 0.5 },
  medium: { name: 'medium', pixelRatio: 1.5, antialias: false, shadows: true, shadowMap: 1024, maxNpcs: 24, pedestrians: 16, cars: 10, clouds: 10, shadowRange: 32, particleScale: 0.75 },
  high: { name: 'high', pixelRatio: 2, antialias: true, shadows: true, shadowMap: 2048, maxNpcs: 36, pedestrians: 26, cars: 14, clouds: 14, shadowRange: 44, particleScale: 1 },
};

/** GPU name via WEBGL_debug_renderer_info (Safari reports "Apple GPU"); '' if unavailable. */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

/**
 * AUTO: decide by the actual GPU, not by deviceMemory (iOS Safari doesn't expose it → every iPhone used to get LOW).
 * Modern phone GPUs get sharp 2× rendering + shadows; the FPS watchdog (dynamic resolution → lower preset)
 * still protects weak devices.
 */
function autoPreset(): Quality {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (!isTouch) return cores >= 6 ? PRESETS.high : PRESETS.medium;
  const gpu = gpuName();
  const apple = /Apple/i.test(gpu);
  const strong = apple || /Adreno \(TM\) (6[4-9]\d|[7-9]\d\d)|Mali-G(7[1-9]|[6-9]\d\d|[89]\d)|Immortalis|Xclipse/i.test(gpu);
  // Apple GPUs are tile-based: MSAA is almost free there.
  if (strong) return { ...PRESETS.medium, name: 'medium', pixelRatio: 2, antialias: apple, shadowMap: 2048, shadowRange: 36, pedestrians: 20 };
  if (cores >= 6 || mem >= 4) return PRESETS.medium;
  return PRESETS.low;
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
  if (q.name === 'medium' && q.pixelRatio > 1.5) return { ...q, pixelRatio: 1.5, antialias: false, shadowMap: 1024 };
  if (q.name === 'medium') return { ...PRESETS.low };
  return null;
}
