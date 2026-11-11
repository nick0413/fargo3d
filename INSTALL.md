# FARGO3D install — building this fork and running the live viewer

This fork adds three things to upstream FARGO3D (commit `f205466`): a live frame emitter, a planet
accretion sink with a budget diagnostic, and a browser viewer for the emitter. All three are
inactive until you switch them on, so a plain build behaves exactly like upstream.

Everything below runs from the repository root. Nothing outside the clone is required except a
C/C++ toolchain, CUDA, and (for the viewer) Python 3, node and npm.

---

## 1. Prerequisites

| What | Why | Check |
|------|-----|-------|
| `gcc` / `g++` | FARGO3D's host compiler. Some minimal images ship neither; nvcc then fails with `cannot execute 'cc1plus'` | `g++ --version` |
| CUDA toolkit (`nvcc`) | the GPU build | `nvcc --version` |
| `make`, `python3` | the build system, and `scripts/make.py` which it calls | `python3 --version` |
| node + npm | only for the browser UI | `npm --version` |
| python3, numpy, matplotlib, ffmpeg | only for `plot_disk.py` | `ffmpeg -version` |

`scripts/make.py` must run on Python 3. This fork contains that fix; upstream at `f205466` does not.

---

## 2. Build

```bash
make SETUP=fargo PARALLEL=0 GPU=1 BIGMEM=1
```

The binary is written to `./fargo3d` (`EXENAME` in `src/makefile`).

Change one thing at a time, and **always `make clean` before changing precision**. FARGO3D's
makefile does not track `.opt` edits, and two GPU reduction objects depend only on their `.cu` file
(`src/makefile:640-648`). Edit the setup's `.opt` and run a plain `make`, and you get a
mixed-precision binary whose float64 reduction kernels index float32 arrays; the run dies at the
first output with a confusing `Error!!!--> Null dt`. A clean rebuild is the fix.

Verify what you actually built — do not trust the build log:

```bash
./fargo3d -0 setups/fargo/fargo_test.par          # initialise only
grep REALTYPE outputs/fargo/variables.par          # float32 | float64, self-reported
ls -l outputs/fargo/gasdens0.dat                   # 49152 cells: 196608 (float32) or 393216 (float64)
```

---

## 3. Switching the additions on

Both features are gated by environment variables and are off unless set.

### Live frame emitter (`src/control.c`)

```bash
FARGO_CONTROL_PORT=9100 ./fargo3d -k par.par
```

Listens on `127.0.0.1:<port>` and sends one binary frame at the midpoint of each coarse step and one
at its end. The wire format is `contract/fargo-control-v1.md`. With no reader connected it does
nothing; a slow reader loses frames rather than slowing the solver. Cost measured at +0.8% on
384x128.

`-k` keeps the per-rank dump suffix, which the seek feature needs.

### Accretion sink (`src/accretion.c`)

The sink does nothing unless a planet's `Accretion` column in the planet config is positive —
`planets/jupiter.cfg` ships `0.0`. To try it, copy the config and raise that column:

```
# Planet Name   Distance  Mass    Accretion  Feels Disk  Feels Others
Jupiter         1.0       0.001   1.0        NO          NO
```

Then point the par at your copy (`PlanetConfig`) and run:

```bash
FARGO_ACCRETION=1 FARGO_ACCRETION_FRAC=0.2 FARGO_DIAG=1 ./fargo3d par.par
```

| Variable | Meaning | Default |
|----------|---------|---------|
| `FARGO_ACCRETION` | switch the sink on | off |
| `FARGO_ACCRETION_FRAC` | capture radius as a fraction of the Hill radius | `0.2` |
| `FARGO_DIAG` | write `<OutputDir>/budget.dat`, one row per planet per coarse step | off |

The sink removes `1-exp(-acc*dt)` of every cell inside `r_cap` and gives the mass and momentum to
the planet, once per coarse step, immediately before the orbits advance. Two known defects in the
momentum transfer are recorded in `REVIEW-2026-11-11.md` (P-1, P-2) and are not fixed in this
commit — do not publish migration results from this sink yet.

---

## 4. The viewer

Build the UI once (needs node and npm; the result is `tools/live/web/dist`, which git ignores):

```bash
tools/live/build_web.sh
```

Then run the simulation and the relay together:

```bash
tools/live/start_demo.sh
```

and open the URL it prints (default `http://localhost:8088/`). `tools/live/restart_bridge.sh`
restarts only the relay when the UI changes.

Every path comes from the clone, the environment, or an argument:

| Variable | Meaning | Default |
|----------|---------|---------|
| `FARGO_LIVE_DIR` | writable working directory: dumps, logs, pid files | `~/fargo-live` |
| `FARGO_BIN` | simulation binary | `<repo>/fargo3d` |
| `FARGO_WEB_DIR` | directory served as the UI | `<repo>/tools/live/web/dist` |
| `FARGO_PAR` | parameter file the demo starts from | `<repo>/setups/fargo/fargo_test.par` |
| `PORT` / `CPORT` | HTTP port / emitter port | `8088` / `9100` |
| `MAXORBITS` | stop the simulation after this many orbits | `60` |

`live_view.py --help` lists the same options as flags. The relay reads `Ninterm`, `DT` and
`OmegaFrame` from the par, so seek aims at the right output without you repeating them.

What the viewer can do today: scrub the RAM buffer, stop and resume the solver (`SIGSTOP` /
`SIGCONT` — a stop-the-world pause), clear the buffer, truncate it after the playhead, and seek by
restarting from the nearest saved dump. Parameter writes are not implemented.

---

## 5. Plotting snapshots to video

```bash
python3 plot_disk.py --dir outputs/fargo --out gap.mp4
```

Grid, precision and the frame list are inferred: `domain_x.dat` and `domain_y.dat` give the grid,
and the file size gives float32 against float64. The default codec is `libx264`; pass
`--codec h264_nvenc` if you have an NVIDIA GPU.

---

## 6. What this fork does not do

Read `REVIEW-2026-11-11.md` for the full list. The three that matter most:

- **No self-gravity.** The gas is a massless test fluid in an analytic star + planet potential. No
  disc fragmentation, no gravitationally driven spirals.
- **The sink's momentum transfer is wrong** (P-1) and its angular-momentum check cannot detect that
  (P-2). Both are recorded, neither is fixed.
- **The emitter and the sink assume a serial build** (`PARALLEL=0`). In an MPI build every rank
  tries to bind the emitter port and the frame carries no rank field.
