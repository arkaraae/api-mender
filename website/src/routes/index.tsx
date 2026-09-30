import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { LeadForm } from "../components/LeadForm";
import { Button } from "../components/Button";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Stay Ahead of API Changes — API Mender" },
      {
        name: "description",
        content:
          "Follow API updates, inspect recognized Stripe calls, and explore a proposed fix in our interactive demo. Built for engineering teams who want fewer integration surprises.",
      },
      { property: "og:title", content: "Stay Ahead of API Changes — API Mender" },
      {
        property: "og:description",
        content: "Follow API updates, inspect recognized Stripe calls, and explore a proposed fix in our interactive demo. Built for engineering teams who want fewer integration surprises.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "/" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
});

const pains = [
  ["Changelogs get missed", "Breaking changes may be announced, but engineering teams still have to notice them."],
  ["Finding affected code takes time", "Developers have to search the codebase to understand where an API is being used."],
  ["Migrations are still manual", "Even with a guide, engineers must translate the change into their own code."],
  ["You often find out too late", "An unnoticed change can become a failed integration, broken feature, or production issue."],
];


const steps = [
  ["1", "Connect your repository", "The current workspace scans public TypeScript repositories for recognized Stripe calls."],
  ["2", "Review source updates", "Check official Stripe sources for updates. Their impact on your code still needs review."],
  ["3", "Review the fix", "Try the sample repair and inspect its patch and recorded checks. General automatic remediation is still in development."],
];

