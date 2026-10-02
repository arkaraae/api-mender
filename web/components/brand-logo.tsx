type Props = { className?: string; label?: string };

export default function BrandLogo({ className = '', label = 'API Mender' }: Props) {
  return <span className={`brand-logo ${className}`}><img src="/api-mender-logo.png" alt={label} /></span>;
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true"><img src="/api-mender-logo.png" alt="" /></span>;
}
