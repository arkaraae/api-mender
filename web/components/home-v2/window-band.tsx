// The banner at the top of each inner page: its own view of the homepage office, rendered with the
// window panes (and, on /check, the monitor screen) transparent so an ASCII loop plays behind them.
export type Scene = 'check' | 'watch' | 'mender' | 'pricing' | 'docs' | 'privacy';

const LOOP: Record<Scene, string> = {
  check: 'ascii-wildflowers',
  watch: 'ascii-sky',
  mender: 'ascii-meadow',
  pricing: 'ascii-meadow',
  docs: 'ascii-sky',
  privacy: 'ascii-wildflowers',
};

export default function WindowBand({ scene }: { scene: Scene }) {
  const loop = LOOP[scene];
  return (
    <div className={`mv2-band-crop mv2-band-${scene}`} aria-hidden="true">
      <video src={`/home/${loop}.mp4`} poster={`/home/${loop}_poster.webp`} autoPlay muted loop playsInline />
      <img className="only-light" src={`/home/scenes/${scene}_light.webp`} alt="" width={1920} height={800} />
      <img className="only-dark" src={`/home/scenes/${scene}_dark.webp`} alt="" width={1920} height={800} />
    </div>
  );
}
