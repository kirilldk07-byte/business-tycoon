/**
 * One SVG icon set for the HUD (24×24, currentColor). Independent from emoji fonts,
 * crisp at any DPR. Markup uses <i class="ico" data-ico="name"></i>; hydrateIcons() fills them.
 */
const stroke = (body: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  menu: stroke('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  cash: stroke('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v5M18 9.5v5"/>'),
  trend: stroke('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  shop: stroke('<path d="M4 10h16v10H4z"/><path d="M3 10l2-6h14l2 6"/><path d="M10 20v-5h4v5"/>'),
  smile: stroke('<circle cx="12" cy="12" r="9"/><path d="M8 14.5c1 1.5 2.3 2.2 4 2.2s3-.7 4-2.2"/><path d="M9 9.5h.01M15 9.5h.01"/>'),
  gear: stroke('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"/>'),
  expand: stroke('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exit: stroke('<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>'),
  hand: stroke('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4.5a1.5 1.5 0 0 1 3 0v6"/><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L4 15.5a1.6 1.6 0 0 1 2.3-2.2L8 15"/>'),
  jump: stroke('<path d="M12 19V6"/><path d="M6 11l6-6 6 6"/>'),
  crown: stroke('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>'),
};

export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('i.ico[data-ico]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = ICONS[el.dataset.ico!] ?? '';
  });
}
