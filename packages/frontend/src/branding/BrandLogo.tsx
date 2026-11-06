import { BRAND } from './brand';

/** Square logo mark from the brand module (decorative: the product name is always next to it as text). */
export function BrandMark({ size = 34, className = '' }: { size?: number; className?: string }) {
  return <img className={`brand-mark-img ${className}`} src={BRAND.logo.mark} alt="" aria-hidden width={size} height={size} />;
}

/** Full logo; shows the light-background or dark-background variant depending on the active theme (CSS). */
export function BrandLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`brand-logo ${className}`}>
      <img className="brand-logo-light" src={BRAND.logo.light} alt={BRAND.logo.alt} />
      <img className="brand-logo-dark" src={BRAND.logo.dark} alt={BRAND.logo.alt} />
    </span>
  );
}
