/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RendererShell } from './engine/RendererShell';
import { gameStore } from './engine/GameStore';
import { HudShell } from './ui/HudShell';

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<RendererShell | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const hud = useSyncExternalStore(gameStore.subscribe, gameStore.getSnapshot);

  useEffect(() => {
    const mountEl = canvasMountRef.current;
    if (!mountEl) return;

    try {
      const shell = new RendererShell(mountEl);
      engineRef.current = shell;
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Unable to initialize WebGL2 context.');
    }

    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  return (
    <main className="relative h-full w-full overflow-hidden bg-obsidian-950">
      <div ref={canvasMountRef} className="absolute inset-0 h-full w-full" />

      {initError || hud.capabilities.contextLost ? (
        <div className="relative z-20 flex h-full w-full items-center justify-center p-6">
          <div className="hud-surface max-w-md rounded-xl p-6 text-center">
            <h1 className="font-[family-name:var(--font-display)] text-lg font-bold text-white">
              Graphics Context Unavailable
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              {initError ?? 'The WebGL2 graphics context was interrupted and is attempting recovery.'}
            </p>
          </div>
        </div>
      ) : (
        <HudShell
          onToggleCameraMode={() => engineRef.current?.toggleCameraMode()}
          onPulseLights={() => engineRef.current?.triggerPointLightPulseWave()}
          onTriggerRagdoll={() => engineRef.current?.triggerRagdollTest()}
          onTriggerShatter={() => engineRef.current?.triggerShatterNow()}
          onExitVault={() => engineRef.current?.exitActiveVault()}
          onResetStickman={() => engineRef.current?.resetStickman()}
          onToggleZen={() => engineRef.current?.toggleZenMode()}
          onLoadUrl={(url) => engineRef.current?.loadPublicUrl(url) ?? Promise.resolve()}
          onLoadShowcase={(eraId) => engineRef.current?.loadShowcaseEra(eraId) ?? Promise.resolve()}
          onLoadPastedHtml={(html) => engineRef.current?.loadPastedHtml(html) ?? Promise.resolve()}
          onReturnToArena={() => engineRef.current?.returnToArena()}
        />
      )}
    </main>
  );
}
