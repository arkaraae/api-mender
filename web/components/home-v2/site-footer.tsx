export default function SiteFooter() {
  return (
    <footer className="mv2-footer">
      <div className="mv2-wrap">
        <div className="mv2-foot">
          <div><small>For API teams</small><a href="/#join">Get in touch</a></div>
          <div><small>Try it</small><a href="/check">Check a change</a></div>
          <div><small>Read more</small><a href="/docs">Setup guide</a></div>
          <div><small>Pricing</small><a href="/pricing">Free in beta</a></div>
        </div>
        <div className="mv2-legal">
          <span>© 2026 API Mender · Know what changed. Know what to do.</span>
          <nav aria-label="More">
            <a href="/watch">Watch an API</a><a href="/demo">Team demo</a><a href="/privacy">Privacy</a><a href="/live">Sign in</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
