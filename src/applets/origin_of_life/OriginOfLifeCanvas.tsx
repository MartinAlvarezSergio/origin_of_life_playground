import { useEffect, useRef, useState } from "react";
import { setLogicalTransform } from "../../core/canvasScale";
import { AppletHostAdapter } from "../../core/host";
import { AppletStage } from "../../ui/stage/AppletStage";
import { useCanvasBackingStore } from "../../ui/stage/hooks";
import {
  StageDivider,
  StageHero,
  StageIconButton,
  StagePillButton,
  StagePills,
  StageReadout,
  StageSection,
  StageSegmented,
  StageSlider,
  StageToggle
} from "../../ui/stage/StageControls";
import { ALKALINE_DEFAULTS, DEFAULT_SETTINGS, poreTemperature, SMOKER_TEMPERATURE, VENT_LIMITS } from "./environment";
import { clearLens, createLens, updateLens, type Lens } from "./lens";
import { drawHistogram, drawScene, HIST_H, HIST_W, lensShape, RUNG_LABELS, SCENE_H, SCENE_W, SETTING_NAMES, type SceneView } from "./render";
import { createChem, EVENTS_FOR, RUNGS, stepChem, THRESHOLD, triggerEvent } from "./sim";
import type { ChemState, EventKind, HazardLevel, SettingId, Settings, ViewId } from "./types";
import "./originOfLife.css";

type Props = {
  host?: AppletHostAdapter;
};

const SETTINGS_ORDER: SettingId[] = ["pool", "ocean", "vent"];
const SHORT_NAMES: Record<SettingId, string> = { pool: "Pool", ocean: "Ocean", vent: "Vent" };
/** Cycles per second at 1×: one wet–dry cycle every 2.5 s. */
const CYCLES_PER_SECOND = 0.4;

const SPEEDS = [
  { value: 1, label: "1×" },
  { value: 5, label: "5×" },
  { value: 25, label: "25×" }
];

const TIP = {
  pool: "A shallow pool on volcanic land that fills with rain and dries in the sun, over and over.",
  ocean: "The open ocean, far from land and vents.",
  vent: "A hydrothermal vent on the sea floor: warm, mineral-rich fluid seeping out of a porous chimney.",
  compare: "Run all three settings side by side, each with its own controls.",
  play: "Start or pause time.",
  reset: "Start the chemistry again from nothing.",
  speed: "How fast time runs. One cycle is one wet–dry cycle of the pool.",
  drying: "How far the pool shrinks in each dry spell. Drying concentrates the building blocks and pulls water out of the bonds being made, so they join.",
  uv: "Sunlight drives the chemistry that makes building blocks from simple molecules, but its UV also damages them.",
  poolTemperature: "Warm water speeds up every reaction, but water breaks chains apart faster still.",
  phosphate: "Phosphate is part of every nucleotide. Some lakes collect a lot of it; others have very little.",
  clay: "Clay mineral surfaces line building blocks up and help them join.",
  depth: "How deep the ocean mixes what forms near its surface. Deeper mixing → more dilute.",
  supply: "How much raw material arrives, relative to the pool.",
  ventType:
    "Alkaline vents (like Lost City) are warm, porous and long-lived. Black smokers are hot (≈350 °C), short-lived and keep clogging and shifting.",
  ventTemperature: "Temperature of the fluid coming out of the vent. The pores inside the chimney are cooler.",
  gradient: "Difference in acidity and chemistry (H₂) between vent fluid and seawater: the vent's energy source.",
  flow: "How fast vent fluid flows through. More flow brings more raw material but washes more away.",
  pores: "How porous the chimney is. Heat flowing across the pores traps molecules there, and the pores act as tiny compartments.",
  minerals: "Iron–sulfur minerals in the chimney catalyse the reactions that make building blocks from H₂ and CO₂.",
  hazards: "How often floods, droughts, impacts or vent shutdowns happen on their own.",
  ingredients:
    "How concentrated the building material is, free or already in chains. Above the mark, building blocks meet often enough to join into chains.",
  energy: "How hard the setting pushes building blocks to join, compared with water breaking the links apart.",
  stability: "How undisturbed conditions have been lately. Floods, impacts and shutdowns set it back; it recovers with time.",
  histogram:
    "How much material sits in chains of each length (log scale), and in self-copying chains (gold). Long chains are 20 units or more.",
  blocksConc: "Concentration of free building blocks (relative units; 1 ≈ a pool partly dried).",
  growth: "Joining rate ÷ breaking rate: above ~20, chains tend to grow long before a bond breaks.",
  breakRate: "Chance per cycle that any one link breaks.",
  copiers: "Concentration of self-copying chains (relative units).",
  enclosed: "Share of the self-copying chains inside a vesicle or mineral pore.",
  temperature: "Temperature where the chemistry happens."
} as const;

