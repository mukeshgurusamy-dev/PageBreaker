/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import * as csstree from 'css-tree';

const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10MB cap

export interface CapturedSiteResult {
  ok: true;
  finalUrl: string;
  baseUrl: string;
  title: string;
  html: string;
  spaRecovered: boolean;
  byteLength: number;
}

export class ProxyError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    value = (value << 8) | num;
  }
  return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;

  const ranges: Array<[number, number]> = [
    [0x00000000, 0x00ffffff], // 0.0.0.0/8 ("this network")
    [0x0a000000, 0x0affffff], // 10.0.0.0/8 (RFC1918)
    [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
    [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (Loopback)
    [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (Link-local & cloud metadata)
    [0xac100000, 0xac1fffff], // 172.16.0.0/12 (RFC1918)
    [0xc0000000, 0xc00000ff], // 192.0.0.0/24 (IETF protocol)
    [0xc0000200, 0xc00002ff], // 192.0.2.0/24 (TEST-NET-1)
    [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 (RFC1918)
    [0xc6120000, 0xc613ffff], // 198.18.0.0/15 (Benchmarking)
    [0xc6336400, 0xc63364ff], // 198.51.100.0/24 (TEST-NET-2)
    [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 (TEST-NET-3)
    [0xe0000000, 0xffffffff], // 224.0.0.0/4 Multicast & Reserved
  ];

  for (const [start, end] of ranges) {
    if (n >= start && n <= end) return true;
  }
  return false;
}

function isBlockedIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().split('%')[0];
  if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;

  // IPv4-mapped IPv6 ::ffff:a.b.c.d
  const v4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Match) {
    return isBlockedIpv4(v4Match[1]);
  }
  // IPv4-mapped hex ::ffff:xxxx:yyyy
  const v4HexMatch = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4HexMatch) {
    const hi = parseInt(v4HexMatch[1], 16);
    const lo = parseInt(v4HexMatch[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // Unique local fc00::/7, Link-local fe80::/10, Multicast ff00::/8
  if (/^(fc|fd|fe[89ab]|ff)/i.test(ip)) return true;
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

function normalizeAndValidateHttpUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) {
    throw new ProxyError('Invalid or excessively long URL.', 400);
  }
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const withScheme = hasExplicitScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ProxyError('Malformed URL format.', 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProxyError('Only http: and https: protocols are allowed.', 400);
  }
  if (parsed.username || parsed.password) {
    throw new ProxyError('Embedded URL credentials are not permitted.', 400);
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    throw new ProxyError('Access to internal or loopback hostnames is forbidden.', 403);
  }

  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new ProxyError('Invalid URL port.', 400);
    }
    if (portNum !== 80 && portNum !== 443 && portNum < 1024) {
      throw new ProxyError('Restricted privileged port.', 403);
    }
  }

  return parsed;
}

async function assertPublicDestination(urlObj: URL): Promise<void> {
  const hostname = urlObj.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new ProxyError('Target IP resolves to a private or reserved network.', 403);
    }
    return;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ProxyError(`DNS resolution failed for ${hostname}.`, 502);
  }

  if (!records || records.length === 0) {
    throw new ProxyError(`No DNS records found for ${hostname}.`, 502);
  }

  for (const record of records) {
    if (isBlockedIpAddress(record.address)) {
      throw new ProxyError('Resolved destination IP is private or loopback.', 403);
    }
  }
}

