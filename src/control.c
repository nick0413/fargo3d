/** \file control.c

Live frame emitter. Compiled into the binary, dormant unless FARGO_CONTROL_PORT is set.

Purpose: emit v1 frames (contract/fargo-control-v1.md) at sub-coarse cadence — two frames per
coarse step, i.e. one at the midpoint of the DT interval and one at its end. The dump files
cannot do this: NINTERM and NSNAP are counted in coarse steps, so nothing on disk exists
between two DT boundaries.

Discipline this file obeys:
  * fields are read through INPUT() only, exactly as output.c's WriteField does, so the GPU
    freshness flags stay consistent and no later step reads stale host data
  * the socket is non-blocking and one client only; a slow or dead reader drops frames and
    never blocks the solver
  * no command path, no parameter writes, no state mutation: this is a read-only emitter
*/

#include "fargo3d.h"

#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define CTL_MAGIC 0x44334746u /* "FG3D" little-endian */
#define CTL_VERSION 1
#define CTL_FLAG_PAYLOAD 1
#define CTL_HDR 80
#define CTL_OVERLAY 56
#define PAYLOAD_FIELDS 3

static int ctl_listen = -1;
static int ctl_client = -1;
static unsigned int ctl_seq = 0;
static unsigned long ctl_sent = 0, ctl_dropped = 0;
static unsigned char *ctl_buf = NULL;
static size_t ctl_cap = 0;
static int ctl_half_done = 0;

static void ctl_close_client(void) {
  if (ctl_client >= 0) { close(ctl_client); ctl_client = -1; }
}

static void ctl_try_accept(void) {
  int c = accept(ctl_listen, NULL, NULL);
  if (c < 0) return;
  fcntl(c, F_SETFL, fcntl(c, F_GETFL, 0) | O_NONBLOCK);
  /* take over from a stale reader: a killed relay is only noticed on a failed send, so
     without this the emitter would keep a dead client forever and a restarted relay
     would connect and receive nothing. */
  if (ctl_client >= 0) close(ctl_client);
  ctl_client = c;
  if (CPU_Master) masterprint("CONTROL client connected\n");
}

static void put_f64(unsigned char *p, double v) { memcpy(p, &v, 8); }
static void put_u32(unsigned char *p, unsigned int v) { memcpy(p, &v, 4); }
static void put_u16(unsigned char *p, unsigned short v) { memcpy(p, &v, 2); }

