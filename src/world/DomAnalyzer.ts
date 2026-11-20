/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SPATIAL_CONSTANTS,
  type ClanId,
  type CssCraftBreakdown,
  type ExtractedDomComponent,
  type ExtractedWordBox,
  type FortressTier,
} from '../types/game';

export interface AnalyzedWebsite {
  title: string;
  url: string;
  pageWidthPx: number;
  pageHeightPx: number;
  pageHeightM: number;
  pageBgCss: string;
  isDarkTheme: boolean;
  fortressTier: FortressTier;
  meanCraftScore: number;
  components: ExtractedDomComponent[];
  words: ExtractedWordBox[];
  iframe: HTMLIFrameElement;
  doc: Document;
  dispose: () => void;
}

function parseCssRgba(colorStr: string): { r: number; g: number; b: number; a: number } | null {
  const match = colorStr.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i);
  if (!match) return null;
  return {
    r: Number(match[1]) / 255,
    g: Number(match[2]) / 255,
    b: Number(match[3]) / 255,
    a: match[4] !== undefined ? Number(match[4]) : 1,
  };
}

function linearizeSrgb(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function computeWcagLuminance(cssColor: string): number {
  const rgba = parseCssRgba(cssColor);
  if (!rgba || rgba.a < 0.05) return 0.05;
  const r = linearizeSrgb(Math.min(1, Math.max(0, rgba.r)));
  const g = linearizeSrgb(Math.min(1, Math.max(0, rgba.g)));
  const b = linearizeSrgb(Math.min(1, Math.max(0, rgba.b)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function countShadowLayers(boxShadow: string): number {
  if (!boxShadow || boxShadow === 'none') return 0;
  let depth = 0;
  let layers = 1;
  for (let i = 0; i < boxShadow.length; i++) {
    const ch = boxShadow[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) layers++;
  }
  return Math.min(4, layers);
}

function scoreToFortressTier(score: number): FortressTier {
  if (score < 2.1) return 'tier_1_outpost';
  if (score < 3.4) return 'tier_2_foundry';
  if (score < 4.9) return 'tier_3_citadel';
  return 'tier_4_bastion';
}

function scanModernStylesheetSignals(doc: Document): {
  hasCustomProps: boolean;
  hasModernColorFn: boolean;
  hasContainerQuery: boolean;
} {
  let hasCustomProps = false;
  let hasModernColorFn = false;
  let hasContainerQuery = false;

  for (let i = 0; i < doc.styleSheets.length; i++) {
    const sheet = doc.styleSheets[i];
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (let r = 0; r < rules.length; r++) {
      const txt = rules[r].cssText;
      if (!hasCustomProps && txt.includes('--')) hasCustomProps = true;
      if (
        !hasModernColorFn &&
        (txt.includes('oklch(') || txt.includes('oklab(') || txt.includes('color-mix('))
      ) {
        hasModernColorFn = true;
      }
      if (!hasContainerQuery && (txt.includes('@container') || txt.includes('container-type'))) {
        hasContainerQuery = true;
      }
    }
  }

  return { hasCustomProps, hasModernColorFn, hasContainerQuery };
}

function evaluateElementCraft(
  el: HTMLElement,
  cs: CSSStyleDeclaration,
  globalSignals: { hasCustomProps: boolean; hasModernColorFn: boolean; hasContainerQuery: boolean },
): CssCraftBreakdown {
  const shadows = countShadowLayers(cs.boxShadow);
  const backdrop = cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter') || 'none';
  const hasGlass = backdrop !== 'none' && backdrop !== '';
  const hasGradient = cs.backgroundImage.includes('gradient(');

  const bTop = parseFloat(cs.borderTopWidth) || 0;
  const bRight = parseFloat(cs.borderRightWidth) || 0;
  const bBottom = parseFloat(cs.borderBottomWidth) || 0;
  const bLeft = parseFloat(cs.borderLeftWidth) || 0;
  const maxBorder = Math.max(bTop, bRight, bBottom, bLeft);
  const radius = parseFloat(cs.borderTopLeftRadius) || 0;
  const borderStrength = Math.min(1.2, maxBorder / 4) + (radius > 2 ? 0.25 : 0);

  const fontWeight = Math.min(900, Math.max(100, parseFloat(cs.fontWeight) || 400));
  const fontWeightNorm = fontWeight / 900;

  const descendantCount = el.querySelectorAll('*').length;
  const descendantComplexity = Math.log2(1 + Math.min(64, descendantCount));

  let modernSignals = 0;
  if (globalSignals.hasCustomProps) modernSignals += 0.6;
  if (globalSignals.hasModernColorFn) modernSignals += 0.8;
  if (globalSignals.hasContainerQuery || cs.getPropertyValue('container-type') !== 'normal') {
    modernSignals += 0.7;
  }
  if (cs.display.includes('grid')) modernSignals += 0.6;

  // Weighted C_score formula
  const cScore =
    0.75 * Math.min(shadows, 4) +
    1.15 * (hasGlass ? 1 : 0) +
    0.85 * (hasGradient ? 1 : 0) +
    0.55 * borderStrength +
    0.5 * fontWeightNorm +
    0.35 * descendantComplexity +
    0.65 * modernSignals;

  return {
    shadows,
    hasGlass,
    hasGradient,
    borderStrength: Math.round(borderStrength * 100) / 100,
    fontWeightNorm: Math.round(fontWeightNorm * 100) / 100,
    descendantComplexity: Math.round(descendantComplexity * 100) / 100,
    modernSignals: Math.round(modernSignals * 100) / 100,
    cScore: Math.round(cScore * 100) / 100,
  };
}

function classifyClan(el: HTMLElement, cs: CSSStyleDeclaration): ClanId {
  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';

  if (tag === 'footer' || cls.includes('footer')) return 'footer_core';
  if (tag === 'form' || cls.includes('form') || cls.includes('newsletter') || cls.includes('guestbook')) {
    return 'form';
  }
  if (
    tag === 'button' ||
    tag === 'nav' ||
    tag === 'header' ||
    cls.includes('btn') ||
    cls.includes('nav') ||
    el.getAttribute('role') === 'button'
  ) {
    return 'button_nav';
  }
  if (
    tag === 'img' ||
    tag === 'svg' ||
    tag === 'picture' ||
    tag === 'video' ||
    cls.includes('media') ||
    cls.includes('chart') ||
    cls.includes('schematic')
  ) {
    return 'media';
  }
  if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
    return 'typography';
  }
  if (
    tag === 'article' ||
    tag === 'section' ||
    tag === 'td' ||
    cls.includes('card') ||
    cls.includes('hero') ||
    cls.includes('marquee') ||
    cs.boxShadow !== 'none'
  ) {
    return 'card';
  }
  return 'typography';
}

function collectCandidateElements(root: Element, win: Window): HTMLElement[] {
  const results: HTMLElement[] = [];
  const visited = new Set<Element>();

  const walk = (node: ParentNode) => {
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || child.nodeType !== 1) continue;
      if (visited.has(child)) continue;
      visited.add(child);

      const tag = child.tagName.toLowerCase();
      if (child.namespaceURI === 'http://www.w3.org/1999/xhtml') {
        const htmlChild = child as HTMLElement;
        const cls = typeof htmlChild.className === 'string' ? htmlChild.className.toLowerCase() : '';
        let interesting =
          tag === 'header' ||
          tag === 'nav' ||
          tag === 'section' ||
          tag === 'article' ||
          tag === 'form' ||
          tag === 'footer' ||
          tag === 'button' ||
          tag === 'a' ||
          tag === 'h1' ||
          tag === 'h2' ||
          tag === 'h3' ||
          tag === 'h4' ||
          tag === 'img' ||
          tag === 'td' ||
          tag === 'dialog' ||
          cls.includes('card') ||
          cls.includes('btn') ||
          cls.includes('media') ||
          cls.includes('chart') ||
          cls.includes('schematic') ||
          cls.includes('marquee');

        if (!interesting && (tag === 'div' || tag === 'p')) {
          const cs = win.getComputedStyle(htmlChild);
          const hasBg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
          const hasBorder = (parseFloat(cs.borderTopWidth) || 0) >= 1 || (parseFloat(cs.borderBottomWidth) || 0) >= 1;
          const hasShadow = cs.boxShadow !== 'none';
          if (tag === 'div' && (hasBg || hasBorder || hasShadow)) {
            interesting = true;
          } else if (tag === 'p' && htmlChild.textContent && htmlChild.textContent.trim().length > 16) {
            interesting = true;
          }
        }

        if (interesting) {
          results.push(htmlChild);
        }
        if (htmlChild.shadowRoot) {
          walk(htmlChild.shadowRoot);
        }
      }
      walk(child);
    }
  };

  walk(root);
  return results;
}

function extractWordsFromElement(
  doc: Document,
  el: HTMLElement,
  cs: CSSStyleDeclaration,
  scrollOffsetY: number,
  maxWords: number,
  outWords: ExtractedWordBox[],
): void {
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const fontCss = `${cs.fontWeight || '700'} ${cs.fontSize || '20px'} ${cs.fontFamily || 'sans-serif'}`;
  const color = cs.color || '#ffffff';

  let textNode: Node | null;
  while ((textNode = walker.nextNode()) !== null) {
    if (outWords.length >= maxWords) break;
    const rawText = textNode.textContent || '';
    if (!rawText.trim()) continue;

    // Split text node into word offsets and measure exact Range.getClientRects()
    const regex = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rawText)) !== null) {
      if (outWords.length >= maxWords) break;
      const word = match[0];
      if (word.length < 2) continue;

      const range = doc.createRange();
      range.setStart(textNode, match.index);
      range.setEnd(textNode, match.index + word.length);
      const rects = range.getClientRects();
      range.detach?.();

      if (rects.length === 0) continue;
      const rect = rects[0];
      if (rect.width < 8 || rect.height < 8) continue;

      const cx = (rect.left + rect.width * 0.5 - SPATIAL_CONSTANTS.DOM_VIEWPORT_WIDTH_PX * 0.5) * SPATIAL_CONSTANTS.WORLD_SCALE;
      const cy = -(rect.top + scrollOffsetY + rect.height * 0.5) * SPATIAL_CONSTANTS.WORLD_SCALE;

      outWords.push({
        id: `word-${outWords.length}`,
        text: word,
        x: cx,
        y: cy,
        w: rect.width * SPATIAL_CONSTANTS.WORLD_SCALE,
        h: rect.height * SPATIAL_CONSTANTS.WORLD_SCALE,
        color,
        fontCss,
      });
    }
  }
}

