import { useMemo } from "react";
import { AppletHostAdapter } from "../core/host";
import { OriginOfLifeCanvas } from "../applets/origin_of_life/OriginOfLifeCanvas";

export function App(): JSX.Element {
  const host: AppletHostAdapter = useMemo(
    () => ({
      onClose: () => {},
      readReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
    }),
    []
  );

  return (
    <div className="app-shell">
      <main id="main-content">
        <section className="modal card">
          <OriginOfLifeCanvas host={host} />
        </section>
      </main>
    </div>
  );
}