static void ctl_emit(void) {
  size_t ncell, need, off;
  int i, j;
  double t = PhysicalTime;
  double theta = XAxisRotationAngle;
  double omega = OMEGAFRAME;
  unsigned int np = (Sys != NULL) ? (unsigned int)Sys->nb : 0u;

  if (ctl_listen < 0) return;
  ctl_try_accept();
  if (ctl_client < 0) return;

  ncell = (size_t)Nx * (size_t)Ny;
  need = CTL_HDR + (size_t)np * CTL_OVERLAY + (size_t)PAYLOAD_FIELDS * ncell * 4u;
  if (need > ctl_cap) {
    unsigned char *nb = (unsigned char *)realloc(ctl_buf, need);
    if (nb == NULL) { ctl_close_client(); ctl_dropped++; return; }
    ctl_buf = nb;
    ctl_cap = need;
  }

  /* header, contract v1 */
  put_u32(ctl_buf + 0, CTL_MAGIC);
  put_u16(ctl_buf + 4, CTL_VERSION);
  put_u16(ctl_buf + 6, CTL_FLAG_PAYLOAD);
  put_u32(ctl_buf + 8, ctl_seq);
  put_u32(ctl_buf + 12, (unsigned int)ctl_dropped);
  put_u32(ctl_buf + 16, (unsigned int)Nx);
  put_u32(ctl_buf + 20, (unsigned int)Ny);
  put_u32(ctl_buf + 24, (unsigned int)Nz);
  put_u32(ctl_buf + 28, PAYLOAD_FIELDS);
  put_f64(ctl_buf + 32, t);
  put_f64(ctl_buf + 40, theta);
  put_f64(ctl_buf + 48, omega);
  put_f64(ctl_buf + 56, (double)DT);
  put_u32(ctl_buf + 64, np);
  put_u32(ctl_buf + 68, (unsigned int)(PAYLOAD_FIELDS * ncell * 4u));
  put_f64(ctl_buf + 72, 0.0);

  /* planet block: x y z vx vy vz mass per planet, rotating frame */
  off = CTL_HDR;
  for (i = 0; i < (int)np; i++) {
    put_f64(ctl_buf + off + 0, Sys->x[i]);
    put_f64(ctl_buf + off + 8, Sys->y[i]);
    put_f64(ctl_buf + off + 16, Sys->z[i]);
    put_f64(ctl_buf + off + 24, Sys->vx[i]);
    put_f64(ctl_buf + off + 32, Sys->vy[i]);
    put_f64(ctl_buf + off + 40, Sys->vz[i]);
    put_f64(ctl_buf + off + 48, Sys->mass[i]);
    off += CTL_OVERLAY;
  }

  /* payload: interior cells only, row = radial, float32 */
  {
    Field *fl[PAYLOAD_FIELDS];
    int f;
    fl[0] = Density; fl[1] = Vx; fl[2] = Vy;
    for (f = 0; f < PAYLOAD_FIELDS; f++) {
      real *src;
      INPUT(fl[f]);
      src = fl[f]->field_cpu;
      for (j = NGHY; j < Ny + NGHY; j++) {
        int base = j * Pitch_cpu + NGHZ * Stride_cpu + NGHX;
        float *dst = (float *)(ctl_buf + off + (size_t)f * ncell * 4u);
        for (i = 0; i < Nx; i++) dst[(size_t)(j - NGHY) * Nx + i] = (float)src[base + i];
      }
    }
  }

  {
    ssize_t w = send(ctl_client, ctl_buf, need, MSG_NOSIGNAL);
    if (w != (ssize_t)need) {
      /* non-blocking socket could not take the whole frame: drop it, never block the solver */
      ctl_dropped++;
      ctl_close_client();
    } else {
      ctl_sent++;
      ctl_seq++;
    }
  }
}

/** Called after every fine step: emits at the midpoint of the DT interval. */
void ControlTick(real dtemp, real DTv) {
  if (ctl_listen < 0) return;
  if (!ctl_half_done && dtemp >= 0.5 * DTv) {
    ctl_half_done = 1;
    ctl_emit();
  }
}

/** Called once per coarse step, after the fine loop: emits the boundary frame. */
void ControlCoarseDone(void) {
  if (ctl_listen < 0) return;
  ctl_half_done = 0;
  ctl_emit();
}

/** Called once at start-up. Dormant unless FARGO_CONTROL_PORT is set. */
void ControlInit(void) {
  const char *env = getenv("FARGO_CONTROL_PORT");
  struct sockaddr_in addr;
  int port, one = 1;

  if (env == NULL || *env == 0) return;
  port = atoi(env);
  if (port <= 0 || port > 65535) return;

  ctl_listen = socket(AF_INET, SOCK_STREAM, 0);
  if (ctl_listen < 0) { mastererr("CONTROL: socket() failed\n"); return; }
  setsockopt(ctl_listen, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons((unsigned short)port);
  if (bind(ctl_listen, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    mastererr("CONTROL: bind(%d) failed: %s\n", port, strerror(errno));
    close(ctl_listen);
    ctl_listen = -1;
    return;
  }
  listen(ctl_listen, 1);
  fcntl(ctl_listen, F_SETFL, fcntl(ctl_listen, F_GETFL, 0) | O_NONBLOCK);
  if (CPU_Master) masterprint("CONTROL listening on 127.0.0.1:%d\n", port);
}