async function waitForDocumentAssets(doc: Document): Promise<void> {
  try {
    if (doc.fonts && doc.fonts.ready) {
      await Promise.race([
        doc.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    }
  } catch {
    // ignore font load issues
  }

  const imgs = Array.from(doc.querySelectorAll('img'));
  if (imgs.length > 0) {
    await Promise.race([
      Promise.all(
        imgs.map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
                return;
              }
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, 2200)),
    ]);
  }
}

/**
 * Mounts sanitized HTML inside an isolated offscreen 1280px srcdoc iframe (sandbox="allow-same-origin",
 * zero script execution), traverses DOM + Shadow DOM + open <dialog>, runs 4-decade CSS craft evaluation,
 * and measures pixel-accurate 2.5D coordinates & TreeWalker glyph boxes.
 */
export async function analyzeWebsiteHtml(
  html: string,
  title: string,
  url: string,
): Promise<AnalyzedWebsite> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.style.position = 'fixed';
  iframe.style.left = '-99999px';
  iframe.style.top = '0';
  iframe.style.width = `${SPATIAL_CONSTANTS.DOM_VIEWPORT_WIDTH_PX}px`;
  iframe.style.height = '900px';
  iframe.style.border = '0';
  iframe.style.pointerEvents = 'none';
  iframe.style.visibility = 'visible';

  document.body.appendChild(iframe);

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => resolve(), 3500);
    iframe.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    iframe.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Failed to load offscreen site frame.'));
    };
    iframe.srcdoc = html;
  });

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win || !doc.body) {
    iframe.remove();
    throw new Error('Unable to access offscreen DOM document.');
  }

  await waitForDocumentAssets(doc);

  // Legacy Quirks normalization for <marquee> & open <dialog>
  doc.querySelectorAll('marquee').forEach((mq) => {
    const el = mq as HTMLElement;
    el.style.display = 'block';
    el.style.overflow = 'hidden';
    el.style.whiteSpace = 'nowrap';
    if (el.getBoundingClientRect().height < 24) {
      el.style.minHeight = '36px';
    }
  });
  doc.querySelectorAll('dialog[open]').forEach((dlg) => {
    (dlg as HTMLElement).style.display = 'block';
  });

  // Allow CSS layout pass to settle & measure full scrollHeight cleanly
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

  const pageWidthPx = SPATIAL_CONSTANTS.DOM_VIEWPORT_WIDTH_PX;
  const rawScrollH = Math.max(
    doc.body.scrollHeight,
    doc.documentElement?.scrollHeight || 0,
    960,
  );
  const pageHeightPx = Math.min(12288, Math.max(960, rawScrollH));
  iframe.style.height = `${pageHeightPx}px`;

  // Re-check layout after sizing iframe cleanly to full document height
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

  const bodyCs = win.getComputedStyle(doc.body);
  const htmlCs = doc.documentElement ? win.getComputedStyle(doc.documentElement) : bodyCs;
  let pageBgCss = bodyCs.backgroundColor;
  if (!pageBgCss || pageBgCss === 'rgba(0, 0, 0, 0)' || pageBgCss === 'transparent') {
    pageBgCss = htmlCs.backgroundColor;
  }
  if (!pageBgCss || pageBgCss === 'rgba(0, 0, 0, 0)' || pageBgCss === 'transparent') {
    pageBgCss = '#ffffff';
  }
  const isDarkTheme = computeWcagLuminance(pageBgCss) < 0.22;

  const globalSignals = scanModernStylesheetSignals(doc);
  const candidates = collectCandidateElements(doc.body, win);

  const components: ExtractedDomComponent[] = [];
  const words: ExtractedWordBox[] = [];
  const seenBoxes: Array<{ l: number; t: number; w: number; h: number }> = [];
  const containerBoxes: Array<{ l: number; t: number; r: number; b: number; el: HTMLElement }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
      continue;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 20) continue;

    // Skip whole-page or multi-section layout wrappers (e.g., .window-frame, #root, page shells)
    const tag = el.tagName.toLowerCase();
    if (rect.width > pageWidthPx * 0.72 && rect.height > pageHeightPx * 0.45) continue;
    if (
      (tag === 'div' || tag === 'td') &&
      el.querySelectorAll('header, nav, section, article, form, footer, table').length >= 2
    ) {
      continue;
    }

    // Deduplicate identical nested bounding boxes
    const duplicateBox = seenBoxes.some(
      (b) =>
        Math.abs(b.l - rect.left) < 8 &&
        Math.abs(b.t - rect.top) < 8 &&
        Math.abs(b.w - rect.width) < 12 &&
        Math.abs(b.h - rect.height) < 12,
    );
    if (duplicateBox) continue;

    const craft = evaluateElementCraft(el, cs, globalSignals);
    const tier = scoreToFortressTier(craft.cScore);
    const clanId = classifyClan(el, cs);

    // Check if this element sits cleanly inside an already-extracted structural container
    const enclosingParent = containerBoxes.find(
      (cb) =>
        cb.el.contains(el) &&
        rect.left >= cb.l - 4 &&
        rect.right <= cb.r + 4 &&
        rect.top >= cb.t - 4 &&
        rect.bottom <= cb.b + 4,
    );

    const isInteractiveChild =
      tag === 'button' ||
      tag === 'a' ||
      tag === 'input' ||
      tag === 'select' ||
      el.getAttribute('role') === 'button';

    // Always extract text words for Glyph Atlas / destructible typography, even inside cards
    const compWords: ExtractedWordBox[] = [];
    if ((clanId === 'typography' || clanId === 'button_nav') && words.length < 110) {
      extractWordsFromElement(doc, el, cs, 0, 110 - words.length, compWords);
      for (const wb of compWords) words.push(wb);
    }

    // Avoid Z-fighting duplicate slabs for passive headings/paragraphs/nav-wrappers inside cards
    if (enclosingParent && !isInteractiveChild) {
      continue;
    }

    seenBoxes.push({ l: rect.left, t: rect.top, w: rect.width, h: rect.height });
    if (
      tag === 'header' ||
      tag === 'section' ||
      tag === 'article' ||
      tag === 'form' ||
      tag === 'footer' ||
      (tag === 'div' && (clanId === 'card' || clanId === 'media'))
    ) {
      containerBoxes.push({
        l: rect.left,
        t: rect.top,
        r: rect.right,
        b: rect.bottom,
        el,
      });
    }

    const wM = rect.width * SPATIAL_CONSTANTS.WORLD_SCALE;
    const hM = rect.height * SPATIAL_CONSTANTS.WORLD_SCALE;
    const xM =
      (rect.left + rect.width * 0.5 - SPATIAL_CONSTANTS.DOM_VIEWPORT_WIDTH_PX * 0.5) *
      SPATIAL_CONSTANTS.WORLD_SCALE;
    const yM = -(rect.top + rect.height * 0.5) * SPATIAL_CONSTANTS.WORLD_SCALE;

    const isHollowCard = clanId === 'card' && wM >= 1.8 && hM >= 1.2;
    const isStickyNav =
      (clanId === 'button_nav' && (cs.position === 'sticky' || cs.position === 'fixed')) ||
      tag === 'header';

    const accentColor =
      cs.borderTopColor && cs.borderTopColor !== 'rgba(0, 0, 0, 0)'
        ? cs.borderTopColor
        : cs.backgroundColor || (isDarkTheme ? '#f59e0b' : '#2563eb');

    components.push({
      id: `dom-${components.length}`,
      tagName: tag,
      clanId,
      x: xM,
      y: yM,
      w: wM,
      h: hM,
      pxLeft: Math.max(0, Math.floor(rect.left)),
      pxTop: Math.max(0, Math.floor(rect.top)),
      pxWidth: Math.min(pageWidthPx, Math.ceil(rect.width)),
      pxHeight: Math.min(pageHeightPx, Math.ceil(rect.height)),
      craft,
      tier,
      isHollowCard,
      isStickyNav,
      accentColor,
      labelText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48),
      words: compWords,
      element: el,
    });

    if (components.length >= 64) break;
  }

  let scoreSum = 0;
  for (const c of components) scoreSum += c.craft.cScore;
  const meanCraftScore =
    components.length > 0 ? Math.round((scoreSum / components.length) * 100) / 100 : 1.5;
  const fortressTier = scoreToFortressTier(meanCraftScore);
  const pageHeightM = pageHeightPx * SPATIAL_CONSTANTS.WORLD_SCALE;

  return {
    title: doc.title || title || 'Captured Website',
    url,
    pageWidthPx,
    pageHeightPx,
    pageHeightM,
    pageBgCss,
    isDarkTheme,
    fortressTier,
    meanCraftScore,
    components,
    words,
    iframe,
    doc,
    dispose: () => {
      iframe.remove();
    },
  };
}
