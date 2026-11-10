import logoMark from './assets/logo-mark.svg';
import logoLight from './assets/logo-light.svg';
import logoDark from './assets/logo-dark.svg';

/**
 * Single brand module (DPI 2 item 10). Everything that is "Urbani branding" in the UI comes from here, from
 * ./brand.css (palette) and from ./assets (logos, favicon).
 *
 * The logo and palette follow the official Urbani logo supplied by the client (violet gradient tile, white "U",
 * cyan dot). The SVGs in ./assets are a vector redraw of that image, and the hex values in ./brand.css are read
 * off it. Replace the SVGs with Urbani's original vector files, and the hex values with their brand guideline,
 * if/when those are supplied (docs/BRANDING.md).
 */
export const BRAND = {
  /** True while placeholder logo / palette are in use. False: the client's logo and colours are applied. */
  isPlaceholder: false,
  productName: 'Urbani Observability',
  /** Short name next to the logo mark. */
  shortName: 'URBANI',
  tagline: 'Proactive Observability & AI Troubleshooting',
  /** Browser tab title (keep index.html <title> in sync; it is what shows before the app loads). */
  documentTitle: 'Urbani Observability',
  logo: {
    /** Square mark (sidebar, login card). */
    mark: logoMark,
    /** Full logo for LIGHT backgrounds. */
    light: logoLight,
    /** Full logo for DARK backgrounds. */
    dark: logoDark,
    alt: 'Urbani',
  },
  /** Shown in the sidebar footer and on the login page. */
  legal: {
    owner: 'Urbani',
    text: (year: number = new Date().getFullYear()) => `\u00A9 ${year} Urbani. All rights reserved.`,
  },
} as const;
