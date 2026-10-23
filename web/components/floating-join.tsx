'use client';

import { useEffect, useState } from 'react';

// The top navigation has the first invitation. Keep it in reach after that bar scrolls away.
export default function FloatingJoin() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const nav = document.querySelector('.hero-nav');
    if (!nav) return;
    const observer = new IntersectionObserver(([entry]) => setShow(!entry.isIntersecting));
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  return <a className={`floating-join${show ? ' is-visible' : ''}`} href="#join" aria-hidden={!show} tabIndex={show ? 0 : -1}>Join us</a>;
}
