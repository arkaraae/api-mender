import type { ReactNode } from 'react';

// Building blocks for the inner pages, following intelligence.ai's inner-page patterns:
// a centered title block on plain ground, and (on some pages) a strip of three photos with faded edges.

export type Scene = 'check' | 'watch' | 'mender' | 'pricing' | 'docs' | 'privacy';

// Which ASCII loop shows through each scene's windows. The strip uses the loop's still frame.
const LOOP: Record<Scene, string> = {
  check: 'ascii-wildflowers',
  watch: 'ascii-sky',
  mender: 'ascii-meadow',
  pricing: 'ascii-meadow',
  docs: 'ascii-sky',
  privacy: 'ascii-wildflowers',
};

export function PageHead({ kicker, title, children, cta }: {
  kicker?: string;
  title: string;
  children?: ReactNode;
  cta?: { href: string; label: string };
}) {
  return (
    <section className="check-hero mv2-head">
      {kicker && <p className="hero-kicker">{kicker}</p>}
      <h1>{title}</h1>
      {children && <p className="hero-subtitle">{children}</p>}
      {cta && <a className="mv2-btn mv2-head-cta" href={cta.href}>{cta.label}</a>}
    </section>
  );
}

export function SceneStrip({ scenes }: { scenes: [Scene, Scene, Scene] }) {
  return (
    <div className="mv2-strip3" aria-hidden="true">
      {scenes.map((scene) => (
        <figure key={scene} style={{ backgroundImage: `url(/home/${LOOP[scene]}_poster.webp)` }}>
          <img className="only-light" src={`/home/scenes/${scene}_light.webp`} alt="" width={1920} height={800} loading="lazy" />
          <img className="only-dark" src={`/home/scenes/${scene}_dark.webp`} alt="" width={1920} height={800} loading="lazy" />
        </figure>
      ))}
    </div>
  );
}
