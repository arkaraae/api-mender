'use client';

// Behind the 3D gateway: the team's short film of coins riding a rail through a machine, dimmed
// in its frame. It plays only while the scene is on screen (0.7 MB); visitors who prefer reduced
// motion get one still frame.
import { useEffect, useRef } from 'react';

export default function SceneFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    video.muted = true;
    video.defaultMuted = true;
    video.src = '/gateway-bg.mp4';
    const start = () => video.play().catch(() => {});
    video.addEventListener('canplay', start, { once: true });
    const seen = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) start();
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
