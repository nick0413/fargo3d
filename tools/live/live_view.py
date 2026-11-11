#!/usr/bin/env python3
"""FARGO3D live relay: consumes v1 frames from the in-process control emitter (src/control.c)
and serves them to the browser over HTTP, with a RAM ring the UI can scrub, clear or truncate.

Path B was the dump-file bridge; this is path C - the producer is the simulation itself, so
frames exist at two per coarse step instead of one per NINTERM.

Controls exposed on POST /control:
  sim_stop / sim_run   SIGSTOP / SIGCONT the simulation
  clear                drop every stored frame (capture continues from wherever the sim is)
  truncate             drop every frame AFTER the playhead index given as {"from": idx}
"""
import array
import json
import os
import re
import signal
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTROL_ADDR = ("127.0.0.1", 9100)
PORT = 8088
SIM_PID = None
MAX_ORBITS = 60.0
WEB_DIR = "/home/nick/fargo-bench/web"
CTRL_LOG = "/home/nick/fargo-bench/live-controls.log"
BIN = None
PAR = None
WORKDIR = None
_popen = None
DUMPDIR = None
NINTERM = 10
DT = 0.314159265359
OMEGA = 1.0005
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
        ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".json": "application/json", ".map": "application/json"}

FRAMES = []              # list of dicts: index, orbit, t, blob
LOCK = threading.Lock()
META = {"sim_stopped": False, "buffer_full": False, "error": None,
        "connected": False, "received": 0, "rate": 0.0, "recomputing": False}


