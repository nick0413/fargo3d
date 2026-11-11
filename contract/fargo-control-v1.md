# FARGO3D live control — interface contract v1 (frame layout)

Status: frame layout FROZEN. Message set provisional (phase 2).
Producers: `tools/live/live_view.py` (bridge, reads dump files) today; `src/control.c` (in-process) in phase 3.
Consumers: the browser viewer today, Unity later. **The consumer must not change when the producer does.**

## 1. Frame (binary, little-endian)

Fixed header, 80 bytes. Then the planet block. Then the payload.

```
off  size  type      field
0    4     char[4]   magic  'F','G','3','D'
4    2     u16       version = 1
6    2     u16       flags   bit0 payload present
                              bit1 sim paused
                              bit2 producer is a file bridge (not in-process)
8    4     u32       frame_id      snapshot index, monotonic
12   4     u32       dropped       frames skipped since the last delivered frame
16   4     u32       nx            azimuthal cells (interior only, no ghosts)
20   4     u32       ny            radial cells    (interior only, no ghosts)
24   4     u32       nz            1 for 2D
28   4     u32       nfields       number of float32 fields in the payload
32   8     f64       t             physical time, code units
40   8     f64       theta         XAxisRotationAngle, radians, WRAPPED to [0,2pi)
48   8     f64       omega         OMEGAFRAME, radians per code time unit
56   8     f64       dt_coarse     DT, physical time between frames
64   4     u32       nplanets
68   4     u32       payload_bytes
72   8     f64       wall_since_prev  wall seconds since the previous frame (producer-local)
```

Planet block, immediately after the header: `nplanets x 7 f64`
`x, y, z, vx, vy, vz, mass` — **rotating-frame coordinates**, same as `planet0.dat`.

Payload, immediately after the planet block: `nfields x nx x ny` float32, field-major,
row-major within a field (row = radial index j, fastest index = azimuthal i), i.e. exactly
the layout of `gasdens{N}.dat` with the dtype narrowed to f32.

Field order when nfields = 3: `dens, vx, vy`. With nfields = 1: `dens`.

## 2. Frame semantics

- Coordinates are the **rotating-frame** grid and planet state. The producer never pre-corrects.
- Client converts to inertial with `pos_inertial = R(+theta) . pos_rotating` and
  `phi_inertial = phi_grid + theta`. `theta` is wrapped; unwrap by choosing the
  representative nearest the previous frame.
- Velocity is the **total** velocity in the rotating frame (not the FARGO residual), so an
  inertial velocity needs `v_inertial = v_rot + omega * z_hat x r`.
- A consumer that cannot parse `version` must refuse, not guess.

## 3. Message set (provisional, JSON lines over the same transport)

```
{"cmd":"hello","proto":1,"client":"..."}                -> {"ok":true,"nx":..,"ny":..,"version":1}
{"cmd":"subscribe","fields":["dens","vx","vy"],"dtype":"f32","every":1}
{"cmd":"get_state"}                                     -> scalars, no payload
{"cmd":"pause"} | {"cmd":"resume"}                      -> applied at the next coarse-step boundary
{"cmd":"step","n":10}                                   -> resume for exactly n boundaries, then pause
{"cmd":"set_param","name":"NU","value":2e-5}
{"cmd":"set_planet","i":0,"mass":0.002}
{"cmd":"set_ntot","value":4000}
{"cmd":"set_pace","sim_time_per_sec":6.283}
{"cmd":"abort"}
```
Every command carries `seq`; every ack returns `{"seq":n,"ok":bool,"applied_at":<frame_id>}` or
`{"seq":n,"ok":false,"class":"static|derived|unknown","reason":"..."}`.

## 4. Mutability classes

```
dynamic   NTOT, DT, NU, Sys->mass[i], Sys->x/y/z/vx/vy/vz[i]
static    NX, NY, NZ, SETUP, PLANETCONFIG, PLANETMASS, SIGMA0, ASPECTRATIO
derived   OMEGAFRAME, XAxisRotationAngle  (reject: writing one alone desynchronises field and frame)
```

## 5. Invariants (the tests that decide whether this works)

```
I1  CONTROL_MODE=OFF and a bridge-fed run produce byte-identical dumps to a plain run
I2  a command applies only at a coarse-step boundary, never mid-DT
I3  the producer writes a journal line per applied command; the run is replayable from it
I4  the consumer sees `theta` and `omega` every frame and never recomputes theta from t
I5  a producer that cannot fill a field declares nfields smaller, never zero-filled data
```