async function readResponseWithSizeCap(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLen = response.headers.get('content-length');
  if (declaredLen) {
    const num = Number(declaredLen);
    if (Number.isFinite(num) && num > maxBytes) {
      throw new ProxyError('Upstream payload exceeds 10MB limit.', 413);
    }
  }

  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ProxyError('Upstream payload exceeded 10MB streaming limit.', 413);
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function safeFetchWithRedirects(
  initialUrl: string,
  acceptHeader: string,
): Promise<{ response: Response; finalUrl: string; body: Uint8Array }> {
  let currentUrl = normalizeAndValidateHttpUrl(initialUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDestination(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'PageBreaker-Capture/1.0 (+https://pagebreaker.local)',
          Accept: acceptHeader,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProxyError('Upstream site timed out after 8 seconds.', 504);
      }
      throw new ProxyError(
        `Failed to fetch upstream URL: ${err instanceof Error ? err.message : 'network error'}`,
        502,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      const location = response.headers.get('location');
      if (!location) {
        throw new ProxyError('Upstream returned redirect without Location header.', 502);
      }
      if (hop === MAX_REDIRECTS) {
        throw new ProxyError('Too many redirects (> 4).', 508);
      }
      currentUrl = normalizeAndValidateHttpUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      clearTimeout(timer);
      throw new ProxyError(`Upstream responded with HTTP ${response.status}.`, 502);
    }

    try {
      const body = await readResponseWithSizeCap(response, MAX_PAYLOAD_BYTES);
      clearTimeout(timer);
      return { response, finalUrl: currentUrl.toString(), body };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  throw new ProxyError('Exceeded redirect limit.', 508);
}

function toProxiedAssetUrl(rawRef: string, baseUrl: string): string {
  const trimmed = rawRef.trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('/api/proxy-asset')
  ) {
    return trimmed;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return trimmed;
    }
    return `/api/proxy-asset?url=${encodeURIComponent(resolved.toString())}`;
  } catch {
    return trimmed;
  }
}

export function rewriteCssUrls(
  cssText: string,
  baseUrl: string,
  context: 'stylesheet' | 'value' = 'stylesheet',
): string {
  try {
    const ast = csstree.parse(cssText, {
      context,
      parseCustomProperty: true,
    });

    csstree.walk(ast, {
      enter(node: csstree.CssNode) {
        if (node.type === 'Url' && node.value) {
          node.value = toProxiedAssetUrl(node.value, baseUrl);
        } else if (
          context === 'stylesheet' &&
          node.type === 'Atrule' &&
          node.name.toLowerCase() === 'import' &&
          node.prelude
        ) {
          csstree.walk(node.prelude, (child: csstree.CssNode) => {
            if (child.type === 'String' && child.value) {
              child.value = toProxiedAssetUrl(child.value, baseUrl);
            }
          });
        }
      },
    });

    return csstree.generate(ast);
  } catch {
    // Fallback regex rewrite if exotic CSS syntax fails strict AST parsing
    return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q, inner) => {
      const proxied = toProxiedAssetUrl(inner, baseUrl);
      return `url(${q}${proxied}${q})`;
    });
  }
}