const RUNG_TIPS = [
  "Simple molecules turn into building blocks (like nucleotides).",
  `Building blocks are concentrated enough to meet and join (≥ ${THRESHOLD.concentrated} relative units).`,
  "Chains of five or more building blocks.",
  "Chains of 20 or more: long enough to carry information.",
  "A chain that can copy itself appears, and its copies outnumber its losses.",
  "Most self-copying chains sit inside a vesicle or mineral pore, so their copies stay together.",
  "Enclosed self-copying has lasted 30 cycles: a system that keeps itself going."
];

const EVENT_BUTTONS: Record<EventKind, { label: string; tip: string }> = {
  flood: { label: "Flood", tip: "The pool overflows and most of its contents wash away." },
  drought: { label: "Drought", tip: "The pool dries out completely for a few cycles and bakes in the UV." },
  impact: { label: "Impact", tip: "A meteorite strike boils and sterilises the site." },
  shutdown: { label: "Vent shutdown", tip: "The vent stops flowing for a while: no warmth, gradient or new material." }
};

type Snapshot = {
  t: number;
  level: number;
  best: number;
  lifeLost: boolean;
  gauges: ChemState["gauges"];
  diag: ChemState["diag"];
  water: number;
};

function snapshot(s: ChemState): Snapshot {
  return {
    t: s.t,
    level: s.level,
    best: s.best,
    lifeLost: s.lifeLost,
    gauges: { ...s.gauges },
    diag: { ...s.diag },
    water: s.conditions.water
  };
}

function makeSims(): Record<SettingId, ChemState> {
  return { pool: createChem("pool", 1), ocean: createChem("ocean", 2), vent: createChem("vent", 3) };
}

function sci(x: number): string {
  if (x <= 0) {
    return "0";
  }
  if (x >= 0.01 && x < 1000) {
    return x < 1 ? x.toFixed(3) : x.toFixed(1);
  }
  const e = Math.floor(Math.log10(x));
  return `${(x / 10 ** e).toFixed(1)}×10${String(e).replace("-", "⁻").replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)])}`;
}

function Gauge(props: { label: string; value: number; status: string; color: string; tip: string; mark?: number }): JSX.Element {
  return (
    <div className="ool-gauge" title={props.tip} data-hover-help={props.tip}>
      <div className="ool-gauge-head">
        <span>{props.label}</span>
        <strong>{props.status}</strong>
      </div>
      <div className="ool-gauge-bar">
        <span style={{ width: `${Math.round(props.value * 100)}%`, background: props.color }} />
        {props.mark !== undefined ? <i style={{ left: `${props.mark * 100}%` }} /> : null}
      </div>
    </div>
  );
}

/** Ingredients gauge position of the "concentrated" threshold. */
const CONCENTRATED_MARK = (Math.log10(THRESHOLD.concentrated) + 5) / 6;

function ingredientsStatus(v: number): string {
  return v < 0.5 ? "very dilute" : v < CONCENTRATED_MARK ? "dilute" : "concentrated";
}

function energyStatus(v: number): string {
  return v < 0.45 ? "weak" : v < 0.7 ? "moderate" : "strong";
}

function stabilityStatus(v: number): string {
  return v > 0.8 ? "steady" : v > 0.4 ? "shaken" : "unstable";
}

function statusText(snap: Snapshot): string {
  if (snap.lifeLost && snap.level < RUNGS.length - 1) {
    return "Life lost";
  }
  return snap.level >= 0 ? RUNG_LABELS[snap.level] : "Nothing yet";
}

