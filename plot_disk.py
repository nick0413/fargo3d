import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, FFMpegWriter
from pathlib import Path

out = Path("outputs/fargo")

nx = 384
ny = 128
nframes = 51

# Read grid
phi_edges = np.loadtxt(out / "domain_x.dat")[:nx + 1]
r_edges = np.loadtxt(out / "domain_y.dat")[3:3 + ny + 1]
r_centers = 0.5 * (r_edges[:-1] + r_edges[1:])

R, Phi = np.meshgrid(r_edges, phi_edges, indexing="ij")
X = R * np.cos(Phi)
Y = R * np.sin(Phi)

# Load snapshots
densities = [
    np.fromfile(out / f"gasdens{i}.dat", dtype=np.float64).reshape(ny, nx)
    for i in range(nframes)
]

sigma_initial = densities[0]
initial_profile = sigma_initial.mean(axis=1)

# Use the same color scale for every frame
vmin = min(d.min() for d in densities)
vmax = max(d.max() for d in densities)

fig, axes = plt.subplots(1, 2, figsize=(13, 5))

# Left: 2D disk
mesh = axes[0].pcolormesh(
    X, Y, sigma_initial,
    shading="auto",
    cmap="inferno",
    vmin=vmin,
    vmax=vmax,
)

axes[0].set_aspect("equal")
axes[0].set_xlabel("x")
axes[0].set_ylabel("y")

fig.colorbar(mesh, ax=axes[0], label=r"$\Sigma$")

# Right: radial profile
axes[1].plot(
    r_centers,
    initial_profile,
    label="Initial",
    color="gray",
    linestyle="--",
)

line, = axes[1].plot(
    r_centers,
    initial_profile,
    label="Current",
)

axes[1].axvline(
    1, color="black", linestyle=":", label="Jupiter"
)

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

    axes[0].set_title(f"Gas surface density — {frame} orbits")

    return mesh, line

animation = FuncAnimation(
    fig,
    update,
    frames=nframes,
    interval=100,
    blit=False,
)

# Save as MP4
writer = FFMpegWriter(
    fps=10,
    codec="h264_nvenc",
    bitrate=3000,
    extra_args=["-pix_fmt", "yuv420p"],
)
animation.save(
    "jupiter_gap.mp4",
    writer=writer,
    dpi=150,
)

plt.close(fig)

print("Saved: jupiter_gap.mp4")

