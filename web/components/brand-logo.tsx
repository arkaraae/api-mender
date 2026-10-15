import Mascot from './mascot';

type Props = { className?: string; label?: string };

// The mascot (eyes following the pointer) and the name.
export default function BrandLogo({ className = '', label = 'API Mender' }: Props) {
  return <span className={`brand-logo ${className}`} role="img" aria-label={label}><Mascot size={34} /><span className="brand-word" aria-hidden="true">mender</span></span>;
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <Mascot className={`brand-mark ${className}`} />;
}
