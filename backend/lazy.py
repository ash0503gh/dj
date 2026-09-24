"""
lazy.py - Import heavy libraries (librosa + numba, scipy) on first attribute access.

The web-server process only needs light helpers from the audio modules; the DSP itself runs in
short-lived child processes. Deferring these imports keeps the server ~100 MB smaller, which
matters when it shares a 512 MB instance with a running job.
"""

import importlib


class LazyModule:
    def __init__(self, name):
        self._name = name
        self._mod = None

    def __getattr__(self, attr):
        if self._mod is None:
            self._mod = importlib.import_module(self._name)
        return getattr(self._mod, attr)