export function OriginOfLifeCanvas({ host }: Props): JSX.Element {
  const sceneRef = useRef<HTMLCanvasElement | null>(null);
  const histRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = host?.readReducedMotion?.() ?? false;

  const [view, setView] = useState<ViewId>("pool");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(reducedMotion ? 1 : 5);
  const [snaps, setSnaps] = useState<Record<SettingId, Snapshot> | null>(null);

  const sims = useRef<Record<SettingId, ChemState>>(makeSims());
  const lenses = useRef<Record<SettingId, Lens>>({ pool: createLens(4), ocean: createLens(5), vent: createLens(6) });
  const seen = useRef<Record<SettingId, { t: number; at: number }>>({
    pool: { t: -1, at: -Infinity },
    ocean: { t: -1, at: -Infinity },
    vent: { t: -1, at: -Infinity }
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useCanvasBackingStore([histRef]);

  useEffect(() => {
    const sctx = sceneRef.current?.getContext("2d");
    if (!sctx) {
      return;
    }
    const visible = view === "compare" ? SETTINGS_ORDER : [view];
    const shape = lensShape(view === "compare");
    let last = performance.now();
    let lastUi = -Infinity;
    let clock = 0;
    let raf = 0;
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const rate = CYCLES_PER_SECOND * speed;
      if (running) {
        clock += dt;
        visible.forEach((id) => {
          stepChem(sims.current[id], settingsRef.current, dt * rate);
          updateLens(lenses.current[id], sims.current[id], dt, rate, shape);
        });
      }

      setLogicalTransform(sctx, SCENE_W);
      sctx.fillStyle = "#060a12";
      sctx.fillRect(0, 0, SCENE_W, SCENE_H);
      const viewFor = (id: SettingId, compact: boolean): SceneView => {
        const s = sims.current[id];
        const mark = seen.current[id];
        if (s.lastEvent && s.lastEvent.t !== mark.t) {
          seen.current[id] = { t: s.lastEvent.t, at: clock };
        }
        return {
          state: s,
          settings: settingsRef.current,
          lens: lenses.current[id],
          clock,
          eventAge: s.lastEvent ? clock - seen.current[id].at : Infinity,
          compact
        };
      };
      if (view === "compare") {
        const w = SCENE_W / 3;
        SETTINGS_ORDER.forEach((id, i) => drawScene(sctx, viewFor(id, true), { x: i * w, y: 0, w, h: SCENE_H }));
        sctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        sctx.fillRect(w - 1, 0, 2, SCENE_H);
        sctx.fillRect(2 * w - 1, 0, 2, SCENE_H);
        sctx.font = "600 20px system-ui, sans-serif";
        sctx.textAlign = "right";
        sctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        sctx.fillText(`Cycle ${Math.floor(sims.current.pool.t)}`, SCENE_W - 20, 40);
      } else {
        drawScene(sctx, viewFor(view, false), { x: 0, y: 0, w: SCENE_W, h: SCENE_H });
        const hctx = histRef.current?.getContext("2d");
        if (hctx) {
          setLogicalTransform(hctx, HIST_W);
          drawHistogram(hctx, sims.current[view]);
        }
      }

      if (now - lastUi > 160) {
        lastUi = now;
        setSnaps({
          pool: snapshot(sims.current.pool),
          ocean: snapshot(sims.current.ocean),
          vent: snapshot(sims.current.vent)
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, view]);

  const setting: SettingId | null = view === "compare" ? null : view;

  function patch<K extends SettingId>(key: K, change: Partial<Settings[K]>): void {
    setSettings((s) => ({ ...s, [key]: { ...s[key], ...change } }));
  }

  function onVentType(type: "alkaline" | "smoker"): void {
    patch("vent", { type, temperature: type === "smoker" ? SMOKER_TEMPERATURE : ALKALINE_DEFAULTS.temperature });
  }

  function onReset(): void {
    const ids = view === "compare" ? SETTINGS_ORDER : [view];
    ids.forEach((id) => {
      sims.current[id] = createChem(id, 1 + SETTINGS_ORDER.indexOf(id));
      clearLens(lenses.current[id]);
      seen.current[id] = { t: -1, at: -Infinity };
    });
    setRunning(false);
    host?.onResult?.({ event: "reset", view });
  }

  function onEvent(kind: EventKind): void {
    if (setting) {
      triggerEvent(sims.current[setting], settingsRef.current, kind);
    }
  }

  const toolbar = (
    <>
      <StageSegmented
        ariaLabel="Setting"
        value={view}
        options={[
          { value: "pool", label: "Pool", tip: TIP.pool },
          { value: "ocean", label: "Ocean", tip: TIP.ocean },
          { value: "vent", label: "Vent", tip: TIP.vent },
          { value: "compare", label: "Compare", tip: TIP.compare }
        ]}
        onChange={setView}
      />
      <StageDivider />
      <StageIconButton icon={running ? "pause" : "play"} label={running ? "Pause" : "Start"} tip={TIP.play} onClick={() => setRunning((r) => !r)} />
      <StageIconButton icon="reset" label="Reset" tip={TIP.reset} onClick={onReset} />
      <StageSegmented ariaLabel="Speed" tip={TIP.speed} value={speed} options={SPEEDS} onChange={setSpeed} />
    </>
  );

  const { pool, ocean, vent } = settings;
  const ventLimits = VENT_LIMITS[vent.type];

  const settingControls =
    setting === "pool" ? (
      <StageSection title="Shallow pool">
        <StageSlider
          label="How much it dries"
          display={`${Math.round(pool.drying * 100)}%`}
          value={pool.drying}
          min={0}
          max={0.95}
          step={0.05}
          tip={TIP.drying}
          onChange={(drying) => patch("pool", { drying })}
        />
        <StageSlider label="Sunlight (UV)" display={`${pool.uv.toFixed(1)}×`} value={pool.uv} min={0} max={2} step={0.1} tip={TIP.uv} onChange={(uv) => patch("pool", { uv })} />
        <StageSlider
          label="Water temperature"
          display={`${pool.temperature} °C`}
          value={pool.temperature}
          min={10}
          max={95}
          step={1}
          tip={TIP.poolTemperature}
          onChange={(temperature) => patch("pool", { temperature })}
        />
        <StagePills>
          <StageToggle label="Phosphate-rich" on={pool.phosphate} tip={TIP.phosphate} onChange={(phosphate) => patch("pool", { phosphate })} />
          <StageToggle label="Clay" on={pool.clay} tip={TIP.clay} onChange={(clay) => patch("pool", { clay })} />
        </StagePills>
      </StageSection>
    ) : setting === "ocean" ? (
      <StageSection title="Open ocean">
        <StageSlider
          label="Mixing depth"
          display={`${ocean.depth.toLocaleString()} m`}
          value={ocean.depth}
          min={200}
          max={4000}
          step={100}
          tip={TIP.depth}
          onChange={(depth) => patch("ocean", { depth })}
        />
        <StageSlider
          label="Raw-material supply"
          display={`${ocean.supply.toFixed(1)}×`}
          value={ocean.supply}
          min={0.5}
          max={3}
          step={0.1}
          tip={TIP.supply}
          onChange={(supply) => patch("ocean", { supply })}
        />
      </StageSection>
    ) : setting === "vent" ? (
      <StageSection title="Hydrothermal vent">
        <StageSegmented
          ariaLabel="Vent type"
          label="Vent type"
          tip={TIP.ventType}
          value={vent.type}
          options={[
            { value: "alkaline", label: "Alkaline" },
            { value: "smoker", label: "Black smoker" }
          ]}
          onChange={onVentType}
        />
        <StageSlider
          label="Vent fluid temperature"
          display={`${vent.temperature} °C`}
          value={vent.temperature}
          min={ventLimits.min}
          max={ventLimits.max}
          step={vent.type === "smoker" ? 5 : 1}
          tip={TIP.ventTemperature}
          onChange={(temperature) => patch("vent", { temperature })}
        />
        <StageSlider
          label="Chemical gradient"
          display={`${Math.round(vent.gradient * 100)}%`}
          value={vent.gradient}
          min={0}
          max={1}
          step={0.05}
          tip={TIP.gradient}
          onChange={(gradient) => patch("vent", { gradient })}
        />
        <StageSlider label="Flow" display={`${vent.flow.toFixed(1)}×`} value={vent.flow} min={0.2} max={2} step={0.1} tip={TIP.flow} onChange={(flow) => patch("vent", { flow })} />
        <StageSlider
          label="Porous chimney"
          display={`${Math.round(vent.pores * 100)}%`}
          value={vent.pores}
          min={0}
          max={1}
          step={0.05}
          tip={TIP.pores}
          onChange={(pores) => patch("vent", { pores })}
        />
        <StagePills>
          <StageToggle label="Iron–sulfur minerals" on={vent.minerals} tip={TIP.minerals} onChange={(minerals) => patch("vent", { minerals })} />
        </StagePills>
      </StageSection>
    ) : null;

  const snap = setting && snaps ? snaps[setting] : null;

  const controls = (
    <>
      {settingControls}
      <StageSection title="Events">
        {setting ? (
          <StagePills>
            {EVENTS_FOR[setting].map((kind) => (
              <StagePillButton key={kind} label={EVENT_BUTTONS[kind].label} tip={EVENT_BUTTONS[kind].tip} onClick={() => onEvent(kind)} />
            ))}
          </StagePills>
        ) : null}
        <StageSegmented<HazardLevel>
          ariaLabel="Random hazards"
          label="Random hazards"
          tip={TIP.hazards}
          value={settings.hazards}
          options={[
            { value: "off", label: "Off" },
            { value: "rare", label: "Rare" },
            { value: "often", label: "Often" }
          ]}
          onChange={(hazards) => setSettings((s) => ({ ...s, hazards }))}
        />
      </StageSection>
      {snap && setting ? (
        <StageSection title="Advanced" defaultOpen={false}>
          <StageReadout label="Building blocks" value={sci(snap.diag.blocks)} tip={TIP.blocksConc} />
          <StageReadout label="Joining ÷ breaking" value={sci(snap.diag.growth)} tip={TIP.growth} />
          <StageReadout label="Link breaks / cycle" value={sci(snap.diag.breakRate)} tip={TIP.breakRate} />
          <StageReadout label="Self-copiers" value={sci(snap.diag.copiers)} tip={TIP.copiers} />
          <StageReadout label="Enclosed" value={`${Math.round(snap.diag.enclosed * 100)}%`} tip={TIP.enclosed} />
          <StageReadout
            label="Temperature"
            value={`${Math.round(setting === "vent" ? poreTemperature(vent) : snap.diag.temperature)} °C`}
            tip={setting === "vent" ? `${TIP.temperature} Inside the pores.` : TIP.temperature}
          />
          {setting === "pool" ? <StageReadout label="Water left" value={`${Math.round(snap.water * 100)}%`} /> : null}
        </StageSection>
      ) : null}
    </>
  );

  const readouts =
    snap && setting ? (
      <div className="ool-readouts">
        <StageHero label={SHORT_NAMES[setting]} value={`Cycle ${Math.floor(snap.t)}`} />
        <Gauge
          label="Ingredients"
          value={snap.gauges.ingredients}
          status={ingredientsStatus(snap.gauges.ingredients)}
          color="#5ec8f2"
          tip={TIP.ingredients}
          mark={CONCENTRATED_MARK}
        />
        <Gauge label="Energy" value={snap.gauges.energy} status={energyStatus(snap.gauges.energy)} color="#ffb85c" tip={TIP.energy} />
        <Gauge label="Stability" value={snap.gauges.stability} status={stabilityStatus(snap.gauges.stability)} color="#b9a3ff" tip={TIP.stability} />
        <ol className="ool-ladder" aria-label="Steps toward life">
          {RUNG_LABELS.map((label, i) => ({ label, i }))
            .reverse()
            .map(({ label, i }) => (
              <li
                key={label}
                className={`${i <= snap.level ? "is-on" : i <= snap.best ? "is-was" : ""}${i === RUNGS.length - 1 ? " is-life" : ""}`}
                title={RUNG_TIPS[i]}
                data-hover-help={RUNG_TIPS[i]}
              >
                <span className="ool-dot" aria-hidden="true" />
                {label}
              </li>
            ))}
        </ol>
        <p className={`ool-status${snap.level === RUNGS.length - 1 ? " is-life" : ""}`}>{statusText(snap)}</p>
      </div>
    ) : null;

  const inset = setting ? (
    <div title={TIP.histogram} data-hover-help={TIP.histogram}>
      <canvas ref={histRef} style={{ width: HIST_W, aspectRatio: `${HIST_W} / ${HIST_H}` }} />
    </div>
  ) : undefined;

  const info = (
    <>
      <h4>What you are seeing</h4>
      <ul>
        <li>The setting below, and a zoomed-in window on the molecules there. Coloured beads are building blocks (like the four nucleotides of RNA); beads on a string are chains; gold chains copy themselves; pale heads with two tails are lipids, which close up into double-walled vesicles once concentrated.</li>
        <li>The number of molecules in the window follows the simulated concentrations. In a dilute setting only the odd one drifts through; the faint, blurred ones behind are building blocks farther off in the water.</li>
        <li>Once it counts as alive, each vesicle holding a self-copying chain behaves as a cell: it grows while its chain is copied, the copy peels off, and the cell pinches in two, one chain in each daughter.</li>
        <li>In the pool, clouds gather and rain starts before run-off refills it; every dry spell and downpour is a little different.</li>
        <li>The ladder lights the steps reached now; a hollow dot is a step reached before but since lost.</li>
      </ul>
      <h4>Three requirements</h4>
      <ul>
        <li>
          <strong>Ingredients</strong> concentrated enough to meet. Joining two building blocks needs them to collide; water breaking a link does not. Diluted, breaking always wins.
        </li>
        <li>
          <strong>Energy</strong> to make links: joining building blocks releases water, so in water it is uphill. Drying, sunlight or a chemical gradient can push it.
        </li>
        <li>
          <strong>Stability</strong>, long enough for all of it to build up: floods, impacts and vent shutdowns knock it back.
        </li>
      </ul>
      <h4>The model</h4>
      <ul>
        <li>One well-mixed box per setting. Raw material becomes building blocks; blocks join one at a time into chains up to 30 long; water breaks links at random, faster when hot.</li>
        <li>Rarely, a new long chain has a sequence that can copy itself, using up building blocks. Lipids made alongside form vesicles once concentrated; re-wetting or mineral pores enclose the copiers.</li>
        <li>Nothing is scripted: the ocean fails because its building blocks are spread through a huge volume, and the black smoker because heat breaks chains faster than they form.</li>
      </ul>
      <h4>Simplifications</h4>
      <ul>
        <li>Rates and concentrations are relative and illustrative; only their ordering between settings is meant to hold. Real timescales are unknown, so time is counted in cycles.</li>
        <li>Chemistry is lumped: one kind of raw material, four kinds of building block, one length of copier, no errors in copying, no competition between copiers.</li>
        <li>How vents could drive joining in water is debated; here the gradient is simply assumed to supply that energy. Both pools and vents remain live hypotheses with open problems.</li>
      </ul>
      <h4>Ideas behind the settings</h4>
      <ul>
        <li>Wet–dry cycling in hot-spring pools: Damer &amp; Deamer (2020).</li>
        <li>UV-driven building-block chemistry: Patel et al. (2015); phosphate-rich lakes: Toner &amp; Catling (2020).</li>
        <li>Clay-assisted chain growth: Ferris et al. (1996). Vesicles as protocells: Hanczyc, Fujikawa &amp; Szostak (2003).</li>
        <li>Alkaline vents: Lost City, Kelley et al. (2001); Martin &amp; Russell (2003). Trapping in heated pores: Baaske et al. (2007).</li>
      </ul>
    </>
  );

  return (
    <AppletStage
      logicalWidth={SCENE_W}
      logicalHeight={SCENE_H}
      canvasRef={sceneRef}
      canvasLabel={setting ? `${SETTING_NAMES[setting]} with a zoomed-in view of its molecules` : "Pool, ocean and vent side by side"}
      rootClassName="ool-stage"
      controlsWidth={260}
      toolbar={toolbar}
      controls={setting ? controls : undefined}
      readouts={readouts}
      inset={inset}
      info={info}
      play={{ visible: !running, label: "Start", onClick: () => setRunning(true) }}
    />
  );
}