def log_control(what):
    try:
        with open(CTRL_LOG, "a") as f:
            f.write("%s bridge pid=%s action=%s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), SIM_PID, what))
    except OSError:
        pass


def recvn(s, n):
    b = bytearray()
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise EOFError("peer closed")
        b += c
    return bytes(b)


def stop_sim(reason):
    if SIM_PID is None or META.get("sim_stopped"):
        return
    try:
        os.kill(SIM_PID, signal.SIGSTOP)
        META["sim_stopped"] = True
        log_control("sim_stop reason=%s" % reason)
        print("[relay] sim %d stopped: %s" % (SIM_PID, reason), flush=True)
    except OSError as e:
        META["error"] = repr(e)


def reader():
    """Consume frames from the emitter and append them to the ring."""
    t_win = []
    while True:
        s = None
        try:
            s = socket.create_connection(CONTROL_ADDR, timeout=5.0)
            s.settimeout(10.0)
            META["connected"] = True
            print("[relay] connected to %s:%d" % CONTROL_ADDR, flush=True)
            while True:
                hdr = recvn(s, 80)
                if hdr[0:4] != b"FG3D":
                    raise ValueError("bad magic")
                fid, dropped, nx, ny, nz, nfields = struct.unpack("<IIIIII", hdr[8:32])
                t, theta, omega, dt = struct.unpack("<dddd", hdr[32:64])
                npl, plen = struct.unpack("<II", hdr[64:72])
                body = recvn(s, npl * 56 + plen)
                blob = hdr + body
                orbit = (t * omega) / (2 * 3.141592653589793) if omega else 0.0
                with LOCK:
                    FRAMES.append({"index": fid, "orbit": orbit, "t": t, "blob": blob})
                    META["received"] += 1
                    META["recomputing"] = False
                    now = time.time()
                    t_win.append(now)
                    while len(t_win) > 2 and now - t_win[0] > 2.0:
                        t_win.pop(0)
                    if len(t_win) > 1:
                        META["rate"] = (len(t_win) - 1) / max(1e-6, now - t_win[0])
                    full = orbit >= MAX_ORBITS and not META.get("buffer_full")
                    if full:
                        META["buffer_full"] = True
                if full:
                    stop_sim("buffer reached %.1f orbits (max %.1f)" % (orbit, MAX_ORBITS))
        except Exception as e:
            if META.get("connected"):
                META["connected"] = False
                print("[relay] emitter disconnected: %r" % (e,), flush=True)
            time.sleep(1.0)
        finally:
            if s is not None:
                try: s.close()
                except OSError: pass


def launch(extra=None):
    """Start (or restart) the simulation. Returns its pid.

    cwd matters: FARGO3D resolves setups/<setup>/<setup>.bound and planets/*.cfg relative to it,
    so a relaunch from the par's directory dies before the main loop."""
    global _popen
    import subprocess
    env = dict(os.environ)
    env["FARGO_CONTROL_PORT"] = str(CONTROL_ADDR[1])
    args = [BIN] + (extra or []) + [PAR]
    log = open("/home/nick/fargo-bench/live-sim.log", "ab")
    _popen = subprocess.Popen(args, cwd=WORKDIR or os.path.dirname(PAR) or None,
                              stdout=log, stderr=log, stdin=subprocess.DEVNULL, env=env,
                              start_new_session=True)
    return _popen.pid


def kill_sim(pid):
    if pid is None:
        return
    for sig in (signal.SIGCONT, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except OSError:
            pass
        time.sleep(0.2)


def dump_index_for_orbit(orbit):
    """Restart index = output index. One output every NINTERM coarse steps, each DT long."""
    per_output = NINTERM * DT * OMEGA / (2 * 3.141592653589793)
    if per_output <= 0:
        return 0
    idx = int(round(orbit / per_output))
    # clamp to what actually exists on disk
    have = []
    try:
        for f in os.listdir(DUMPDIR):
            m = re.match(r"gasdens(\d+)(_\d+)?\.dat$", f)
            if m:
                have.append(int(m.group(1)))
    except OSError:
        return max(0, idx)
    return max(0, min(idx, max(have) if have else 0))


def do_seek(orbit):
    global SIM_PID, OMEGA
    idx = dump_index_for_orbit(orbit)
    META["recomputing"] = True
    META["error"] = None
    META["connected"] = False
    pid = SIM_PID
    kill_sim(pid)
    with LOCK:
        FRAMES.clear()
        META["buffer_full"] = False
        META["sim_stopped"] = False
    time.sleep(0.4)
    newpid = launch(["-s", str(idx)])
    SIM_PID = newpid
    time.sleep(1.5)
    if _popen is not None and _popen.poll() is not None:
        raise RuntimeError("relaunch exited rc=%s - see /home/nick/fargo-bench/live-sim.log"
                           % _popen.returncode)
    log_control("seek orbit=%.3f dump=%d pid=%d" % (orbit, idx, newpid))
    return idx, newpid


def sim_alive():
    if SIM_PID is None:
        return None
    try:
        os.kill(SIM_PID, 0)
        return True
    except OSError:
        return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, q = self.path.partition("?")
        if path not in ("/frame", "/meta"):
            rel = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
            fp = os.path.normpath(os.path.join(WEB_DIR, rel))
            if fp.startswith(os.path.normpath(WEB_DIR)) and os.path.isfile(fp):
                ext = os.path.splitext(fp)[1]
                with open(fp, "rb") as fh:
                    self._send(200, fh.read(), MIME.get(ext, "application/octet-stream"))
                return
            self._send(404, b"not found", "text/plain")
            return
        if path == "/frame":
            m = re.search(r"(?:^|&)at=(\d+)", q)
            want = int(m.group(1)) if m else None
            with LOCK:
                frames = list(FRAMES)
            if not frames:
                self._send(503, b"no frame yet", "text/plain")
                return
            pick = frames[-1]
            if want is not None:
                cand = [f for f in frames if f["index"] <= want]
                pick = cand[-1] if cand else frames[0]
            self._send(200, pick["blob"], "application/octet-stream")
            return
        with LOCK:
            if FRAMES:
                m2 = {"index_first": FRAMES[0]["index"], "index_last": FRAMES[-1]["index"],
                      "orbit_first": round(FRAMES[0]["orbit"], 3),
                      "orbit_last": round(FRAMES[-1]["orbit"], 3),
                      "t_last": FRAMES[-1]["t"], "count": len(FRAMES)}
            else:
                m2 = {"index_first": None, "index_last": None, "orbit_first": None,
                      "orbit_last": None, "t_last": None, "count": 0}
        m2.update(META)
        m2.update({"max_orbits": MAX_ORBITS, "sim_pid": SIM_PID, "sim_alive": sim_alive(),
                   "producer": "src/control.c (in-process, 2 frames per coarse step)",
                   "controls": "sim stop/run, clear, truncate"})
        self._send(200, json.dumps(m2).encode(), "application/json")

    def do_POST(self):
        if self.path.partition("?")[0] != "/control":
            self._send(404, b"", "text/plain")
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._send(400, b'{"ok":false}', "application/json")
            return
        action = req.get("action")

        if action == "seek":
            orb = req.get("orbit")
            if orb is None:
                self._send(200, json.dumps({"ok": False, "reason": "missing 'orbit'"}).encode(),
                           "application/json")
                return
            try:
                idx, pid = do_seek(float(orb))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "reason": repr(e)}).encode(),
                           "application/json")
                return
            self._send(200, json.dumps({"ok": True, "dump": idx, "pid": pid}).encode(),
                       "application/json")
            return

        if action == "clear":
            with LOCK:
                dropped = len(FRAMES)
                FRAMES.clear()
                META["buffer_full"] = False
            log_control("clear dropped=%d" % dropped)
            self._send(200, json.dumps({"ok": True, "dropped": dropped}).encode(),
                       "application/json")
            return

        if action == "truncate":
            frm = req.get("from")
            if frm is None:
                self._send(200, json.dumps({"ok": False, "reason": "missing 'from'"}).encode(),
                           "application/json")
                return
            with LOCK:
                keep = [f for f in FRAMES if f["index"] <= int(frm)]
                dropped = len(FRAMES) - len(keep)
                FRAMES[:] = keep
                META["buffer_full"] = False
            log_control("truncate from=%s dropped=%d" % (frm, dropped))
            self._send(200, json.dumps({"ok": True, "dropped": dropped}).encode(),
                       "application/json")
            return

        if SIM_PID is None or not sim_alive():
            self._send(200, json.dumps({"ok": False, "reason": "no live sim pid"}).encode(),
                       "application/json")
            return
        if action in ("sim_stop", "sim_run"):
            os.kill(SIM_PID, signal.SIGSTOP if action == "sim_stop" else signal.SIGCONT)
            META["sim_stopped"] = (action == "sim_stop")
            log_control(action)
            self._send(200, json.dumps({"ok": True, "sim_stopped": META["sim_stopped"]}).encode(),
                       "application/json")
        else:
            self._send(200, json.dumps({"ok": False, "reason": "unsupported action"}).encode(),
                       "application/json")


