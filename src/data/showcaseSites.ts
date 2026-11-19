/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShowcaseEraId } from '../types/game';

export interface ShowcaseSitePreset {
  id: ShowcaseEraId;
  label: string;
  eraYear: string;
  title: string;
  url: string;
  html: string;
}

const RETRO_1998_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>CyberGrid 98 // Retro Web Terminal</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1280px;
    background: #008080;
    color: #111111;
    font-family: "Times New Roman", Georgia, serif;
  }
  .window-frame {
    width: 1180px;
    margin: 28px auto;
    background: #c0c0c0;
    border-top: 3px solid #ffffff;
    border-left: 3px solid #ffffff;
    border-right: 3px solid #404040;
    border-bottom: 3px solid #404040;
    padding: 12px;
  }
  header.titlebar {
    background: #000080;
    color: #ffffff;
    padding: 14px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 3px solid #404040;
  }
  .titlebar h1 {
    margin: 0;
    font-size: 28px;
    font-family: "Courier New", monospace;
    letter-spacing: 1px;
  }
  .marquee-bar {
    background: #000000;
    color: #00ff66;
    font-family: "Courier New", monospace;
    font-size: 16px;
    padding: 10px 18px;
    margin: 12px 0;
    border: 2px inset #808080;
  }
  nav.retro-nav {
    display: flex;
    gap: 12px;
    margin: 14px 0 22px 0;
  }
  .win-btn {
    background: #d4d0c8;
    color: #000000;
    font-family: Tahoma, Arial, sans-serif;
    font-size: 15px;
    font-weight: 700;
    padding: 10px 20px;
    border-top: 2px solid #ffffff;
    border-left: 2px solid #ffffff;
    border-right: 2px solid #404040;
    border-bottom: 2px solid #404040;
  }
  .hero-banner {
    background: #ffffff;
    border: 3px ridge #808080;
    padding: 28px 32px;
    margin-bottom: 24px;
  }
  .hero-banner h2 {
    margin: 0 0 12px 0;
    font-size: 38px;
    color: #000080;
  }
  .hero-banner p {
    margin: 0;
    font-size: 18px;
    line-height: 1.5;
  }
  table.portal-grid {
    width: 100%;
    border-collapse: separate;
    border-spacing: 18px;
    margin-bottom: 22px;
  }
  article.retro-card {
    background: #dfdfdf;
    border: 3px outset #ffffff;
    padding: 22px;
    vertical-align: top;
  }
  article.retro-card h3 {
    margin: 0 0 10px 0;
    font-size: 22px;
    color: #800000;
    font-family: "Courier New", monospace;
  }
  .media-strip {
    display: flex;
    gap: 24px;
    margin: 22px 0;
  }
  .terminal-media {
    flex: 1;
    background: #090d16;
    border: 3px inset #808080;
    padding: 18px;
    color: #33ff99;
    font-family: "Courier New", monospace;
  }
  form.guestbook {
    background: #d4d0c8;
    border: 3px groove #ffffff;
    padding: 24px;
    margin: 22px 0;
  }
  form.guestbook h3 {
    margin: 0 0 12px 0;
    font-size: 22px;
  }
  .guest-row {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .guest-input {
    width: 360px;
    height: 40px;
    background: #ffffff;
    border: 2px inset #404040;
    padding: 8px 12px;
    font-family: "Courier New", monospace;
    font-size: 15px;
  }
  footer.webring {
    background: #000080;
    color: #ffff00;
    padding: 24px;
    text-align: center;
    font-family: "Courier New", monospace;
    border: 3px ridge #ffffff;
  }
</style>
</head>
<body>
  <div class="window-frame">
    <header class="titlebar">
      <h1>CYBERGRID // TERMINAL 1998</h1>
      <span style="font-family:monospace;font-size:14px;">EST. 1998 · 800x600 READY</span>
    </header>

    <div class="marquee-bar">
      <marquee scrollamount="4">*** WELCOME TO CYBERGRID NET-PORTAL *** HIT COUNTER: 004,912 *** BEST VIEWED IN CRT MONITOR ***</marquee>
    </div>

    <nav class="retro-nav">
      <button class="win-btn" type="button">Directory</button>
      <button class="win-btn" type="button">Shareware</button>
      <button class="win-btn" type="button">IRC Nodes</button>
      <button class="win-btn" type="button">Guestbook</button>
    </nav>

    <section class="hero-banner">
      <h2>World Wide Web Frontier Index</h2>
      <p>Navigate raw HTML tables, beveled Netscape buttons, and dial-up shareware nodes arranged cleanly across physical 2.5D depth.</p>
    </section>

    <table class="portal-grid">
      <tr>
        <td style="width:33%;">
          <article class="retro-card">
            <h3>[01] Shareware Vault</h3>
            <p>Archived 16-bit tools, tracker music MOD files, and ASCII readme archives.</p>
            <button class="win-btn" type="button" style="margin-top:14px;">Browse Files</button>
          </article>
        </td>
        <td style="width:33%;">
          <article class="retro-card">
            <h3>[02] Hyperlink Ring</h3>
            <p>Explore curated academic gopher mirrors and classic homepages worldwide.</p>
            <button class="win-btn" type="button" style="margin-top:14px;">Next Node</button>
          </article>
        </td>
        <td style="width:33%;">
          <article class="retro-card">
            <h3>[03] BBS Gateways</h3>
            <p>Connect to telnet nodes, ANSI art galleries, and dial-up message boards.</p>
            <button class="win-btn" type="button" style="margin-top:14px;">Connect 56k</button>
          </article>
        </td>
      </tr>
    </table>

    <div class="media-strip">
      <div class="terminal-media">
        <svg viewBox="0 0 420 140" width="420" height="140" role="img" aria-label="Network Topology">
          <rect width="420" height="140" fill="#090d16" />
          <line x1="40" y1="70" x2="180" y2="38" stroke="#00ff66" stroke-width="2" />
          <line x1="180" y1="38" x2="340" y2="96" stroke="#00ff66" stroke-width="2" />
          <circle cx="40" cy="70" r="14" fill="#ffff00" />
          <circle cx="180" cy="38" r="16" fill="#00ffff" />
          <circle cx="340" cy="96" r="14" fill="#ff00ff" />
          <text x="20" y="124" fill="#33ff99" font-family="monospace" font-size="14">TRACE: 56K MODEM LINK ACTIVE</text>
        </svg>
      </div>
      <div class="terminal-media">
        <svg viewBox="0 0 420 140" width="420" height="140" role="img" aria-label="Web Counter Badge">
          <rect width="420" height="140" fill="#0d111a" />
          <rect x="24" y="26" width="372" height="88" fill="#000000" stroke="#00ff66" stroke-width="2" />
          <text x="48" y="64" fill="#00ff66" font-family="monospace" font-size="22">VISITORS: 004912</text>
          <text x="48" y="96" fill="#ffff00" font-family="monospace" font-size="14">HTML 3.2 COMPLIANT</text>
        </svg>
      </div>
    </div>

    <form class="guestbook">
      <h3>Sign the CyberGrid Guestbook</h3>
      <div class="guest-row">
        <input class="guest-input" type="text" value="Handle: CyberRunner98" readonly />
        <button class="win-btn" type="button">Post Entry</button>
      </div>
    </form>

    <footer class="webring">
      <strong>&lt;&lt; PREV SITE | CYBERGRID WEBRING 1998 | NEXT SITE &gt;&gt;</strong>
    </footer>
  </div>
</body>
</html>`;

const PORTAL_2016_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Nimbus Cloud // 2016 Responsive Portal</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1280px;
    background: #f8fafc;
    color: #0f172a;
    font-family: "Helvetica Neue", Arial, sans-serif;
  }
  header.navbar {
    position: sticky;
    top: 0;
    background: #ffffff;
    border-bottom: 1px solid #e2e8f0;
    box-shadow: 0 2px 10px rgba(15, 23, 42, 0.06);
    padding: 18px 56px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .brand {
    font-size: 24px;
    font-weight: 800;
    color: #1d4ed8;
  }
  nav.nav-links {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .nav-btn {
    background: #eff6ff;
    color: #1e40af;
    border: 1px solid #bfdbfe;
    border-radius: 6px;
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
  }
  .cta-btn {
    background: linear-gradient(135deg, #2563eb, #0284c7);
    color: #ffffff;
    border: none;
    border-radius: 6px;
    padding: 12px 24px;
    font-size: 15px;
    font-weight: 700;
    box-shadow: 0 6px 16px rgba(37, 99, 235, 0.28);
  }
  section.hero {
    background: linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%);
    color: #ffffff;
    padding: 58px 56px;
    margin: 24px 48px;
    border-radius: 16px;
    box-shadow: 0 20px 38px rgba(15, 23, 42, 0.16);
  }
  section.hero h1 {
    margin: 0 0 14px 0;
    font-size: 46px;
    font-weight: 800;
  }
  section.hero p {
    margin: 0 0 24px 0;
    font-size: 19px;
    color: #e0f2fe;
    max-width: 760px;
    line-height: 1.55;
  }
  .card-row {
    display: flex;
    gap: 24px;
    padding: 12px 48px 34px 48px;
  }
  article.saas-card {
    flex: 1;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 28px;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08), 0 2px 6px rgba(15, 23, 42, 0.04);
  }
  article.saas-card h2 {
    margin: 0 0 10px 0;
    font-size: 22px;
    font-weight: 700;
    color: #0f172a;
  }
  article.saas-card p {
    margin: 0 0 18px 0;
    font-size: 15px;
    line-height: 1.55;
    color: #475569;
  }
  .showcase-media {
    margin: 8px 48px 34px 48px;
    display: flex;
    gap: 24px;
  }
  .chart-panel {
    flex: 1;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 12px;
    padding: 22px;
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
  }
  form.newsletter {
    margin: 8px 48px 36px 48px;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 12px;
    padding: 28px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
  }
  .email-input {
    width: 340px;
    height: 44px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 0 14px;
    font-size: 15px;
    background: #f8fafc;
  }
  footer.portal-footer {
    background: #0f172a;
    color: #cbd5e1;
    padding: 40px 56px;
    margin-top: 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
</style>
</head>
<body>
  <header class="navbar">
    <span class="brand">NimbusCloud // 2016</span>
    <nav class="nav-links">
      <button class="nav-btn" type="button">Platform</button>
      <button class="nav-btn" type="button">Metrics</button>
      <button class="nav-btn" type="button">Pricing</button>
      <button class="cta-btn" type="button">Start Free Trial</button>
    </nav>
  </header>

  <section class="hero">
    <h1>Deploy Responsive Microservices Fast</h1>
    <p>Flat-UI gradients, material elevation shadows, and structured Flexbox tiers translated into crisp light-mode 2.5D terrain.</p>
    <button class="cta-btn" type="button">Launch Cluster</button>
  </section>

  <div class="card-row">
    <article class="saas-card">
      <h2>Auto-Scaling Nodes</h2>
      <p>Provision containerized compute across three global regions with balanced Flexbox service cards.</p>
      <button class="nav-btn" type="button">Inspect Fleet</button>
    </article>
    <article class="saas-card">
      <h2>Realtime Telemetry</h2>
      <p>Track p99 response latency, throughput spikes, and edge cache hits inside modular containers.</p>
      <button class="nav-btn" type="button">Open Charts</button>
    </article>
    <article class="saas-card">
      <h2>Zero-Downtime CI</h2>
      <p>Roll out immutable artifacts cleanly with instant rollback snapshots and health probes.</p>
      <button class="nav-btn" type="button">View Pipelines</button>
    </article>
  </div>

  <div class="showcase-media">
    <div class="chart-panel">
      <svg viewBox="0 0 540 160" width="540" height="160" role="img" aria-label="Cluster Throughput Chart">
        <rect width="540" height="160" rx="8" fill="#f1f5f9" />
        <polyline points="24,132 108,108 192,118 276,66 360,82 444,34 516,42" fill="none" stroke="#2563eb" stroke-width="5" stroke-linecap="round" />
        <circle cx="276" cy="66" r="7" fill="#0284c7" />
        <circle cx="444" cy="34" r="7" fill="#0284c7" />
        <text x="24" y="34" fill="#334155" font-family="sans-serif" font-size="16" font-weight="700">THROUGHPUT // 99.98% SLA</text>
      </svg>
    </div>
    <div class="chart-panel">
      <svg viewBox="0 0 540 160" width="540" height="160" role="img" aria-label="Region Latency">
        <rect width="540" height="160" rx="8" fill="#f1f5f9" />
        <rect x="42" y="54" width="84" height="82" rx="6" fill="#2563eb" />
        <rect x="166" y="36" width="84" height="100" rx="6" fill="#0284c7" />
        <rect x="290" y="68" width="84" height="68" rx="6" fill="#0d9488" />
        <rect x="414" y="48" width="84" height="88" rx="6" fill="#4f46e5" />
        <text x="42" y="32" fill="#334155" font-family="sans-serif" font-size="15" font-weight="700">REGIONAL LOAD DISTRIBUTION</text>
      </svg>
    </div>
  </div>

  <form class="newsletter">
    <div>
      <h2 style="margin:0 0 6px 0;font-size:22px;">Subscribe to Release Notes</h2>
      <span style="color:#64748b;font-size:15px;">Monthly platform engineering digests, zero spam.</span>
    </div>
    <div style="display:flex;gap:12px;">
      <input class="email-input" type="email" value="architect@nimbus.example" readonly />
      <button class="cta-btn" type="button">Subscribe</button>
    </div>
  </form>

  <footer class="portal-footer">
    <strong>NimbusCloud Systems · 2016 Material Edition</strong>
    <span>Status: All Systems Operational</span>
  </footer>
</body>
</html>`;

const BASTION_2026_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Aether Foundry // 2026 Design-System Bastion</title>
<style>
  :root {
    --bg-obsidian: #09090b;
    --surface-card: #121218;
    --accent-amber: oklch(0.77 0.17 70);
    --accent-cyan: oklch(0.74 0.14 210);
    --border-hairline: rgba(255, 255, 255, 0.14);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1280px;
    background: var(--bg-obsidian);
    color: #f4f4f5;
    font-family: "Inter", "Plus Jakarta Sans", sans-serif;
  }
  header.glass-nav {
    position: sticky;
    top: 0;
    background: rgba(18, 18, 24, 0.88);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border-hairline);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255, 255, 255, 0.08);
    padding: 18px 52px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .logo-mark {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #ffffff;
  }
  nav.hud-links {
    display: flex;
    gap: 12px;
  }
  .token-btn {
    background: linear-gradient(145deg, #27272f, #18181f);
    color: #f4f4f5;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 8px;
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  }
  .accent-btn {
    background: linear-gradient(135deg, #f59e0b, #ea580c);
    color: #09090b;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 8px;
    padding: 12px 24px;
    font-size: 15px;
    font-weight: 800;
    box-shadow: 0 10px 26px rgba(245, 158, 11, 0.35), 0 2px 6px rgba(0, 0, 0, 0.5);
  }
  section.bastion-hero {
    margin: 28px 48px;
    padding: 46px 48px;
    border-radius: 18px;
    background: radial-gradient(circle at top right, rgba(6, 182, 212, 0.18), transparent 45%),
                linear-gradient(160deg, #16161d 0%, #0f1015 100%);
    border: 1px solid var(--border-hairline);
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.55), 0 8px 18px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }
  section.bastion-hero h1 {
    margin: 0 0 14px 0;
    font-size: 48px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  section.bastion-hero p {
    margin: 0 0 24px 0;
    font-size: 18px;
    line-height: 1.6;
    color: #a1a1aa;
    max-width: 780px;
  }
  .bento-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 22px;
    margin: 0 48px 28px 48px;
  }
  article.bento-card {
    container-type: inline-size;
    background: linear-gradient(180deg, rgba(28, 28, 36, 0.92), rgba(16, 16, 22, 0.96));
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 14px;
    padding: 26px;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.52), 0 4px 12px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
  article.bento-card h2 {
    margin: 0 0 10px 0;
    font-size: 22px;
    font-weight: 700;
    color: #f8fafc;
  }
  article.bento-card p {
    margin: 0 0 18px 0;
    font-size: 15px;
    line-height: 1.55;
    color: #9ca3af;
  }
  .subgrid-showcase {
    display: grid;
    grid-template-columns: 1.3fr 1fr;
    gap: 22px;
    margin: 0 48px 28px 48px;
  }
  .schematic-box {
    background: #111218;
    border: 1px solid rgba(6, 182, 212, 0.32);
    border-radius: 14px;
    padding: 22px;
    box-shadow: 0 16px 34px rgba(0, 0, 0, 0.5), 0 0 24px rgba(6, 182, 212, 0.12);
  }
  form.command-form {
    margin: 0 48px 34px 48px;
    background: linear-gradient(135deg, #16171f, #111218);
    border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 14px;
    padding: 28px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 18px 36px rgba(0, 0, 0, 0.55);
  }
  .cmd-input {
    width: 380px;
    height: 44px;
    background: #09090b;
    color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.38);
    border-radius: 8px;
    padding: 0 14px;
    font-family: "JetBrains Mono", monospace;
    font-size: 14px;
  }
  footer.bastion-core {
    background: linear-gradient(180deg, #121218, #070709);
    border-top: 2px solid rgba(245, 158, 11, 0.45);
    padding: 42px 52px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.5);
  }
</style>
</head>
<body>
  <header class="glass-nav">
    <span class="logo-mark">AETHER // BASTION 2026</span>
    <nav class="hud-links">
      <button class="token-btn" type="button">Tokens</button>
      <button class="token-btn" type="button">Subgrid</button>
      <button class="token-btn" type="button">Shaders</button>
      <button class="accent-btn" type="button">Initialize Core</button>
    </nav>
  </header>

  <section class="bastion-hero">
    <h1>Tier IV Obsidian Design Bastion</h1>
    <p>Constructed with custom properties, CSS Grid containers, backdrop-filter glass stacks, and oklch() color tokens—synthesizing maximum CSS Craft armor.</p>
    <button class="accent-btn" type="button">Inspect Architecture</button>
  </section>

  <div class="bento-grid">
    <article class="bento-card">
      <h2>Design Token Matrix</h2>
      <p>Nested custom variables and multi-layer ambient occlusion shadows reinforce component rigidity.</p>
      <button class="token-btn" type="button">Token Graph</button>
    </article>
    <article class="bento-card">
      <h2>Glassmorphic Vaults</h2>
      <p>Translucent backdrop-filter chambers conceal Band -1 structural rooms waiting behind front shells.</p>
      <button class="token-btn" type="button">Scan Depth</button>
    </article>
    <article class="bento-card">
      <h2>Container Queries</h2>
      <p>Adaptive grid cards calibrate bevel thickness and titanium trim straight from computed CSS signals.</p>
      <button class="token-btn" type="button">Verify Layout</button>
    </article>
  </div>

  <div class="subgrid-showcase">
    <div class="schematic-box">
      <svg viewBox="0 0 640 170" width="640" height="170" role="img" aria-label="Spatial Depth Diagram">
        <rect width="640" height="170" rx="10" fill="#09090b" />
        <rect x="28" y="34" width="140" height="102" rx="8" fill="#18181f" stroke="#38bdf8" stroke-width="2" />
        <rect x="240" y="34" width="160" height="102" rx="8" fill="#18181f" stroke="#f59e0b" stroke-width="2" />
        <rect x="468" y="34" width="144" height="102" rx="8" fill="#18181f" stroke="#22c55e" stroke-width="2" />
        <line x1="168" y1="85" x2="240" y2="85" stroke="#64748b" stroke-width="2" stroke-dasharray="6 4" />
        <line x1="400" y1="85" x2="468" y2="85" stroke="#64748b" stroke-width="2" stroke-dasharray="6 4" />
        <text x="50" y="90" fill="#38bdf8" font-family="monospace" font-size="14">BAND -2</text>
        <text x="275" y="90" fill="#f59e0b" font-family="monospace" font-size="14">BAND -1</text>
        <text x="502" y="90" fill="#22c55e" font-family="monospace" font-size="14">BAND 0</text>
      </svg>
    </div>
    <div class="schematic-box">
      <svg viewBox="0 0 420 170" width="420" height="170" role="img" aria-label="Craft Armor Meter">
        <rect width="420" height="170" rx="10" fill="#09090b" />
        <rect x="28" y="42" width="364" height="22" rx="6" fill="#1e293b" />
        <rect x="28" y="42" width="328" height="22" rx="6" fill="#f59e0b" />
        <rect x="28" y="88" width="364" height="22" rx="6" fill="#1e293b" />
        <rect x="28" y="88" width="296" height="22" rx="6" fill="#06b6d4" />
        <text x="28" y="142" fill="#cbd5e1" font-family="monospace" font-size="13">CSS CRAFT RATING // TIER IV BASTION</text>
      </svg>
    </div>
  </div>

  <form class="command-form">
    <div>
      <h2 style="margin:0 0 6px 0;font-size:22px;color:#ffffff;">Dispatch Bastion Telemetry</h2>
      <span style="color:#94a3b8;font-size:14px;">Submit command payloads directly to the bottom fortress node.</span>
    </div>
    <div style="display:flex;gap:12px;">
      <input class="cmd-input" type="text" value="sync --band-depth 4 --tier bastion" readonly />
      <button class="accent-btn" type="button">Execute</button>
    </div>
  </form>

  <footer class="bastion-core">
    <strong style="font-size:18px;color:#f59e0b;">AETHER BASTION CORE // SECTOR FOOTER</strong>
    <span style="font-family:monospace;color:#94a3b8;">TOKENS VERIFIED · 4-BAND READY</span>
  </footer>
</body>
</html>`;

export const SHOWCASE_SITES: Record<ShowcaseEraId, ShowcaseSitePreset> = {
  '1998-retro': {
    id: '1998-retro',
    label: '1998 Terminal',
    eraYear: '1998',
    title: 'CyberGrid 98 // Retro Web Terminal',
    url: 'showcase://1998-retro',
    html: RETRO_1998_HTML,
  },
  '2016-portal': {
    id: '2016-portal',
    label: '2016 Portal',
    eraYear: '2016',
    title: 'Nimbus Cloud // 2016 Responsive Portal',
    url: 'showcase://2016-portal',
    html: PORTAL_2016_HTML,
  },
  '2026-bastion': {
    id: '2026-bastion',
    label: '2026 Bastion',
    eraYear: '2026',
    title: 'Aether Foundry // 2026 Design-System Bastion',
    url: 'showcase://2026-bastion',
    html: BASTION_2026_HTML,
  },
};
