import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { getTotalProposals } from "../lib/contract";

/**
 * Hook to detect when an element enters the viewport using IntersectionObserver.
 */
function useIsVisible(ref: React.RefObject<HTMLElement | null>) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true);
        observer.unobserve(entry.target);
      }
    }, { 
      threshold: 0.1,
      rootMargin: "0px 0px -50px 0px"
    });

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);

  return isVisible;
}

function FeatureCard({ title, desc, delay }: { title: string; desc: string; delay: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isVisible = useIsVisible(ref);

  return (
    <div
      ref={ref}
      className={`p-8 bg-zinc-950 border border-zinc-900 rounded-[2rem] transition-all duration-700 hover:border-emerald-500/30 group ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-10"
      }`}
      style={{ transitionDelay: delay }}
    >
      <div className="w-10 h-10 rounded-xl bg-zinc-900 mb-6 flex items-center justify-center group-hover:bg-emerald-500/10 group-hover:text-emerald-500 transition-colors">
        <div className="w-2 h-2 rounded-full bg-current" />
      </div>
      <h3 className="text-xl font-bold mb-3 text-white">{title}</h3>
      <p className="text-zinc-500 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}

function StepCard({ number, title, desc }: { number: string; title: string; desc: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isVisible = useIsVisible(ref);

  return (
    <div
      ref={ref}
      className={`flex flex-col items-start p-2 transition-all duration-1000 ${
        isVisible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-10"
      }`}
    >
      <div className="flex items-center gap-4 mb-6 w-full">
        <div className="flex-none w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 flex items-center justify-center font-bold text-xl">
          {number}
        </div>
        <div className="h-[1px] flex-1 bg-zinc-900 hidden md:block" />
      </div>
      <h3 className="text-2xl font-bold mb-4">{title}</h3>
      <p className="text-zinc-500 leading-relaxed text-sm lg:text-base">{desc}</p>
    </div>
  );
}

export function LandingPage() {
  const [proposalCount, setProposalCount] = useState<number | "—">(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTotalProposals()
      .then(setProposalCount)
      .catch(() => setProposalCount("—"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-white selection:bg-emerald-500/30 overflow-x-hidden scroll-smooth">
      {/* Hero Section */}
      <section data-testid="hero-section" className="relative min-h-[90vh] flex flex-col items-center justify-center px-6 overflow-hidden pt-20">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-emerald-500/10 rounded-full blur-[140px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-emerald-500/10 rounded-full blur-[140px]" />
        </div>

        <div className="max-w-4xl text-center space-y-12 relative z-10">
          <div className="opacity-0 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
            <div className="flex justify-center mb-10">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500 text-3xl font-bold text-black shadow-2xl shadow-emerald-500/40">
                A
              </div>
            </div>
            <h1 className="text-5xl md:text-8xl font-bold tracking-tighter bg-gradient-to-b from-white to-zinc-600 bg-clip-text text-transparent pb-4 leading-none">
              Accord Protocol
            </h1>
            <p className="mt-8 text-lg md:text-2xl text-zinc-400 font-medium max-w-2xl mx-auto leading-relaxed px-4">
              The decentralized multi-signature standard for trustless agreement and execution on Stellar.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 opacity-0 animate-fade-in-up" style={{ animationDelay: "0.4s" }}>
            <Link
              to="/app"
              className="w-full sm:w-auto px-10 py-5 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-2xl transition-all shadow-xl shadow-emerald-500/20 active:scale-95 text-lg"
            >
              Launch App
            </Link>
            <Link
              to="/docs"
              className="w-full sm:w-auto px-10 py-5 bg-zinc-900/50 hover:bg-zinc-800 text-white border border-zinc-800 font-bold rounded-2xl transition-all active:scale-95 text-lg"
            >
              Read Docs
            </Link>
          </div>
        </div>
      </section>

      {/* How it Works Section */}
      <section className="py-32 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="mb-20 text-center md:text-left">
            <h2 className="text-4xl md:text-5xl font-bold mb-4 tracking-tight">How Accord Works</h2>
            <p className="text-zinc-500 text-lg md:text-xl font-medium">Secure, transparent, and completely on-chain.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-16">
            <StepCard
              number="1"
              title="Create a Proposal"
              desc="Owners define a transfer or configuration change with a clear description and deadline."
            />
            <StepCard
              number="2"
              title="Owners Approve"
              desc="Other members review and sign the proposal. The M-of-N threshold must be reached."
            />
            <StepCard
              number="3"
              title="Funds Transfer"
              desc="Once threshold is met, anyone can trigger the execution. Funds are moved and recorded on-chain."
            />
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-32 px-6 bg-zinc-950 relative">
        <div className="max-w-6xl mx-auto">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <FeatureCard
              title="On-chain M-of-N"
              desc="Full transparency and control over approvals directly on the Stellar ledger."
              delay="0s"
            />
            <FeatureCard
              title="Time-locked Execution"
              desc="Configurable delays between approval and execution for enhanced security."
              delay="0.1s"
            />
            <FeatureCard
              title="Token Agnostic"
              desc="Support for any Soroban-compliant token, including stablecoins and custom assets."
              delay="0.2s"
            />
            <FeatureCard
              title="Auditable History"
              desc="Every action, approval, and execution is permanently recorded and searchable."
              delay="0.3s"
            />
          </div>
        </div>
      </section>

      {/* Built on Stellar Section */}
      <section className="py-32 px-6 border-y border-zinc-900 hover:bg-zinc-900/10 transition-colors duration-1000">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Built on Stellar</h2>
          <div className="flex flex-col items-center justify-center gap-4">
            <div className="text-6xl md:text-8xl font-mono font-bold text-emerald-500 tracking-tighter">
              {loading ? (
                <div className="h-20 w-32 bg-zinc-900 animate-pulse rounded-2xl mx-auto" />
              ) : (
                proposalCount
              )}
            </div>
            <p className="text-zinc-600 font-bold tracking-[0.2em] uppercase text-xs md:text-sm">
              proposals created on-chain
            </p>
          </div>
        </div>
      </section>

      {/* Get Started CTA */}
      <section className="py-40 px-6">
        <div className="max-w-4xl mx-auto text-center space-y-10 p-16 rounded-[3rem] bg-gradient-to-b from-zinc-900/40 to-transparent border border-zinc-800 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 blur-3xl -z-10" />
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight">Ready to take control?</h2>
          <p className="text-zinc-400 text-lg md:text-xl max-w-xl mx-auto font-medium">
            Join the decentralized multisig standard and secure your community treasury today.
          </p>
          <div className="pt-6">
            <Link
              to="/app"
              className="inline-block px-12 py-5 bg-white text-black font-bold rounded-2xl transition-all hover:bg-zinc-200 active:scale-95 text-lg shadow-xl shadow-black/20"
            >
              Launch App
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-24 px-6 border-t border-zinc-900 bg-zinc-950">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between gap-16">
          <div className="space-y-6 max-w-sm">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-black">A</div>
              <span className="text-xl font-bold tracking-tight">Accord</span>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed font-medium">
              The decentralized multisig standard for trustless agreement and execution on Stellar.
            </p>
            <div className="text-xs text-zinc-600 font-mono tracking-widest pt-4">
              SOROBAN TESTNET READY
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-12 gap-y-10 md:gap-x-24">
            <div className="space-y-4">
              <h4 className="text-white font-bold text-sm tracking-wide">Resources</h4>
              <ul className="space-y-3 text-sm text-zinc-500 font-medium">
                <li><a href="https://github.com/shuaibganiyat/AccordProtocol" target="_blank" rel="noopener noreferrer" className="hover:text-emerald-500 transition-colors">GitHub</a></li>
                <li><Link to="/docs" className="hover:text-emerald-500 transition-colors">Documentation</Link></li>
                <li><a href="#" className="hover:text-emerald-500 transition-colors">Stellar Dev Docs</a></li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="text-white font-bold text-sm tracking-wide">Legal</h4>
              <div className="space-y-3 text-sm text-zinc-600 font-medium">
                <p>&copy; {new Date().getFullYear()} Accord.</p>
                <p>All rights reserved.</p>
                <div className="pt-2">
                  <a href="#" className="hover:text-zinc-400">Privacy</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
