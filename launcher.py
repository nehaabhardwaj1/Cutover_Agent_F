# -*- coding: utf-8 -*-
"""
SAP Cutover Agent - GUI Launcher
Provides on-screen Start / Stop buttons so end users never need a terminal.
"""
import os
import subprocess
import sys
import threading
import webbrowser
import tkinter as tk
from pathlib import Path

# -- Config ------------------------------------------------------------------
PYTHON = os.environ.get("CUTOVER_PYTHON") or str(
    Path(os.environ.get("LOCALAPPDATA", "")) / "Python"
    / "pythoncore-3.14-64" / "python.exe")
if not Path(PYTHON).exists():
    PYTHON = sys.executable   # fallback for portability

SERVER_SCRIPT = str((Path(__file__).parent / "brain" / "server.py").resolve())
APP_URL       = "http://localhost:7878"
POLL_MS       = 2000   # status-check interval (milliseconds)

# -- Palette -----------------------------------------------------------------
BG     = "#0a0a0a"
CARD   = "#111111"
BORDER = "#222222"
PURPLE = "#A100FF"
GREEN  = "#00C875"
RED    = "#FF4D4D"
AMBER  = "#FFAB00"
WHITE  = "#FFFFFF"
MUTED  = "#555555"
FONT   = "Segoe UI"


