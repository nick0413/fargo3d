#!/usr/bin/env python3
"""Animate FARGO3D gas-density snapshots into an MP4.

Snapshots are raw binary: ny rows of nx cells, one real each. The precision is a build
choice (float32 with `FARGO_OPT += -DFLOAT`, float64 otherwise), and the file size tells
you which one you have, so nothing here needs to know how the code was compiled.

    plot_disk.py --dir outputs/fargo                      # infer grid, dtype and frame list
    plot_disk.py --dir ~/fargo-live/live --out gap.mp4    # any OutputDir
    plot_disk.py --dir outputs/fargo --ninterm 20 --dt 0.314 --omega 1.0005   # label orbits

Needs numpy and matplotlib. The MP4 writer needs ffmpeg; the default codec is libx264,
which needs no GPU. Pass --codec h264_nvenc to use an NVIDIA encoder.
"""
import argparse
import os
import re
import sys

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, FFMpegWriter

NGH = 3  # FARGO3D ghost zones per side; domain_y.dat carries them, the fields do not


def die(msg):
    sys.stderr.write("plot_disk: %s\n" % msg)
    raise SystemExit(2)


def infer_grid(outdir):
    """Return (nx, ny) from the domain files, or (None, None) if they are not there."""
    fx, fy = os.path.join(outdir, "domain_x.dat"), os.path.join(outdir, "domain_y.dat")
    if not (os.path.isfile(fx) and os.path.isfile(fy)):
        return None, None
    nx = len(np.loadtxt(fx)) - 1                       # cell edges
    ny = len(np.loadtxt(fy)) - (2 * NGH + 1)           # drop ghost rows, keep interior edges
    return int(nx), int(ny)


def snapshot_list(outdir):
    """gasdens<N>.dat with no rank suffix, ordered by N."""
    found = []
    for name in os.listdir(outdir):
        m = re.fullmatch(r"gasdens(\d+)\.dat", name)
        if m:
            found.append((int(m.group(1)), os.path.join(outdir, name)))
    return [p for _, p in sorted(found)]


def infer_dtype(path, nx, ny):
    size = os.path.getsize(path)
    cells = nx * ny
    if size == cells * 4:
        return np.float32
    if size == cells * 8:
        return np.float64
    die("%s is %d bytes; %d x %d cells is neither float32 (%d) nor float64 (%d). "
        "Pass --nx/--ny if the grid is different." % (path, size, nx, ny, cells * 4, cells * 8))


def main():
    ap = argparse.ArgumentParser(description="Animate FARGO3D gas density snapshots.")
    ap.add_argument("--dir", required=True, help="OutputDir holding gasdens<N>.dat")
    ap.add_argument("--nx", type=int, help="azimuthal cells (default: read domain_x.dat)")
    ap.add_argument("--ny", type=int, help="radial cells (default: read domain_y.dat)")
    ap.add_argument("--out", default="jupiter_gap.mp4", help="output file")
    ap.add_argument("--codec", default="libx264", help="ffmpeg codec (default libx264, no GPU)")
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--ninterm", type=int, help="coarse steps between outputs, labels orbits")
    ap.add_argument("--dt", type=float, help="DT in code units, labels orbits")
    ap.add_argument("--omega", type=float, help="OmegaFrame, labels orbits")
    a = ap.parse_args()

    outdir = os.path.abspath(os.path.expanduser(a.dir))
    if not os.path.isdir(outdir):
        die("%s is not a directory" % outdir)

    nx, ny = a.nx, a.ny
    if nx is None or ny is None:
        gx, gy = infer_grid(outdir)
        nx = gx if nx is None else nx
        ny = gy if ny is None else ny
    if not nx or not ny:
        die("cannot infer the grid: no domain_x.dat/domain_y.dat in %s. Pass --nx and --ny." % outdir)

    files = snapshot_list(outdir)
    if not files:
        die("no gasdens<N>.dat in %s" % outdir)

    dtype = infer_dtype(files[0], nx, ny)
    densities = [np.fromfile(p, dtype=dtype).reshape(ny, nx) for p in files]

    phi = np.loadtxt(os.path.join(outdir, "domain_x.dat"))
    r_all = np.loadtxt(os.path.join(outdir, "domain_y.dat"))
    r_edges = r_all[NGH:NGH + ny + 1]
    r_centers = 0.5 * (r_edges[:-1] + r_edges[1:])
    R, Phi = np.meshgrid(r_edges, phi, indexing="ij")
    X, Y = R * np.cos(Phi), R * np.sin(Phi)

    orbits = None
    if a.ninterm and a.dt and a.omega:
        per_output = a.ninterm * a.dt * a.omega / (2 * np.pi)
        if per_output > 0:
            orbits = [i * per_output for i in range(len(densities))]

    initial = densities[0].mean(axis=1)
    vmin = min(d.min() for d in densities)
    vmax = max(d.max() for d in densities)

    fig, axes = plt.subplots(1, 2, figsize=(13, 5))
    mesh = axes[0].pcolormesh(X, Y, densities[0], shading="auto", cmap="inferno",
                              vmin=vmin, vmax=vmax)
    axes[0].set_aspect("equal")
    axes[0].set_xlabel("x")
    axes[0].set_ylabel("y")
    fig.colorbar(mesh, ax=axes[0], label=r"$\Sigma$")

    axes[1].plot(r_centers, initial, label="first output", color="gray", linestyle="--")
    line, = axes[1].plot(r_centers, initial, label="current")
    axes[1].set_xlabel("Radius")
    axes[1].set_ylabel(r"$\langle\Sigma\rangle_\phi$")
    axes[1].set_title("Radial density profile")
    axes[1].set_ylim(0, max(d.mean(axis=1).max() for d in densities) * 1.1)
    axes[1].legend()
    axes[1].grid(alpha=0.3)
    fig.tight_layout()

    def update(frame):
        sigma = densities[frame]
        mesh.set_array(sigma.ravel())
        line.set_ydata(sigma.mean(axis=1))
        if orbits is not None:
            axes[0].set_title("gas surface density - %.2f orbits" % orbits[frame])
        else:
            axes[0].set_title("gas surface density - output %d of %d"
                              % (frame, len(densities) - 1))
        return mesh, line

    anim = FuncAnimation(fig, update, frames=len(densities), interval=int(1000 / a.fps), blit=False)
    writer = FFMpegWriter(fps=a.fps, codec=a.codec, bitrate=3000,
                          extra_args=["-pix_fmt", "yuv420p"])
    anim.save(a.out, writer=writer, dpi=a.dpi)
    plt.close(fig)
    print("saved %s  (%d frames, %dx%d, %s)" % (a.out, len(densities), nx, ny, np.dtype(dtype).name))


if __name__ == "__main__":
    main()
