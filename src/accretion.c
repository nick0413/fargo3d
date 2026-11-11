/** \file accretion.c

Planet accretion sink + mass / angular-momentum budget diagnostic.

SINK    dormant unless FARGO_ACCRETION=1
        r_cap = FARGO_ACCRETION_FRAC * R_Hill,  R_Hill = a (m/3M*)^(1/3)   (default frac 0.2)
        removes 1-exp(-acc*dt) of every cell inside r_cap, uniformly: density (and energy if
        adiabatic) shrink, the cell's specific momentum is untouched.
        Removed mass and momentum are added to the planet.

        Applied ONCE PER COARSE STEP, immediately before SolveOrbits advances the planet.
        Applying it per fine step instead leaves a first-order (O(dt)) error in angular
        momentum -- measured 0.39% over two orbits -- because the kick then sits outside the
        integrator that owns the planet's motion. There is deliberately no fine-step path.

DIAG    OUTPUTDIR/budget.dat when FARGO_DIAG=1, one row per coarse step, written immediately
        after the sink has acted:
          time planet m_planet m_acc L_planet L_sink m_damped m_gas_pre m_gas_post dm_step max_L_err

        Checks this file is meant to settle:
          (a) m_gas_pre - m_gas_post == dm_step        the removal is what it books
          (b) L_planet(t) - L_planet(0) == L_sink      central force conserves L exactly
          (c) m_gas change + m_acc + m_damped + M_ej = 0
        max_L_err is the worst per-application difference between the planet's actual change in
        angular momentum and the amount booked; it should sit at machine precision.
*/
#include "fargo3d.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

real DampingMass = 0.0;    /* accumulated by stockholm.c; this object is never translated to .cu */

static int acc_on = 0;
static int diag_on = 0;
static int acc_nb = 0;
static real acc_frac = 0.2;
static real *acc_mass = NULL;      /* cumulative accreted mass per planet */
static real *acc_l = NULL;         /* cumulative angular momentum booked per planet */
static FILE *diag = NULL;
static real m_damped = 0.0;
static real track_max_l = 0.0;
static real dt_pending = 0.0;

/* Domain gas mass summed with exactly the index macro and volume expression the removal loop
   uses. If this disagrees with ComputeInnerMass(1e30), the two are not covering the same cells
   and the budget will never close however the sink is written. */
static real domain_mass_sinkstyle(void) {
  int i, j, k;
  real sum = 0.0;
  real *rho;

  INPUT(Density);
  rho = Density->field_cpu;
  for (k = NGHZ; k < Nz + NGHZ; k++)
    for (j = NGHY; j < Ny + NGHY; j++)
      for (i = NGHX; i < Nx + NGHX; i++)
        sum += rho[l] * Vol(i, j, k);
  return sum;
}

static void acc_write(real dt_step, real dm_step, real m_pre, real m_post,
                      real c_pre, real c_post);

void AccretionInit(void) {
  const char *e = getenv("FARGO_ACCRETION");
  const char *dg = getenv("FARGO_DIAG");
  const char *f;
  char path[MAXLINELENGTH];

  diag_on = (dg != NULL && atoi(dg) != 0);
  acc_on = (e != NULL && atoi(e) != 0);
  if (Sys == NULL || Sys->nb <= 0) { acc_on = 0; diag_on = 0; return; }

  f = getenv("FARGO_ACCRETION_FRAC");
  if (f != NULL) acc_frac = (real)atof(f);
  if (acc_frac <= 0.0) acc_frac = 0.2;

  acc_nb = Sys->nb;
  acc_mass = (real *)calloc((size_t)acc_nb, sizeof(real));
  acc_l = (real *)calloc((size_t)acc_nb, sizeof(real));
  if (acc_mass == NULL || acc_l == NULL) { acc_on = 0; diag_on = 0; return; }

  if (diag_on) {
    sprintf(path, "%sbudget.dat", OUTPUTDIR);
    diag = fopen(path, "w");
    if (diag != NULL)
      fprintf(diag, "# time planet m_planet m_acc L_planet L_sink m_damped m_loop_pre m_loop_post m_cim_pre m_cim_post dm_step max_L_err\n");
    else
      diag_on = 0;
  }
  if (CPU_Master) {
    if (acc_on)
      masterprint("ACCRETION on: r_cap = %.2f R_Hill, once per coarse step\n", (double)acc_frac);
    if (diag_on) masterprint("BUDGET diagnostic on -> %sbudget.dat\n", OUTPUTDIR);
  }
}