class Launcher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("SAP Cutover Agent")
        self.configure(bg=BG)
        self.resizable(False, False)

        # Centre on screen
        w, h = 360, 280
        self.update_idletasks()
        x = (self.winfo_screenwidth()  - w) // 2
        y = (self.winfo_screenheight() - h) // 2
        self.geometry(f"{w}x{h}+{x}+{y}")

        self._proc   = None        # uvicorn subprocess
        self._status = "stopped"   # "stopped" | "starting" | "running" | "stopping"

        self._build_ui()
        self._poll()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # -- UI ------------------------------------------------------------------
    def _build_ui(self):
        # Header bar
        hdr = tk.Frame(self, bg="#000000", height=54)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)
        tk.Label(hdr, text="*", font=(FONT, 20, "bold"),
                 bg="#000000", fg=PURPLE).pack(side="left", padx=(14, 6), pady=10)
        info = tk.Frame(hdr, bg="#000000")
        info.pack(side="left", pady=10)
        tk.Label(info, text="SAP Cutover Agent",
                 font=(FONT, 12, "bold"), bg="#000000", fg=WHITE).pack(anchor="w")
        tk.Label(info, text="Accenture  |  SAP S/4HANA  |  v2",
                 font=(FONT, 9), bg="#000000", fg=MUTED).pack(anchor="w")

        # Status card
        card = tk.Frame(self, bg=CARD, highlightthickness=1,
                        highlightbackground=BORDER)
        card.pack(fill="x", padx=16, pady=(14, 10))

        row = tk.Frame(card, bg=CARD)
        row.pack(fill="x", padx=14, pady=(12, 4))
        self._dot = tk.Label(row, text="O", font=(FONT, 12, "bold"),
                             bg=CARD, fg=MUTED)
        self._dot.pack(side="left")
        self._status_lbl = tk.Label(row, text="Server stopped",
                                    font=(FONT, 11, "bold"),
                                    bg=CARD, fg=WHITE)
        self._status_lbl.pack(side="left", padx=(8, 0))

        self._sub_lbl = tk.Label(card, text="Click Start to launch the server.",
                                 font=(FONT, 9), bg=CARD, fg=MUTED,
                                 justify="left", anchor="w")
        self._sub_lbl.pack(fill="x", padx=14, pady=(0, 12))

        # Buttons
        btn_frame = tk.Frame(self, bg=BG)
        btn_frame.pack(fill="x", padx=16, pady=4)

        self._btn_start = tk.Button(
            btn_frame, text="  >  Start Server",
            font=(FONT, 11, "bold"), bg=PURPLE, fg=WHITE,
            activebackground="#7500C0", activeforeground=WHITE,
            relief="flat", bd=0, cursor="hand2", pady=10,
            command=self._start)
        self._btn_start.pack(fill="x", pady=(0, 6))

        self._btn_stop = tk.Button(
            btn_frame, text="  []  Stop Server",
            font=(FONT, 11, "bold"), bg="#1a0000", fg=RED,
            activebackground="#2d0000", activeforeground=RED,
            relief="flat", bd=0, cursor="hand2", pady=10,
            state="disabled", command=self._stop)
        self._btn_stop.pack(fill="x")

        # Open browser link
        self._open_btn = tk.Button(
            self, text="Open in browser  ->  localhost:7878",
            font=(FONT, 9), bg=BG, fg=MUTED,
            activebackground=BG, activeforeground=PURPLE,
            relief="flat", bd=0, cursor="hand2",
            state="disabled",
            command=lambda: webbrowser.open(APP_URL))
        self._open_btn.pack(pady=(8, 0))

        # Footer
        ftr = tk.Frame(self, bg="#000000", height=24)
        ftr.pack(fill="x", side="bottom")
        ftr.pack_propagate(False)
        tk.Label(ftr, text=f"Port 7878  |  {APP_URL}",
                 font=(FONT, 8), bg="#000000", fg="#333333").pack(pady=4)

    # -- Actions -------------------------------------------------------------
    def _start(self):
        if self._proc and self._proc.poll() is None:
            return
        self._set_status("starting")
        try:
            flags = 0
            if sys.platform == "win32":
                flags = subprocess.CREATE_NO_WINDOW
            self._proc = subprocess.Popen(
                [PYTHON, SERVER_SCRIPT],
                cwd=str(Path(SERVER_SCRIPT).parent),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=flags,
            )
        except Exception as e:
            self._set_status("stopped")
            self._sub_lbl.config(text=f"Error starting: {e}", fg=RED)

    def _stop(self):
        self._set_status("stopping")
        proc = self._proc
        self._proc = None
        if proc:
            try:
                proc.terminate()
                def _wait():
                    try:
                        proc.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                threading.Thread(target=_wait, daemon=True).start()
            except Exception:
                pass
        self.after(500, lambda: self._set_status("stopped"))

    def _on_close(self):
        if self._proc and self._proc.poll() is None:
            self._stop()
        self.after(600, self.destroy)

    # -- Status / polling ----------------------------------------------------
    def _set_status(self, status: str):
        self._status = status
        cfg = {
            "stopped":  (MUTED,  "O", "Server stopped",   "Click Start to launch the server."),
            "starting": (AMBER,  "~", "Starting...",       "Launching server, please wait..."),
            "running":  (GREEN,  "*", "Server running",    f"App is live at {APP_URL}"),
            "stopping": (AMBER,  "~", "Stopping...",       "Shutting down the server."),
        }
        col, dot, lbl, sub = cfg.get(status, cfg["stopped"])
        self._dot.config(fg=col, text=dot)
        self._status_lbl.config(text=lbl)
        self._sub_lbl.config(text=sub)
        is_running  = (status == "running")
        is_inactive = status in ("stopped",)
        self._btn_start.config(
            state="normal" if is_inactive else "disabled",
            bg=PURPLE if is_inactive else "#333333",
        )
        self._btn_stop.config(
            state="normal" if is_running else "disabled",
            bg="#1a0000" if is_running else "#111111",
        )
        self._open_btn.config(
            state="normal" if is_running else "disabled",
            fg=PURPLE if is_running else MUTED,
        )

    def _check_server(self) -> bool:
        try:
            import urllib.request
            urllib.request.urlopen(APP_URL + "/api/status", timeout=1)
            return True
        except Exception:
            return False

    def _poll(self):
        if self._status == "starting":
            if self._check_server():
                self._set_status("running")
                webbrowser.open(APP_URL)
        elif self._status == "running":
            if not self._check_server():
                self._proc = None
                self._set_status("stopped")
        elif self._status == "stopped":
            # Detect if server was started externally
            if self._check_server():
                self._set_status("running")
        self.after(POLL_MS, self._poll)


if __name__ == "__main__":
    Launcher().mainloop()