function Index() {
  const formRef = useRef<HTMLDivElement>(null);
  const [intent, setIntent] = useState<"early" | "partner">("early");

  const openForm = (nextIntent: "early" | "partner") => {
    setIntent(nextIntent);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      const firstInput = formRef.current?.querySelector<HTMLInputElement>("input");
      firstInput?.focus();
    }, 550);
  };

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <header className="page-shell flex h-18 items-center justify-between">
        <a href="#top" className="font-mono text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="text-primary">API</span> Mender
        </a>
        <Button variant="secondary" className="min-h-9 px-4" onClick={() => openForm("early")}>
          Get Early Access
        </Button>
      </header>

      <section id="top" className="section-rule technical-grid relative py-16 sm:py-24 lg:py-28">
        <div className="page-shell grid items-center gap-14 lg:grid-cols-[1.03fr_0.97fr] lg:gap-16">
          <div className="max-w-2xl">
            <p className="mb-5 font-mono text-xs uppercase text-primary">Self-maintaining APIs · In development</p>
            <h1 className="text-4xl font-semibold leading-[1.08] sm:text-5xl lg:text-6xl">
              Stay Ahead of API Changes Without the Manual Work
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Follow API updates, inspect recognized Stripe calls, and explore a proposed fix in our interactive demo. Built for engineering teams who want fewer integration surprises.
            </p>
            <div className="mt-8">
              <a href="/demo" className="mr-3 mb-3 inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground">Try the demo →</a>
              <Button variant="secondary" onClick={() => openForm("early")}>Get Early Access <span aria-hidden="true">→</span></Button>
              <p className="mt-3 text-xs text-muted-foreground">No login or GitHub connection needed for the demo.</p>
            </div>
          </div>

          <div className="mx-auto w-full max-w-lg" aria-label="Illustrative workflow from API change to pull request">
            <p className="mb-3 font-mono text-[11px] uppercase text-muted-foreground">Explore the workflow · sample scenario</p>
            <div className="rounded-lg border border-border-strong bg-code p-3 shadow-2xl shadow-foreground/10">
              <div className="flex items-center justify-between border-b border-border/20 px-2 pb-3 font-mono text-[11px] text-primary">
                <span>proposed agent workflow</span><span className="text-muted">example</span>
              </div>
              <div className="space-y-2 pt-3 font-mono text-xs">
                <FlowRow label="Third-party API changes" detail="new version" status="event" />
                <FlowArrow delay="0s" />
                <FlowRow label="Change detected" detail="breaking update" status="scan" />
                <FlowArrow delay=".2s" />
                <FlowRow label="Connected code checked" detail="example repository" status="scan" />
                <FlowArrow delay=".4s" />
                <FlowRow label="Affected code identified" detail="relevant usages" status="warn" />
                <FlowArrow delay=".6s" />
                <FlowRow label="Proposed fix prepared" detail="ready for review" status="success" />
                <FlowArrow delay=".8s" />
                <div className="rounded-md border border-primary/50 bg-primary/10 p-4 text-primary">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium">Draft pull request prepared</span><span>concept</span>
                  </div>
                  <p className="mt-2 text-[11px] text-muted">Suggested migration for the affected code</p>
                </div>
              </div>
            </div>
            <p className="mt-4 border-l-2 border-primary pl-3 text-xs leading-5 text-muted-foreground">Your team reviews and approves every PR. Nothing is merged automatically.</p>
          </div>
        </div>
      </section>

      <section className="section-rule py-20 sm:py-28">
        <div className="page-shell">
          <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
            <div>
              <p className="font-mono text-xs uppercase text-primary">The maintenance gap</p>
              <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">Your APIs change.<br />Your code doesn’t.</h2>
              <p className="mt-5 max-w-md leading-7 text-muted-foreground">A changelog still leaves your team to locate every affected usage, adapt the code, and verify the change.</p>
            </div>
            <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {pains.map(([title, copy], index) => (
                <article key={title} className="bg-card p-6">
                  <span className="font-mono text-xs text-warning">0{index + 1}</span>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy}</p>
                </article>
              ))}
            </div>
          </div>

        </div>
      </section>

      <section className="section-rule py-20 sm:py-24">
        <div className="page-shell">
          <div className="max-w-2xl">
            <p className="font-mono text-xs uppercase text-primary">The outcome</p>
            <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">From scrambling to a review-ready PR.</h2>
          </div>
          <div className="mt-10 grid overflow-hidden rounded-lg border border-border lg:grid-cols-2">
            <WorkflowComparison title="Before — an API change lands" items={["API changes", "Changelog missed", "Integration fails", "Search the repo", "Read migration docs", "Rush a fix"]} />
            <WorkflowComparison title="After — with API Mender" items={["API change surfaced", "Affected usages identified", "Proposed migration PR prepared", "Team reviews it"]} improved />
          </div>
          <p className="mt-8 max-w-2xl text-lg leading-8 text-muted-foreground">Your engineers spend their time reviewing a proposed fix — not discovering the change and managing the migration by hand.</p>
          <div className="mt-8">
            <Button onClick={() => openForm("early")}>Get Early Access <span aria-hidden="true">→</span></Button>
            <p className="mt-3 text-xs text-muted-foreground">No login or GitHub connection needed for the demo.</p>
          </div>
        </div>
      </section>

      <section className="section-rule py-20 sm:py-28">
        <div className="page-shell">
          <div className="max-w-2xl">
            <p className="font-mono text-xs uppercase text-primary">How it works</p>
            <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">Start with visibility. Explore the repair workflow.</h2>
          </div>
          <div className="relative mt-14 grid gap-6 md:grid-cols-3 md:gap-0">
            <div className="absolute left-[16.7%] right-[16.7%] top-5 hidden h-px bg-border md:block" />
            {steps.map(([number, title, copy]) => (
              <article key={number} className="relative bg-background md:px-8 first:md:pl-0 last:md:pr-0">
                <span className="relative z-10 flex size-10 items-center justify-center rounded-full border border-primary bg-background font-mono text-sm text-primary">{number}</span>
                <h3 className="mt-6 text-lg font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{copy}</p>
              </article>
            ))}
          </div>
          <p className="mt-10 border-l-2 border-primary pl-4 text-sm font-medium">Your team reviews and approves every PR. Nothing is merged automatically.</p>
        </div>
      </section>

      <section className="section-rule py-20 sm:py-24">
        <div className="page-shell grid gap-8 lg:grid-cols-[0.7fr_1.3fr] lg:gap-20">
          <h2 className="text-3xl font-semibold sm:text-4xl">API maintenance was manual because it had to be.</h2>
          <div>
            <p className="text-lg leading-8 text-muted-foreground">We’re building an agent that turns API change information into a focused code update for engineers to inspect, test, and approve.</p>
            <p className="mt-6 border-l-2 border-primary pl-4 text-sm text-muted-foreground">Y Combinator has called out <a href="https://www.ycombinator.com/rfs#self-maintaining-apis" target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">self-maintaining APIs</a> as a problem worth building for.</p>
          </div>
        </div>
      </section>

      <section id="contact" className="section-rule bg-secondary py-20 sm:py-28">
        <div className="page-shell grid gap-14 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <div>
            <p className="font-mono text-xs uppercase text-primary">Early access</p>
            <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">Spend less time chasing API changes.</h2>
            <p className="mt-5 leading-7 text-muted-foreground">Interested in trying this on your own code? Leave your email or help shape the product as a design partner.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button onClick={() => openForm("early")}>Get Early Access</Button>
              <Button variant="secondary" onClick={() => openForm("partner")}>Become a Design Partner</Button>
            </div>
          </div>

          <div ref={formRef} className="rounded-lg border border-border-strong bg-card p-5 shadow-xl shadow-foreground/5 sm:p-8">
            <LeadForm intent={intent} onIntentChange={setIntent} />
          </div>
        </div>
      </section>

      <footer className="section-rule py-8">
        <div className="page-shell flex flex-col gap-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div><span className="font-mono text-foreground">API Mender</span><p className="mt-1 text-xs">API Mender turns third-party API changes into proposed, ready-to-review fixes.</p></div>
          <nav className="flex gap-6" aria-label="Footer"><a href="#contact" className="hover:text-foreground">Contact</a><span>Contact details are used for product follow-up.</span></nav>
        </div>
      </footer>
    </main>
  );
}

