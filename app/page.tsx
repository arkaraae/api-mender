import ProductPreview from '@/components/product-preview';
import AuthCallbackRedirect from '@/components/auth-callback-redirect';

export default function Home() {
  return <main className="marketing-page">
    <AuthCallbackRedirect />
    <header className="marketing-nav">
      <a className="site-brand" href="/" aria-label="API Mender home"><span className="site-brand-icon">↗</span><span>api mender<span className="brand-period">.</span></span></a>
      <nav aria-label="Main navigation"><a href="#product">Product</a><a href="#how-it-works">How it works</a><a href="#coverage">Coverage</a></nav>
      <div className="marketing-nav-actions"><a className="nav-text-link" href="/demo">View demo</a><a className="nav-text-link" href="/live">Log in</a><a className="pill-button pill-dark nav-cta" href="/live">Get started <span aria-hidden="true">↗</span></a></div>
    </header>
    <section className="marketing-hero" aria-labelledby="hero-title">
      <p className="hero-kicker">THE API CHANGE WORKSPACE</p>
      <h1 id="hero-title">Keep every integration<br/> one step ahead<span className="brand-period">.</span></h1>
      <p className="hero-subtitle">Spot upstream changes, find the code they touch, and prepare fixes your team can review.</p>
      <div className="hero-actions"><a className="pill-button pill-dark" href="/live">Get started <span aria-hidden="true">↗</span></a><a className="pill-button pill-outline" href="/demo">Explore the demo <span aria-hidden="true">↗</span></a></div>
    </section>
    <section id="product" className="marketing-product" aria-label="API Mender product preview">
      <div className="preview-note preview-note-left"><span className="note-symbol">↗</span><span>Upstream changes<br/><strong>in one view</strong></span></div>
      <div className="marketing-preview-frame"><ProductPreview /></div>
      <div className="preview-note preview-note-right"><span>Evidence → code → review</span><span className="note-arrow">↗</span></div>
      <p className="preview-caption">Illustrative workspace preview. <a href="/demo">See the simulated product demo ↗</a></p>
    </section>
    <section id="how-it-works" className="marketing-information"><div className="information-heading"><p className="hero-kicker">BUILT FOR ENGINEERING TEAMS</p><h2>From change to confidence.</h2></div><div className="information-grid"><article><span>01</span><h3>Watch the source</h3><p>Check official API and SDK sources for updates that deserve attention.</p></article><article><span>02</span><h3>Find what it touches</h3><p>Map recognized API calls to the repository and commit you are monitoring.</p></article><article><span>03</span><h3>Review the evidence</h3><p>See the source, affected code, and limits before deciding what to fix.</p></article></div></section>
    <section id="coverage" className="marketing-close"><p className="hero-kicker">START WITH STRIPE</p><h2>Less surprise in every release.</h2><p>Connect a public GitHub repository to the live workspace, or explore the simulated workflow first.</p><div className="hero-actions"><a className="pill-button pill-dark" href="/live">Open live workspace <span aria-hidden="true">↗</span></a><a className="pill-button pill-outline" href="/demo">View demo</a></div></section>
    <footer className="marketing-footer"><span className="site-brand"><span className="site-brand-icon">↗</span><span>api mender<span className="brand-period">.</span></span></span><span>Know what changed. Know what to do.</span><a href="/connect">GitHub App setup ↗</a></footer>
  </main>;
}