def main():
    global CONTROL_ADDR, PORT, SIM_PID, MAX_ORBITS, BIN, PAR, DUMPDIR, NINTERM, DT, WORKDIR
    a = sys.argv[1:]
    for i, x in enumerate(a):
        if x == "--control-host": CONTROL_ADDR = (a[i + 1], CONTROL_ADDR[1])
        if x == "--control-port": CONTROL_ADDR = (CONTROL_ADDR[0], int(a[i + 1]))
        if x == "--port":         PORT = int(a[i + 1])
        if x == "--pid":          SIM_PID = int(a[i + 1])
        if x == "--max-orbits":   MAX_ORBITS = float(a[i + 1])
        if x == "--bin":          globals()["BIN"] = a[i + 1]
        if x == "--par":          globals()["PAR"] = a[i + 1]
        if x == "--dumpdir":      globals()["DUMPDIR"] = a[i + 1]
        if x == "--ninterm":      globals()["NINTERM"] = int(a[i + 1])
        if x == "--dt":           globals()["DT"] = float(a[i + 1])
        if x == "--workdir":      globals()["WORKDIR"] = a[i + 1]
    threading.Thread(target=reader, daemon=True).start()
    print("relay: frames from %s:%d -> http 0.0.0.0:%d  pid %s  max %.1f orbits"
          % (CONTROL_ADDR[0], CONTROL_ADDR[1], PORT, SIM_PID, MAX_ORBITS), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
