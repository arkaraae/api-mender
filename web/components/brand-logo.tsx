import Mascot from './mascot';

type Props = { className?: string; label?: string };

// The Mend logo, in the text color around it (app/brand.css).
export default function BrandLogo({ className = '', label = 'API Mender' }: Props) {
  return <span className={`brand-logo ${className}`} role="img" aria-label={label} />;
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <Mascot className={`brand-mark ${className}`} />;
}