function rewriteSrcset(srcsetValue: string, baseUrl: string): string {
  return srcsetValue
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) return entry;
      const proxied = toProxiedAssetUrl(parts[0], baseUrl);
      return [proxied, ...parts.slice(1)].join(' ');
    })
    .join(', ');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizeAndRewriteHtml(
  rawHtml: string,
  baseUrl: string,
): { title: string; html: string; spaRecovered: boolean } {
  const $ = cheerio.load(rawHtml);

  const baseHref = $('base[href]').first().attr('href');
  let resolvedBase = baseUrl;
  if (baseHref && baseUrl.startsWith('http')) {
    try {
      resolvedBase = new URL(baseHref, baseUrl).toString();
    } catch {
      resolvedBase = baseUrl;
    }
  }
  $('base').remove();

  // Extract structured fallback metadata BEFORE stripping scripts in case page is an empty CSR shell
  const ogTitle =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text().trim() ||
    'Captured Website';
  const ogDesc =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';
  const ogImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    '';
  const themeColor = $('meta[name="theme-color"]').attr('content') || '#18181b';

  let nextSummary = '';
  const nextDataText = $('#__NEXT_DATA__').html();
  if (nextDataText) {
    try {
      const parsed = JSON.parse(nextDataText) as Record<string, unknown>;
      const page = typeof parsed.page === 'string' ? parsed.page : '';
      nextSummary = page ? `Route: ${page}` : 'Next.js Hydrated App Shell';
    } catch {
      // ignore invalid JSON
    }
  }

  let jsonLdName = '';
  let jsonLdDesc = '';
  $('script[type="application/ld+json"]').each((_idx, el) => {
    try {
      const parsed = JSON.parse($(el).html() || '{}') as Record<string, unknown>;
      if (!jsonLdName && typeof parsed.name === 'string') jsonLdName = parsed.name;
      if (!jsonLdDesc && typeof parsed.description === 'string') jsonLdDesc = parsed.description;
    } catch {
      // ignore
    }
  });

  // Security sanitization: strip executable scripts, CSP meta traps, SRI integrity attributes, inline on* handlers
  $('script, noscript, meta[http-equiv="refresh"], meta[http-equiv="Content-Security-Policy"]').remove();
  $('[integrity]').removeAttr('integrity');

  $('*').each((_idx, el) => {
    if (!('attribs' in el) || !el.attribs) return;
    for (const attrName of Object.keys(el.attribs)) {
      const lower = attrName.toLowerCase();
      if (lower.startsWith('on')) {
        $(el).removeAttr(attrName);
        continue;
      }
      if (lower === 'href' || lower === 'action') {
        const val = (el.attribs[attrName] || '').trim();
        if (/^(javascript|vbscript):/i.test(val)) {
          $(el).attr(attrName, '#blocked');
        } else if (val && !val.startsWith('#') && resolvedBase.startsWith('http')) {
          try {
            $(el).attr(attrName, new URL(val, resolvedBase).toString());
          } catch {
            // keep original
          }
        }
      }
    }
  });

  // Promote lazy-loaded images so 3-pass rasterizer sees crisp graphics
  $('img').each((_idx, el) => {
    const img = $(el);
    const lazySrc =
      img.attr('data-src') ||
      img.attr('data-original') ||
      img.attr('data-lazy-src') ||
      img.attr('data-url');
    if (lazySrc && (!img.attr('src') || img.attr('src')?.startsWith('data:image/gif'))) {
      img.attr('src', lazySrc);
    }
    const lazySrcset = img.attr('data-srcset');
    if (lazySrcset && !img.attr('srcset')) {
      img.attr('srcset', lazySrcset);
    }
  });

  // Rewrite stylesheet links
  $('link[rel]').each((_idx, el) => {
    const link = $(el);
    const rel = (link.attr('rel') || '').toLowerCase();
    const href = link.attr('href');
    if (!href) return;
    if (rel.includes('stylesheet') || rel.includes('icon')) {
      if (resolvedBase.startsWith('http')) {
        link.attr('href', toProxiedAssetUrl(href, resolvedBase));
      }
    }
  });

  // Rewrite image/media/source attributes while preserving local #anchor & SVG <use href="#...">
  if (resolvedBase.startsWith('http')) {
    $('img[src], source[src], video[poster], input[type="image"][src]').each((_idx, el) => {
      const node = $(el);
      const src = node.attr('src');
      if (src) node.attr('src', toProxiedAssetUrl(src, resolvedBase));
      const poster = node.attr('poster');
      if (poster) node.attr('poster', toProxiedAssetUrl(poster, resolvedBase));
    });

    $('img[srcset], source[srcset]').each((_idx, el) => {
      const node = $(el);
      const srcset = node.attr('srcset');
      if (srcset) node.attr('srcset', rewriteSrcset(srcset, resolvedBase));
    });

    $('image[href], image[xlink\\:href], use[href], use[xlink\\:href]').each((_idx, el) => {
      const node = $(el);
      const href = node.attr('href') || node.attr('xlink:href');
      if (!href || href.startsWith('#')) return;
      const proxied = toProxiedAssetUrl(href, resolvedBase);
      if (node.attr('href')) node.attr('href', proxied);
      if (node.attr('xlink:href')) node.attr('xlink:href', proxied);
    });

    $('style').each((_idx, el) => {
      const cssText = $(el).html();
      if (cssText) {
        $(el).text(rewriteCssUrls(cssText, resolvedBase, 'stylesheet'));
      }
    });

    $('[style]').each((_idx, el) => {
      const inlineStyle = $(el).attr('style');
      if (inlineStyle && inlineStyle.includes('url(')) {
        $(el).attr('style', rewriteCssUrls(inlineStyle, resolvedBase, 'value'));
      }
    });
  }

  // Empty CSR / SPA Detection & Metadata Recovery
  const bodyTextLen = $('body').text().replace(/\s+/g, ' ').trim().length;
  const landmarkCount = $('h1, h2, h3, p, article, section, button, img, table, card').length;
  let spaRecovered = false;

  if (bodyTextLen < 120 && landmarkCount < 4) {
    spaRecovered = true;
    const displayTitle = jsonLdName || ogTitle;
    const displayDesc =
      jsonLdDesc ||
      ogDesc ||
      'This target uses client-side JavaScript hydration. Recovered via metadata & structured OpenGraph extraction.';
    const proxiedHeroImg =
      ogImage && resolvedBase.startsWith('http') ? toProxiedAssetUrl(ogImage, resolvedBase) : '';

    $('body').html(`
      <header style="padding:24px 48px;background:#0f172a;color:#f8fafc;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid ${escapeHtml(themeColor)};">
        <strong style="font-size:22px;font-family:sans-serif;">${escapeHtml(displayTitle)}</strong>
        <nav style="display:flex;gap:16px;">
          <button style="padding:10px 18px;background:#f59e0b;color:#09090b;font-weight:700;border:none;border-radius:6px;">SPA Recovered</button>
          <button style="padding:10px 18px;background:#1e293b;color:#f8fafc;border:1px solid #334155;border-radius:6px;">Overview</button>
        </nav>
      </header>
      <main data-ssr-recovered="true" style="padding:48px;font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;min-height:920px;">
        <section style="background:#1f2937;border:1px solid #374151;border-radius:14px;padding:36px;margin-bottom:32px;box-shadow:0 18px 40px rgba(0,0,0,0.45);">
          <h1 style="font-size:44px;margin:0 0 16px 0;color:#ffffff;">${escapeHtml(displayTitle)}</h1>
          <p style="font-size:18px;line-height:1.6;color:#cbd5e1;max-width:780px;">${escapeHtml(displayDesc)}</p>
          ${nextSummary ? `<p style="margin-top:14px;font-family:monospace;color:#38bdf8;">${escapeHtml(nextSummary)}</p>` : ''}
        </section>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
          <article style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:28px;">
            <h2 style="margin:0 0 12px 0;color:#f59e0b;">Client-Side Shell Detected</h2>
            <p style="color:#a1a1aa;line-height:1.5;">You can also paste fully rendered DOM HTML using the "Paste HTML" option in the top bar.</p>
            <button style="margin-top:16px;padding:10px 20px;background:#06b6d4;color:#09090b;font-weight:700;border:none;border-radius:6px;">Explore Stage</button>
          </article>
          <article style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:28px;">
            ${proxiedHeroImg ? `<img src="${escapeHtml(proxiedHeroImg)}" alt="OpenGraph preview" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;" />` : `<h2 style="margin:0 0 12px 0;color:#38bdf8;">Target URL</h2><p style="color:#94a3b8;word-break:break-all;">${escapeHtml(baseUrl)}</p>`}
          </article>
        </div>
      </main>
    `);
  }

  return {
    title: ogTitle,
    html: $.html(),
    spaRecovered,
  };
}

export async function capturePublicSite(rawUrl: string): Promise<CapturedSiteResult> {
  const { response, finalUrl, body } = await safeFetchWithRedirects(
    rawUrl,
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  );

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text/plain')) {
    throw new ProxyError(`Target did not return an HTML document (${contentType}).`, 415);
  }

  const rawHtml = new TextDecoder('utf-8', { fatal: false }).decode(body);
  const { title, html, spaRecovered } = sanitizeAndRewriteHtml(rawHtml, finalUrl);

  return {
    ok: true,
    finalUrl,
    baseUrl: finalUrl,
    title,
    html,
    spaRecovered,
    byteLength: body.byteLength,
  };
}

export async function proxyPublicAsset(rawUrl: string): Promise<{
  contentType: string;
  body: Buffer;
}> {
  const { response, finalUrl, body } = await safeFetchWithRedirects(
    rawUrl,
    'text/css,image/*,font/*,*/*;q=0.8',
  );

  const rawContentType = response.headers.get('content-type') || 'application/octet-stream';
  const lowerCt = rawContentType.toLowerCase();

  if (lowerCt.includes('text/css')) {
    const cssText = new TextDecoder('utf-8', { fatal: false }).decode(body);
    const rewrittenCss = rewriteCssUrls(cssText, finalUrl, 'stylesheet');
    return {
      contentType: 'text/css; charset=utf-8',
      body: Buffer.from(rewrittenCss, 'utf8'),
    };
  }

  return {
    contentType: rawContentType,
    body: Buffer.from(body),
  };
}
