/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  Activity,
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  Globe,
  Layers,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { gameStore } from '../engine/GameStore';
import type { FortressTier, ShowcaseEraId, StickmanParkourState } from '../types/game';

interface HudShellProps {
  onToggleCameraMode: () => void;
  onPulseLights: () => void;
  onTriggerRagdoll: () => void;
  onTriggerShatter: () => void;
  onExitVault?: () => void;
  onResetStickman: () => void;
  onToggleZen: () => void;
  onLoadUrl: (url: string) => Promise<void>;
  onLoadShowcase: (eraId: ShowcaseEraId) => Promise<void>;
  onLoadPastedHtml: (html: string) => Promise<void>;
  onReturnToArena: () => void;
}

const STATE_LABELS: Record<StickmanParkourState, string> = {
  idle: 'Idle',
  run: 'Sprint',
  jump_rise: 'Jump Rise',
  apex_hang: 'Apex Hang',
  fast_fall: 'Fast Fall',
  wall_slide: 'Wall Slide',
  crouch_slide: 'Crouch Slide',
  shoulder_roll: 'Shoulder Roll',
  ledge_swing: 'Ledge Swing',
  flight: 'Free Flight',
  ragdoll: 'PD Ragdoll',
  kip_up: 'Kip Up',
};

const TIER_LABELS: Record<FortressTier, { label: string; colorClass: string }> = {
  tier_1_outpost: { label: 'Tier I Outpost', colorClass: 'text-zinc-300' },
  tier_2_foundry: { label: 'Tier II Foundry', colorClass: 'text-sky-400' },
  tier_3_citadel: { label: 'Tier III Citadel', colorClass: 'text-amber-400' },
  tier_4_bastion: { label: 'Tier IV Bastion', colorClass: 'text-cyan-400' },
};

const ERA_PRESETS: Array<{ id: ShowcaseEraId; label: string; year: string }> = [
  { id: '1998-retro', label: '1998 Terminal', year: '1998' },
  { id: '2016-portal', label: '2016 Portal', year: '2016' },
  { id: '2026-bastion', label: '2026 Bastion', year: '2026' },
];