function FlowRow({ label, detail, status }: { label: string; detail: string; status: "event" | "scan" | "warn" | "success" }) {
  const statusStyle = status === "success" ? "text-success" : status === "warn" ? "text-warning" : "text-primary";
  return <div className="flex items-center justify-between gap-4 rounded border border-border/20 bg-primary-foreground/5 px-3 py-2.5 text-muted"><span><span className={`mr-2 ${statusStyle}`}>●</span>{label}</span><span className="text-[10px] text-muted-foreground">{detail}</span></div>;
}

function FlowArrow({ delay }: { delay: string }) {
  const delayClass = delay === ".2s" ? "[animation-delay:.2s]" : delay === ".4s" ? "[animation-delay:.4s]" : delay === ".6s" ? "[animation-delay:.6s]" : delay === ".8s" ? "[animation-delay:.8s]" : "";
  return <div className={`flow-pulse h-2 pl-5 text-[10px] text-primary ${delayClass}`} aria-hidden="true">↓</div>;
}

function WorkflowComparison({ title, items, improved = false }: { title: string; items: string[]; improved?: boolean }) {
  return <div className={`p-6 sm:p-8 ${improved ? "bg-success-muted" : "bg-card lg:border-r lg:border-border"}`}><p className={`font-mono text-xs uppercase ${improved ? "text-success" : "text-muted-foreground"}`}>{title}</p><div className="mt-5 flex flex-wrap items-center gap-2">{items.map((item, index) => <span key={item} className="contents"><span className={`rounded border px-3 py-2 text-xs ${improved ? "border-success/30 bg-card text-foreground" : "border-border bg-secondary text-muted-foreground"}`}>{item}</span>{index < items.length - 1 && <span className={improved ? "text-success" : "text-muted-foreground"}>→</span>}</span>)}</div></div>;
}
