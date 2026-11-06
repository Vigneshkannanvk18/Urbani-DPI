import logoMark from './assets/logo-mark.svg';
import logoLight from './assets/logo-light.svg';
import logoDark from './assets/logo-dark.svg';

/**
 * Single brand module (DPI 2 item 10). Everything that is "Urbani branding" in the UI comes from here, from
 * ./brand.css (palette) and from ./assets (logos, favicon).
 *
 * *** PLACEHOLDER ***  The values below reproduce the CURRENT look (gold "U" mark, navy/gold palette). Urbani has
 * not supplied official assets or hex codes yet (client inputs #8/#9). docs/BRANDING.md lists exactly what to
 * replace when they do.
 */
export const BRAND = {
  /** True while the placeholder logo / palette are in use. Set to false once official assets are in place. */
  isPlaceholder: true,
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