/* Remove gas and hand it to the planets. Returns the total mass removed this call. */
static real acc_apply(real dt) {
  int p, i, j, k, n, any = 0;
  real total = 0.0;
  real *rho, *vx, *vy;
#ifdef ADIABATIC
  real *en;
#endif

  if (!acc_on || Sys == NULL || Sys->acc == NULL) return 0.0;
  n = Sys->nb;
  if (n != acc_nb) return 0.0;
  for (p = 0; p < n; p++) if (Sys->acc[p] > 0.0) any = 1;
  if (!any) return 0.0;

  INPUT(Density);
  INPUT(Vx);
  INPUT(Vy);
  OUTPUT(Density);
  OUTPUT(Vx);
  OUTPUT(Vy);
#ifdef ADIABATIC
  INPUT(Energy);
  OUTPUT(Energy);
#endif

  rho = Density->field_cpu;
  vx = Vx->field_cpu;
  vy = Vy->field_cpu;
#ifdef ADIABATIC
  en = Energy->field_cpu;
#endif

  for (p = 0; p < n; p++) {
    real mp = Sys->mass[p];
    real xp = Sys->x[p], yp = Sys->y[p];
    real a = sqrt(xp * xp + yp * yp);
    real rh = a * cbrt(mp / (3.0 * MSTAR));
    real rcap = acc_frac * rh;
    real frac = 1.0 - exp(-Sys->acc[p] * dt);
    real rcap2 = rcap * rcap;
    real dm = 0.0, dpx = 0.0, dpy = 0.0;
    real vpx = Sys->vx[p], vpy = Sys->vy[p];

    if (mp <= 0.0 || a <= 0.0 || frac <= 0.0) continue;
    if (frac > 1.0) frac = 1.0;

    for (k = NGHZ; k < Nz + NGHZ; k++) {
      for (j = NGHY; j < Ny + NGHY; j++) {
        real r = ymed(j);
        real dr = r - a;
        if (dr < 0.0) dr = -dr;
        if (dr > rcap) continue;                     /* radial reject */
        for (i = NGHX; i < Nx + NGHX; i++) {
          real phi = xmed(i);
          real x = r * cos(phi), y = r * sin(phi);
          real dx = x - xp, dy = y - yp;
          if (dx * dx + dy * dy > rcap2) continue;
          /* 'l' is the library index macro derived from i,j,k -- never declare it */
          dm += frac * rho[l] * Vol(i, j, k);
          dpx += frac * rho[l] * Vol(i, j, k) * vx[l];
          dpy += frac * rho[l] * Vol(i, j, k) * vy[l];
          rho[l] *= (1.0 - frac);
#ifdef ADIABATIC
          en[l] *= (1.0 - frac);
#endif
        }
      }
    }

    if (dm > 0.0) {
      /* The momentum increment is dm*v + dp, so the angular momentum increment about the star
         is L_z of that vector. L is the right observable in polar coordinates: the star's
         central force conserves it exactly, so it isolates the sink from orbital phase. */
      real booking = xp * (dm * vpy + dpy) - yp * (dm * vpx + dpx);
      real l_before = mp * (xp * vpy - yp * vpx);
      real l_after;

      acc_l[p] += booking;
      Sys->mass[p] += dm;
      Sys->vx[p] += dpx / Sys->mass[p];
      Sys->vy[p] += dpy / Sys->mass[p];
      acc_mass[p] += dm;
      total += dm;

      l_after = Sys->mass[p] * (Sys->x[p] * Sys->vy[p] - Sys->y[p] * Sys->vx[p]);
      {
        real e = fabs((l_after - l_before) - booking);
        if (e > track_max_l) track_max_l = e;
      }
    }
  }
  return total;
}

static void acc_write(real dt_step, real dm_step, real m_pre, real m_post,
                      real c_pre, real c_post) {
  int p;

  if (!diag_on || diag == NULL) return;
  m_damped += DampingMass;
  DampingMass = 0.0;

  for (p = 0; p < acc_nb; p++) {
    real lpl = Sys->mass[p] * (Sys->x[p] * Sys->vy[p] - Sys->y[p] * Sys->vx[p]);
    fprintf(diag, "%.10g %d %.12e %.12e %.12e %.12e %.12e %.12e %.12e %.12e %.12e %.6e %.6e\n",
            (double)PhysicalTime, p, (double)Sys->mass[p], (double)acc_mass[p],
            (double)lpl, (double)acc_l[p], (double)m_damped,
            (double)m_pre, (double)m_post, (double)c_pre, (double)c_post,
            (double)dm_step, (double)track_max_l);
  }
  fflush(diag);
}

/* Called at the end of every fine step: only accumulates time. */
void AccretionStep(real dt) {
  dt_pending += dt;
}

/* Called once per coarse step, immediately before SolveOrbits. */
void AccretionCoarse(void) {
  real d, dm = 0.0, m_pre = 0.0, m_post = 0.0, c_pre = 0.0, c_post = 0.0;

  if (dt_pending <= 0.0) return;
  d = dt_pending;
  dt_pending = 0.0;

  if (diag_on) {
    m_pre = domain_mass_sinkstyle();
    c_pre = ComputeInnerMass(1.0e30);
  }
  dm = acc_apply(d);
  if (diag_on) {
    m_post = domain_mass_sinkstyle();
    c_post = ComputeInnerMass(1.0e30);
  }
  acc_write(d, dm, m_pre, m_post, c_pre, c_post);
}