export function HudShell({
  onToggleCameraMode,
  onPulseLights,
  onTriggerRagdoll,
  onTriggerShatter,
  onExitVault,
  onResetStickman,
  onToggleZen,
  onLoadUrl,
  onLoadShowcase,
  onLoadPastedHtml,
  onReturnToArena,
}: HudShellProps) {
  const hud = useSyncExternalStore(gameStore.subscribe, gameStore.getSnapshot);
  const [siteDrawerOpen, setSiteDrawerOpen] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [urlInput, setUrlInput] = useState('https://example.com');
  const [htmlInput, setHtmlInput] = useState('');

  const isBusy =
    hud.siteStatus === 'fetching' ||
    hud.siteStatus === 'analyzing' ||
    hud.siteStatus === 'baking';

  const statusText =
    hud.siteStatus === 'fetching'
      ? 'Fetching...'
      : hud.siteStatus === 'analyzing'
        ? 'Scoring CSS...'
        : hud.siteStatus === 'baking'
          ? 'Baking 2.5D...'
          : null;

  const handleUrlSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim() || isBusy) return;
    await onLoadUrl(urlInput);
    if (gameStore.getSnapshot().siteStatus === 'ready') {
      setSiteDrawerOpen(false);
    }
  };

  const handleEraSelect = async (eraId: ShowcaseEraId) => {
    if (isBusy) return;
    await onLoadShowcase(eraId);
    if (gameStore.getSnapshot().siteStatus === 'ready') {
      setSiteDrawerOpen(false);
    }
  };

  const handleHtmlSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!htmlInput.trim() || isBusy) return;
    await onLoadPastedHtml(htmlInput);
    if (gameStore.getSnapshot().siteStatus === 'ready') {
      setSiteDrawerOpen(false);
      setPasteMode(false);
    }
  };

  const tierMeta = hud.fortressTier ? TIER_LABELS[hud.fortressTier] : null;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between p-4 sm:p-5">
      {/* Top Perimeter Strip */}
      <div className="flex flex-col gap-2">
        <header className="flex items-center justify-between gap-2">
          <div className="pointer-events-auto hud-surface-subtle flex items-center gap-2.5 rounded-lg px-3.5 py-2 min-w-0 max-w-[44%] overflow-hidden">
            <span className="font-[family-name:var(--font-display)] text-sm sm:text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
              PageBreaker
            </span>
            <span className="h-3.5 w-px bg-white/10 shrink-0" aria-hidden="true" />
            {!hud.isShrunk && (
              <div className="hidden xl:flex items-center gap-2 text-xs text-zinc-400 truncate max-w-[145px]">
                <span className="truncate">{hud.siteTitle}</span>
              </div>
            )}
            {tierMeta && !hud.isShrunk && (
              <>
                <span className="h-3.5 w-px bg-white/10 hidden xl:inline shrink-0" aria-hidden="true" />
                <span className={`hidden lg:inline text-xs font-mono font-medium whitespace-nowrap shrink-0 ${tierMeta.colorClass}`}>
                  C {hud.meanCraftScore.toFixed(1)}
                </span>
              </>
            )}
            {hud.worldMode === 'website' && (
              <>
                <span className="h-3.5 w-px bg-white/10 hidden lg:inline shrink-0" aria-hidden="true" />
                <span
                  className={`hidden lg:inline text-xs font-mono font-medium tabular-nums whitespace-nowrap shrink-0 truncate max-w-[125px] ${
                    hud.isShrunk
                      ? 'text-cyan-300'
                      : hud.worldPhase === 'intact'
                        ? 'text-amber-300'
                        : 'text-cyan-300'
                  }`}
                >
                  {hud.isShrunk
                    ? `Vault · ${hud.insideVaultTitle ?? 'Chamber'}`
                    : hud.worldPhase === 'intact'
                      ? `Intact · Break ${hud.fractureCountdown.toFixed(1)}s`
                      : hud.worldPhase === 'fracturing'
                        ? 'Breaking...'
                        : 'Floating Arena'}
                </span>
              </>
            )}
            <span className="h-3.5 w-px bg-white/10 hidden sm:inline shrink-0" aria-hidden="true" />
            <span
              className={`hidden sm:inline text-xs font-medium whitespace-nowrap shrink-0 ${
                hud.isFlying ? 'text-cyan-300' : 'text-amber-400'
              }`}
            >
              {STATE_LABELS[hud.parkourState]}
            </span>
            <span className="h-3.5 w-px bg-white/10 hidden md:inline shrink-0" aria-hidden="true" />
            <span className="hidden md:inline text-xs font-mono tabular-nums text-zinc-300 whitespace-nowrap shrink-0">
              {hud.isShrunk ? 'Micro 0.38×' : `Hero ${hud.stickmanScale.toFixed(1)}×`}
            </span>
          </div>

          {!hud.zenMode && (
            <button
              type="button"
              onClick={() => setSiteDrawerOpen((v) => !v)}
              className="pointer-events-auto hud-surface-subtle flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 whitespace-nowrap shrink-0"
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
              ) : (
                <Globe className="h-3.5 w-3.5 text-cyan-400" />
              )}
              <span>{statusText ?? 'Load Site / Era'}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${
                  siteDrawerOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
          )}

          <div className="pointer-events-auto hud-surface-subtle flex items-center gap-3 rounded-lg px-3.5 py-2 text-xs font-mono tabular-nums text-zinc-300 shrink-0">
            {hud.worldMode === 'website' && (
              <>
                <div className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
                  <span className="text-zinc-500">Vaults</span>
                  <span className="text-cyan-400">
                    {hud.vaultsCleared}/{hud.totalVaults}
                  </span>
                </div>
                <span aria-hidden="true" className="text-zinc-600 hidden md:inline">·</span>
                <div className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
                  <span className="text-zinc-500">Orbs</span>
                  <span className="text-amber-300">{hud.dataOrbsCollected}</span>
                </div>
                <span aria-hidden="true" className="text-zinc-600 hidden md:inline">·</span>
                <div className="hidden sm:flex items-center gap-1.5 whitespace-nowrap">
                  <span className="text-zinc-500">Scroll</span>
                  <span className="text-cyan-400">{Math.round(hud.scrollProgress * 100)}%</span>
                </div>
                <span aria-hidden="true" className="text-zinc-600 hidden sm:inline">·</span>
              </>
            )}

            <div
              className="flex items-center gap-2 whitespace-nowrap"
              aria-label={`Lives: ${hud.integrityLives} of ${hud.maxIntegrityLives}`}
            >
              <span className="text-zinc-500 hidden xl:inline">Integrity</span>
              <div className="flex items-center gap-1">
                {Array.from({ length: hud.maxIntegrityLives }).map((_, idx) => (
                  <span
                    key={idx}
                    className={`h-2.5 w-3.5 rounded-xs transition-colors ${
                      idx < hud.integrityLives ? 'bg-red-500' : 'bg-white/12'
                    }`}
                  />
                ))}
              </div>
            </div>

            <span aria-hidden="true" className="text-zinc-600 hidden sm:inline">·</span>
            <div className="hidden sm:flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-zinc-500">Vel</span>
              <span className="text-zinc-200">{hud.stickmanSpeed.toFixed(1)}</span>
            </div>
            <span aria-hidden="true" className="text-zinc-600">·</span>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-zinc-500">FPS</span>
              <span className="text-white font-medium">{hud.fps}</span>
            </div>
          </div>
        </header>

        {/* Collapsible Live Site / Era Picker Panel */}
        {!hud.zenMode && siteDrawerOpen && (
          <div className="pointer-events-auto hud-surface mx-auto w-full max-w-2xl rounded-xl p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
                <Globe className="h-3.5 w-3.5 text-cyan-400" />
                <span>Paste any public URL or select an era showcase</span>
              </div>
              <button
                type="button"
                onClick={() => setSiteDrawerOpen(false)}
                className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
                aria-label="Close site loader"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUrlSubmit} className="flex gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com"
                disabled={isBusy}
                className="flex-1 rounded-lg bg-black/50 px-3.5 py-2 text-xs font-mono text-white placeholder:text-zinc-500 border border-white/12 focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={isBusy}
                className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-cyan-400 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {statusText ?? 'Capture URL'}
              </button>
            </form>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {ERA_PRESETS.map((era) => (
                  <button
                    key={era.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleEraSelect(era.id)}
                    className="rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/14 hover:text-white disabled:opacity-50 whitespace-nowrap"
                  >
                    {era.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPasteMode((p) => !p)}
                  className="flex items-center gap-1.5 rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/14 hover:text-white whitespace-nowrap"
                >
                  <Code2 className="h-3.5 w-3.5 text-amber-400" />
                  <span>{pasteMode ? 'Hide HTML Input' : 'Paste HTML'}</span>
                </button>

                {hud.worldMode === 'website' && (
                  <button
                    type="button"
                    onClick={() => {
                      onReturnToArena();
                      setSiteDrawerOpen(false);
                    }}
                    className="rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/14 hover:text-white whitespace-nowrap"
                  >
                    Playground Arena
                  </button>
                )}
              </div>
            </div>

            {pasteMode && (
              <form onSubmit={handleHtmlSubmit} className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
                <textarea
                  value={htmlInput}
                  onChange={(e) => setHtmlInput(e.target.value)}
                  rows={4}
                  placeholder="Paste rendered page HTML (useful for JS-heavy or authenticated apps)..."
                  disabled={isBusy}
                  className="w-full rounded-lg bg-black/50 p-3 text-xs font-mono text-zinc-200 placeholder:text-zinc-500 border border-white/12 focus:border-amber-400 focus:outline-none"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isBusy}
                    className="rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
                  >
                    Build Pasted DOM
                  </button>
                </div>
              </form>
            )}

            {hud.siteStatus === 'error' && hud.siteError && (
              <p className="mt-3 rounded-lg bg-red-500/15 border border-red-500/30 px-3 py-2 text-xs text-red-300">
                {hud.siteError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Bottom Unified Collapsible Control Dock */}
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onToggleZen}
          className="pointer-events-auto hud-surface-subtle flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 whitespace-nowrap shrink-0"
          title="Toggle Cinema / Zen Mode (H)"
        >
          {hud.zenMode ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          <span>{hud.zenMode ? 'Show Controls' : 'Hide Controls'}</span>
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
            H
          </kbd>
        </button>

        {!hud.zenMode && (
          <div className="pointer-events-auto hud-surface flex flex-col items-center gap-2 rounded-xl px-3.5 py-2.5 shadow-2xl">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onToggleCameraMode}
                className="flex items-center gap-2 rounded-lg bg-white/8 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-white/14 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 whitespace-nowrap shrink-0"
              >
                <Layers className="h-3.5 w-3.5 text-amber-400" />
                <span>
                  {hud.cameraMode === 'side_25d' ? 'View: 2.5D Front' : 'View: 3D Z-Bands'}
                </span>
                <kbd className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  V
                </kbd>
              </button>

              <button
                type="button"
                onClick={onTriggerRagdoll}
                className="flex items-center gap-2 rounded-lg bg-amber-500/15 px-3.5 py-2 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 whitespace-nowrap shrink-0"
              >
                <Activity className="h-3.5 w-3.5 text-amber-400" />
                <span>Test PD Ragdoll</span>
                <kbd className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                  X
                </kbd>
              </button>

              {hud.worldMode === 'website' && hud.worldPhase === 'intact' && (
                <button
                  type="button"
                  onClick={onTriggerShatter}
                  className="flex items-center gap-2 rounded-lg bg-cyan-500/20 px-3.5 py-2 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 whitespace-nowrap shrink-0"
                >
                  <Zap className="h-3.5 w-3.5 text-cyan-300" />
                  <span>Break Site</span>
                  <kbd className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200">
                    B
                  </kbd>
                </button>
              )}

              {hud.isShrunk && onExitVault && (
                <button
                  type="button"
                  onClick={onExitVault}
                  className="flex items-center gap-2 rounded-lg bg-amber-500/25 px-3.5 py-2 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 whitespace-nowrap shrink-0"
                >
                  <Zap className="h-3.5 w-3.5 text-amber-300" />
                  <span>Exit Vault</span>
                  <kbd className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                    E
                  </kbd>
                </button>
              )}

              <button
                type="button"
                onClick={onPulseLights}
                className="flex items-center gap-2 rounded-lg bg-white/8 px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/14 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 whitespace-nowrap shrink-0"
              >
                <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
                <span>Pulse Lights</span>
              </button>

              <button
                type="button"
                onClick={onResetStickman}
                className="flex items-center gap-2 rounded-lg bg-white/8 px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/14 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5 text-zinc-400" />
                <span>Reset</span>
                <kbd className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  R
                </kbd>
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
              <span>Move: WASD / Arrows</span>
              <span aria-hidden="true">·</span>
              <span className="text-cyan-300 font-medium">Fly: Double-Tap / Hold Space</span>
              <span aria-hidden="true">·</span>
              <span>Drop / Descend: S</span>
              <span aria-hidden="true">·</span>
              <span className="text-amber-300 font-medium">Break Card & Attack: Click / J</span>
              <span aria-hidden="true">·</span>
              <span>Enter / Exit Vault: E</span>
              <span aria-hidden="true">·</span>
              <span>Grab: F</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
