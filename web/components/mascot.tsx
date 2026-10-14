'use client';

// The mascot from the team's logo, with eyes that follow the pointer. Used small in the top bar
// (see brand-logo.tsx) and large on the homepage. The pupils stay centered when the visitor
// prefers reduced motion.
import { useEffect, useRef } from 'react';

type Props = { className?: string; size?: number; label?: string };

export default function Mascot({ className = '', size = 28, label }: Props) {
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const pupils = [...el.querySelectorAll<HTMLElement>('.mascot-pupil')];
    let x = 0;
    let y = 0;
    let frame = 0;
    // Each pupil moves toward the pointer: a little for a pointer nearby, up to a limit far away.
    const look = () => {
      frame = 0;
      for (const pupil of pupils) {
        const eye = pupil.parentElement!.getBoundingClientRect();
        const dx = x - (eye.left + eye.width / 2);
        const dy = y - (eye.top + eye.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const shift = Math.min(1, distance / 220) * eye.width * 0.24;
        pupil.style.transform = `translate(${((dx / distance) * shift).toFixed(2)}px, ${((dy / distance) * shift).toFixed(2)}px)`;
      }
    };
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(look);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <span ref={root} className={`mascot ${className}`} style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <img src="/api-mender-logo.png" alt="" draggable={false} />
      <span className="mascot-eye mascot-eye-left"><span className="mascot-pupil" /></span>
      <span className="mascot-eye mascot-eye-right"><span className="mascot-pupil" /></span>
    </span>
  );
}
