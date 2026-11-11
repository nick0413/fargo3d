import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import * as Plot from '@observablehq/plot'
import {
  Frame, Meta, Range, paintCbar, paintDisc, paintOverlay, paintTimeline, parseFrame,
  computeRange, radialProfile,
} from './lib/fargo'
import { GLRenderer, createGL } from './lib/gl'

// Field  : WebGL2 fragment shader (src/lib/gl.ts). Falls back to the 2D painter if no WebGL2.
// Plot   : Observable Plot (SVG), hover readout, log axis.
// Frames : never enter React state; refs + a throttled re-render keep 3-60 fps off the reconciler.

type Hud = { t: number; orbit: number; fid: number; theta: number; orbitsPerSec: number }
type ProfilePoint = { r: number; sigma: number; vres: number }
const DISK = 760
const HUD_MS = 100
const PROF_MS = 200

function Chip({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</span>
      <span className={`num text-sm ${tone ?? 'text-slate-100'}`}>{value}</span>
    </div>
  )
}
function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-800/80 bg-slate-900/40 p-4 ${className}`}>{children}</div>
}
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/60 py-1.5 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="num text-xs text-slate-200">{value}</span>
    </div>
  )
}
const btn = (a = false) =>
  'rounded-lg border px-3 py-1.5 text-xs font-medium transition ' +
  (a ? 'border-emerald-400/70 bg-emerald-400/10 text-emerald-300'
     : 'border-slate-700 bg-slate-800/60 text-slate-200 hover:border-emerald-400/60 hover:text-emerald-300')
const sel = 'rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-xs text-slate-200'

function ProfilePlot({ data }: { data: ProfilePoint[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || data.length === 0) return
    let chart: unknown
    try {
      chart = Plot.plot({
      width: 340,
      height: 220,
      marginLeft: 58,
      marginBottom: 38,
      marginTop: 12,
      style: { background: 'transparent', color: '#94a3b8', fontSize: '10px', fontFamily: 'ui-sans-serif, system-ui' },
      x: { label: 'radius r (code units)', domain: [0.4, 2.5], ticks: 5, tickFormat: (d: number) => d.toFixed(1) },
      y: { type: 'log', label: 'Σ(r)', grid: true },
      marks: [
        Plot.gridY({ stroke: '#1e293b' }),
        Plot.gridX({ stroke: '#16202b' }),
        Plot.ruleX([1.0], { stroke: '#334155', strokeDasharray: '3 3' }),
        Plot.lineY(data, { x: 'r', y: 'sigma', stroke: '#5eead4', strokeWidth: 1.6 }),
        Plot.tip(
          data,
          Plot.pointerX({
            x: 'r', y: 'sigma', fill: '#5eead4', stroke: '#05070a',
            title: (d: ProfilePoint) => `r ${d.r.toFixed(3)}\nΣ ${d.sigma.toExponential(3)}`,
          }),
        ),
      ],
    })
    } catch (e) {
      console.error('plot failed', e)
      if (ref.current) ref.current.textContent = 'plot error: ' + String(e)
      return
    }
    ref.current.replaceChildren(chart as unknown as Node)
    return () => { (chart as unknown as Node).parentNode?.removeChild(chart as unknown as Node) }
  }, [data])
  return <div ref={ref} className="w-full overflow-hidden" />
}

export default function App() {
  const glCanvas = useRef<HTMLCanvasElement>(null)
  const ovCanvas = useRef<HTMLCanvasElement>(null)
  const cbarRef = useRef<HTMLCanvasElement>(null)
  const timeRef = useRef<HTMLCanvasElement>(null)

  const [meta, setMeta] = useState<Meta | null>(null)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)
  const [dir, setDir] = useState(1)
  const [fps, setFps] = useState(3)
  const [cscale, setCscale] = useState<'log' | 'linear'>('log')
  const [frameMode, setFrameMode] = useState<'rot' | 'inertial'>('rot')
  const [arrows, setArrows] = useState(false)
  const [grid, setGrid] = useState(false)
  const [fieldIdx, setFieldIdx] = useState(0)
  const [profile, setProfile] = useState<ProfilePoint[]>([])
  const [renderer, setRenderer] = useState<'webgl' | 'canvas2d'>('webgl')

  const hud = useRef<Hud>({ t: 0, orbit: 0, fid: 0, theta: 0, orbitsPerSec: 0 })
  const metaRef = useRef<Meta | null>(null)
  const playIdx = useRef<number | null>(null)
  const cur = useRef<Frame | null>(null)
  const rangeRef = useRef<Range | null>(null)
  const glRef = useRef<GLRenderer | null>(null)
  const busy = useRef(false)
  const lastPaintMs = useRef(0)
  const lastFetchMs = useRef(0)
  const rateHist = useRef<[number, number][]>([])
  const lastProfAt = useRef(0)
  const opts = useRef({ frameMode: 'rot' as 'rot' | 'inertial', cscale: 'log' as 'log' | 'linear', fieldIdx: 0, arrows: false, grid: false })
  const ctl = useRef({ playing: false, follow: true, dir: 1, fps: 3 })
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const lastBump = useRef(0)

  useEffect(() => { ctl.current = { playing, follow, dir, fps } }, [playing, follow, dir, fps])
  useEffect(() => { opts.current = { frameMode, cscale, fieldIdx, arrows, grid } }, [frameMode, cscale, fieldIdx, arrows, grid])

  useEffect(() => {
    if (!glCanvas.current) return
    try {
      const gl = createGL(glCanvas.current)
      if (gl) { glRef.current = gl; setRenderer('webgl') }
      else setRenderer('canvas2d')
    } catch (e) { console.error('webgl init failed', e); setRenderer('canvas2d') }
  }, [])

  const paint = useCallback(() => {
    const f = cur.current
    if (!f) return
    try {
      const o = { frame: opts.current.frameMode, scale: opts.current.cscale, arrows: opts.current.arrows, showGrid: opts.current.grid }
      const ov = ovCanvas.current?.getContext('2d')
      if (glRef.current) {
        const range = computeRange(f, opts.current.fieldIdx, o.scale)
        rangeRef.current = range
        glRef.current.draw(f, o, range, opts.current.fieldIdx)
        if (ov) paintOverlay(ov, f, o)
      } else if (ov) {
        rangeRef.current = paintDisc(ov, f, { ...o, field: opts.current.fieldIdx })
      }
      const c = cbarRef.current?.getContext('2d')
      if (c) paintCbar(c, rangeRef.current)
      const t = timeRef.current?.getContext('2d')
      if (t) paintTimeline(t, metaRef.current, (f.t * f.omega) / (2 * Math.PI))
      const now = performance.now()
      if (now - lastProfAt.current > PROF_MS) { lastProfAt.current = now; setProfile(radialProfile(f)) }
    } catch (e) { console.error('paint failed', e) }
  }, [])

  const drawAt = useCallback(async (idx: number) => {
    if (busy.current) return
    busy.current = true
    const t0 = performance.now()
    try {
      const r = await fetch(`/frame?at=${idx}`, { cache: 'no-store' })
      if (r.status !== 200) return
      const raw = await r.arrayBuffer()
      lastFetchMs.current = performance.now() - t0
      const f = parseFrame(raw)
      cur.current = f
      const now = performance.now() / 1000
      rateHist.current.push([f.t, now])
      while (rateHist.current.length > 2 && now - rateHist.current[0][1] > 2.5) rateHist.current.shift()
      let rate = hud.current.orbitsPerSec
      const h = rateHist.current
      if (h.length >= 2 && h[h.length - 1][1] - h[0][1] > 0.4) {
        rate = ((h[h.length - 1][0] - h[0][0]) / (h[h.length - 1][1] - h[0][1])) * f.omega / (2 * Math.PI)
      }
      hud.current = { t: f.t, orbit: (f.t * f.omega) / (2 * Math.PI), fid: f.fid, theta: f.theta, orbitsPerSec: rate }
      const tp = performance.now()
      paint()
      lastPaintMs.current = performance.now() - tp
      if (now * 1000 - lastBump.current > HUD_MS) { lastBump.current = now * 1000; bump() }
    } catch (e) { console.error('drawAt failed', e) }
    finally { busy.current = false }
  }, [paint])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const m: Meta = await (await fetch('/meta', { cache: 'no-store' })).json()
        if (!alive) return
        metaRef.current = m
        setMeta(m)
        if (playIdx.current === null && m.index_last !== null) {
          playIdx.current = m.index_last
          drawAt(m.index_last)
        } else if (ctl.current.follow && m.index_last !== null && playIdx.current !== m.index_last) {
          playIdx.current = m.index_last
          drawAt(m.index_last)
        } else if (playIdx.current === null && m.index_last === null) {
          const t = timeRef.current?.getContext('2d')
          if (t) paintTimeline(t, m, null)
        } else {
          const t = timeRef.current?.getContext('2d')
          if (t) paintTimeline(t, m, hud.current.orbit)
        }
      } catch { /* backend not up yet */ }
      if (alive) setTimeout(tick, 400)
    }
    tick()
    return () => { alive = false }
  }, [drawAt])

  useEffect(() => { paint() }, [frameMode, cscale, fieldIdx, arrows, grid, paint])

  useEffect(() => {
    let raf = 0, acc = 0, last = performance.now()
    const loop = (now: number) => {
      const dt = now - last
      last = now
      const s = ctl.current, m = metaRef.current
      if (s.playing && m && m.index_first !== null && playIdx.current !== null) {
        acc += dt
        const step = 1000 / s.fps
        let moved = false
        while (acc >= step) {
          acc -= step
          let next = playIdx.current + s.dir
          const frozen = !!(m.sim_stopped || m.buffer_full)
          if (next < m.index_first) {
            if (frozen) next = m.index_last!
            else { next = m.index_first; setPlaying(false) }
          }
          if (next > m.index_last!) {
            if (frozen) next = m.index_first
            else { next = m.index_last!; setPlaying(false); setFollow(true) }
          }
          if (next !== playIdx.current) { playIdx.current = next; moved = true }
        }
        if (moved) drawAt(playIdx.current!)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [drawAt])

  ;(window as any).__dbg = () => ({
    playing: ctl.current.playing, follow: ctl.current.follow, dir: ctl.current.dir,
    idx: playIdx.current, last: metaRef.current?.index_last ?? null,
    frozen: !!metaRef.current?.sim_stopped, hud: hud.current,
    paintMs: Math.round(lastPaintMs.current), fetchMs: Math.round(lastFetchMs.current),
    renderer,
  })

  const startPlay = (d: number) => {
    setDir(d); setFollow(false); setPlaying(true)
    const m = metaRef.current
    if (m && m.index_first !== null) {
      if (playIdx.current === null || (d > 0 && playIdx.current >= (m.index_last ?? 0))) {
        playIdx.current = m.index_first
        drawAt(m.index_first)
      }
    }
  }

  // Seeking outside the recorded band asks the simulation to restart from the nearest saved
  // state and recompute from there. Without that, an empty ring left the user with no move.
  const seek = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const el = timeRef.current, m = metaRef.current
    if (!el || !m) return
    const rect = el.getBoundingClientRect()
    const x = ((ev.clientX - rect.left) / rect.width) * el.width
    const pad = 10
    const orbit = Math.max(0, Math.min(m.max_orbits, ((x - pad) / (el.width - 2 * pad)) * m.max_orbits))
    const cached = m.orbit_first != null && m.orbit_last != null
      && orbit >= m.orbit_first && orbit <= m.orbit_last
    if (!cached) {
      setPlaying(false)
      setFollow(false)
      playIdx.current = null
      fetch('/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'seek', orbit }),
      }).catch(() => {})
      return
    }
    const f2 = (orbit - m.orbit_first) / Math.max(1e-9, m.orbit_last! - m.orbit_first)
    const idx = Math.round(m.index_first! + f2 * (m.index_last! - m.index_first!))
    playIdx.current = idx
    setPlaying(false); setFollow(false)
    drawAt(idx)
  }

  const bufferAction = async (action: 'clear' | 'truncate') => {
    const body: any = { action }
    if (action === 'truncate') {
      if (playIdx.current === null) return
      body.from = playIdx.current
    }
    const r = await fetch('/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json()
    if (j.ok) {
      setPlaying(false)
      setFollow(true)
      playIdx.current = null
      setTimeout(() => { const m = metaRef.current; if (m?.index_last != null) { playIdx.current = m.index_last; drawAt(m.index_last) } }, 500)
    }
  }

  const simToggle = async () => {
    const action = metaRef.current?.sim_stopped ? 'sim_run' : 'sim_stop'
    await fetch('/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    })
  }

  const h = hud.current
  const simLabel = meta?.buffer_full ? 'STOPPED · buffer full' : meta?.sim_stopped ? 'stopped' : meta?.sim_alive ? 'computing' : 'finished'
  const simTone = meta?.buffer_full ? 'text-amber-300' : meta?.sim_alive && !meta?.sim_stopped ? 'text-emerald-300' : 'text-slate-400'

  return (
    <div className="min-h-screen bg-[#05070a]">
      <header className="flex flex-wrap items-center gap-x-7 gap-y-3 border-b border-slate-800/80 px-6 py-3">
        <h1 className="text-sm font-semibold tracking-[0.18em] text-slate-100">FARGO3D · LIVE DISK</h1>
        <Chip label="t" value={h.t.toFixed(2)} />
        <Chip label="orbit" value={h.orbit.toFixed(2)} />
        <Chip label="frame" value={String(h.fid)} />
        <Chip label="theta" value={h.theta.toFixed(3)} />
        <Chip label="buffered" value={meta ? `${meta.count} frames` : '—'} />
        <Chip label="sim" value={meta?.recomputing ? 'recomputing…' : simLabel}
              tone={meta?.recomputing ? 'text-sky-300' : simTone} />
      </header>

      <main className="flex flex-wrap items-start gap-4 p-4">
        <Panel className="min-w-[560px] flex-1">
          <div className="relative mx-auto aspect-square w-full max-w-[760px]">
            <canvas ref={glCanvas} width={DISK} height={DISK} className="absolute inset-0 h-full w-full rounded-xl bg-black" />
            <canvas ref={ovCanvas} width={DISK} height={DISK} className="absolute inset-0 h-full w-full" />
          </div>
          <canvas ref={cbarRef} width={DISK} height={38} className="mt-2 block h-[38px] w-full" />
          <canvas ref={timeRef} width={DISK} height={66} onClick={seek} className="mt-1 block h-[66px] w-full cursor-pointer" />
        </Panel>

        <div className="flex w-[380px] flex-col gap-4">
          <Panel>
            <div className="flex flex-wrap items-center gap-2">
              <button className={btn(follow)} onClick={() => {
                setFollow(true); setPlaying(false)
                const m = metaRef.current
                if (m?.index_last != null) { playIdx.current = m.index_last; drawAt(m.index_last) }
              }}>live</button>
              <button className={btn(playing && dir < 0)} onClick={() => startPlay(-1)}>rev</button>
              <button className={btn(playing)} onClick={() => (playing ? setPlaying(false) : startPlay(dir))}>
                {playing ? 'pause' : 'play'}
              </button>
              <button className={btn(playing && dir > 0)} onClick={() => startPlay(1)}>fwd</button>
              <select className={sel} value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                {[1, 2, 3, 5, 10, 20, 60].map((v) => <option key={v} value={v}>{v} fps</option>)}
              </select>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select className={sel} value={cscale} onChange={(e) => setCscale(e.target.value as 'log' | 'linear')}>
                <option value="log">colour: log</option>
                <option value="linear">colour: linear</option>
              </select>
              <select className={sel} value={frameMode} onChange={(e) => setFrameMode(e.target.value as 'rot' | 'inertial')}>
                <option value="rot">frame: rotating</option>
                <option value="inertial">frame: inertial</option>
              </select>
              <select className={sel} value={fieldIdx} onChange={(e) => setFieldIdx(Number(e.target.value))}>
                <option value="0">field: density</option>
                <option value="1">field: vx</option>
                <option value="2">field: vy</option>
              </select>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className={btn(arrows)} onClick={() => setArrows(!arrows)}>flow ⟨v⟩</button>
              <button className={btn(grid)} onClick={() => setGrid(!grid)}>grid</button>
              <button className={btn()} onClick={simToggle}>{meta?.sim_stopped ? 'sim run' : 'sim stop'}</button>
              <button className={btn()} onClick={() => bufferAction('clear')}>clear buffer</button>
              <button className={btn()} onClick={() => bufferAction('truncate')} title="drop every stored frame after the playhead; the simulation itself does not rewind">
                truncate at playhead
              </button>
            </div>
          </Panel>

          <Panel>
            <ProfilePlot data={profile} />
          </Panel>

          <Panel>
            <Stat label="producer" value={meta?.producer ?? '—'} />
            <Stat label="frames in buffer" value={meta?.count ?? 0} />
            <Stat label="buffer window" value={meta ? `${meta.orbit_first?.toFixed(2) ?? '—'} – ${meta.orbit_last?.toFixed(2) ?? '—'} orbits` : '—'} />
            <Stat label="buffer max" value={meta ? `${meta.max_orbits.toFixed(0)} orbits` : '—'} />
            <Stat label="sim rate" value={meta?.sim_stopped ? 'stopped' : `${h.orbitsPerSec.toFixed(2)} orbits/s`} />
            <Stat label="renderer" value={`${renderer} · paint ${Math.round(lastPaintMs.current)} ms`} />
            <Stat label="payload" value={cur.current ? `${cur.current.nfields} fields · f32` : '—'} />
            <Stat label="grid" value={cur.current ? `${cur.current.nx} × ${cur.current.ny} × ${cur.current.nz}` : '—'} />
          </Panel>

          <p className="border-l-2 border-amber-500/60 pl-3 text-[11px] leading-relaxed text-slate-500">
            <span className="font-semibold text-amber-300/90">Raw frames.</span> The picture changes only when
            a stored frame is drawn — no interpolation. Playback advances one frame per step at the selected
            fps and wraps when the recording is closed. The green band is the history held in RAM; when it
            reaches the max the simulation is stopped for real and the recording stays scrubbable.
          </p>
        </div>
      </main>
    </div>
  )
}
