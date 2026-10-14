'use client';

// Behind the 3D gateway: the team's short film of coins riding a rail through a machine, dimmed
// and faded at the edges. It plays only while the scene is on screen, and only on screens wide
// enough to show the scene; phones and visitors who prefer reduced motion get one still frame.
import { useEffect, useRef } from 'react';

export default function SceneFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || !window.matchMedia('(min-width: 760px)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    video.src = '/gateway-bg.mp4';
    const seen = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    });
    seen.observe(video);
    return () => {
      seen.disconnect();
      video.pause();
    };
  }, []);

  return <video ref={ref} className="scene-film" muted loop playsInline preload="none" poster="/gateway-bg.jpg" aria-hidden="true" />;
}
