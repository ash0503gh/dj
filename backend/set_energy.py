"""
set_energy.py - Set-Level Energy Arc Management for PULSE PRO DJ System.

Tracks virtual crowd energy across an entire DJ set, preventing energy fatigue
and dead zones. Each transition technique has an energy_delta that shifts the
crowd energy level, and the system picks techniques that follow the desired
energy arc template.
"""

import time
from typing import Dict, Any, List, Optional


TECHNIQUE_ENERGY = {
    "bass_swap":       {"delta": +5,  "style": "smooth",    "min_energy": 30, "max_energy": 85},
    "echo_freeze":     {"delta": -5,  "style": "dramatic",  "min_energy": 20, "max_energy": 90},
    "vinyl_brake":     {"delta": -10, "style": "dramatic",  "min_energy": 25, "max_energy": 95},
    "spinback":        {"delta": +10, "style": "bold",      "min_energy": 35, "max_energy": 90},
    "noise_riser":     {"delta": +15, "style": "build",     "min_energy": 30, "max_energy": 80},
    "loop_roll":       {"delta": +10, "style": "build",     "min_energy": 35, "max_energy": 85},
    "festival_drop":   {"delta": +25, "style": "bomb",      "min_energy": 40, "max_energy": 75},
    "hard_cut":        {"delta": +5,  "style": "bold",      "min_energy": 15, "max_energy": 95},
    "power_cut":       {"delta": +20, "style": "bomb",      "min_energy": 35, "max_energy": 80},
    "fake_drop":       {"delta": +30, "style": "bomb",      "min_energy": 40, "max_energy": 70},
    "silence_drop":    {"delta": +25, "style": "bomb",      "min_energy": 45, "max_energy": 75},
    "rewind":          {"delta": +15, "style": "bold",      "min_energy": 40, "max_energy": 85},
    "double_drop":     {"delta": +30, "style": "bomb",      "min_energy": 50, "max_energy": 70},
    "beatmash_drop":   {"delta": +20, "style": "build",     "min_energy": 40, "max_energy": 80},
    "backspin_slam":   {"delta": +15, "style": "bold",      "min_energy": 35, "max_energy": 85},
    "tension_riser":   {"delta": +20, "style": "build",     "min_energy": 35, "max_energy": 75},
    "stutter_edit":    {"delta": +8,  "style": "smooth",    "min_energy": 30, "max_energy": 85},
    "filter_sweep":    {"delta": +3,  "style": "smooth",    "min_energy": 20, "max_energy": 90},
    "echo_dissolve":   {"delta": -15, "style": "dramatic",  "min_energy": 20, "max_energy": 95},
    "acapella_mashup": {"delta": +10, "style": "bold",      "min_energy": 30, "max_energy": 85},
    "vocal_chop":      {"delta": +12, "style": "bold",      "min_energy": 35, "max_energy": 80},
    "drum_swap":       {"delta": +5,  "style": "smooth",    "min_energy": 25, "max_energy": 90},
    "seamless":        {"delta": 0,   "style": "smooth",    "min_energy": 10, "max_energy": 95},
}


ENERGY_ARC_TEMPLATES = {
    "festival_mainstage": {
        "description": "Big builds, massive drops every 3-4 tracks, peak at 60-70% through",
        "phases": [
            {"start_pct": 0.0,  "end_pct": 0.15, "target_energy": 45, "preferred_styles": ["smooth", "build"]},
            {"start_pct": 0.15, "end_pct": 0.35, "target_energy": 65, "preferred_styles": ["build", "bold"]},
            {"start_pct": 0.35, "end_pct": 0.50, "target_energy": 80, "preferred_styles": ["bomb", "bold"]},
            {"start_pct": 0.50, "end_pct": 0.60, "target_energy": 60, "preferred_styles": ["dramatic", "smooth"]},
            {"start_pct": 0.60, "end_pct": 0.80, "target_energy": 90, "preferred_styles": ["bomb", "build"]},
            {"start_pct": 0.80, "end_pct": 0.95, "target_energy": 95, "preferred_styles": ["bomb", "bold"]},
            {"start_pct": 0.95, "end_pct": 1.00, "target_energy": 50, "preferred_styles": ["dramatic", "smooth"]},
        ]
    },
    "underground_club": {
        "description": "Slow burn, groove-focused, peaks every 6-7 tracks, subtle tension",
        "phases": [
            {"start_pct": 0.0,  "end_pct": 0.20, "target_energy": 35, "preferred_styles": ["smooth"]},
            {"start_pct": 0.20, "end_pct": 0.45, "target_energy": 55, "preferred_styles": ["smooth", "build"]},
            {"start_pct": 0.45, "end_pct": 0.55, "target_energy": 70, "preferred_styles": ["bold", "build"]},
            {"start_pct": 0.55, "end_pct": 0.70, "target_energy": 55, "preferred_styles": ["smooth", "dramatic"]},
            {"start_pct": 0.70, "end_pct": 0.90, "target_energy": 75, "preferred_styles": ["bold", "build"]},
            {"start_pct": 0.90, "end_pct": 1.00, "target_energy": 40, "preferred_styles": ["dramatic", "smooth"]},
        ]
    },
    "warmup_set": {
        "description": "Gradual energy build over 30 min, save bombs for later",
        "phases": [
            {"start_pct": 0.0,  "end_pct": 0.30, "target_energy": 30, "preferred_styles": ["smooth"]},
            {"start_pct": 0.30, "end_pct": 0.60, "target_energy": 45, "preferred_styles": ["smooth", "build"]},
            {"start_pct": 0.60, "end_pct": 0.85, "target_energy": 60, "preferred_styles": ["build", "bold"]},
            {"start_pct": 0.85, "end_pct": 1.00, "target_energy": 70, "preferred_styles": ["bold", "build"]},
        ]
    },
    "peak_time": {
        "description": "High energy throughout with wave pattern, constant bangers",
        "phases": [
            {"start_pct": 0.0,  "end_pct": 0.10, "target_energy": 70, "preferred_styles": ["bold", "build"]},
            {"start_pct": 0.10, "end_pct": 0.30, "target_energy": 85, "preferred_styles": ["bomb", "bold"]},
            {"start_pct": 0.30, "end_pct": 0.40, "target_energy": 65, "preferred_styles": ["dramatic", "smooth"]},
            {"start_pct": 0.40, "end_pct": 0.60, "target_energy": 90, "preferred_styles": ["bomb", "bold"]},
            {"start_pct": 0.60, "end_pct": 0.70, "target_energy": 70, "preferred_styles": ["dramatic", "bold"]},
            {"start_pct": 0.70, "end_pct": 0.90, "target_energy": 95, "preferred_styles": ["bomb", "build"]},
            {"start_pct": 0.90, "end_pct": 1.00, "target_energy": 60, "preferred_styles": ["dramatic"]},
        ]
    },
}


class SetEnergyManager:
    """Tracks and manages energy across an entire DJ set."""

    def __init__(self, arc_template: str = "festival_mainstage", total_tracks: int = 15):
        self.arc_template = arc_template
        self.arc = ENERGY_ARC_TEMPLATES.get(arc_template, ENERGY_ARC_TEMPLATES["festival_mainstage"])
        self.total_tracks = total_tracks
        self.crowd_energy = 40.0
        self.transitions_done = 0
        self.history: List[Dict[str, Any]] = []
        self.last_peak_at = -1
        self.last_bomb_at = -1
        self.started_at = time.time()

    def get_set_position(self) -> float:
        if self.total_tracks <= 1:
            return 0.5
        return min(1.0, self.transitions_done / (self.total_tracks - 1))

    def get_current_phase(self) -> Dict[str, Any]:
        pos = self.get_set_position()
        for phase in self.arc["phases"]:
            if phase["start_pct"] <= pos < phase["end_pct"]:
                return phase
        return self.arc["phases"][-1]

    def get_target_energy(self) -> float:
        return self.get_current_phase()["target_energy"]

    def get_preferred_styles(self) -> List[str]:
        return self.get_current_phase()["preferred_styles"]

    def score_technique(self, technique: str) -> float:
        """Score a technique based on current set energy state. Higher = better fit."""
        meta = TECHNIQUE_ENERGY.get(technique)
        if not meta:
            return 0.5

        target = self.get_target_energy()
        preferred = self.get_preferred_styles()
        projected = self.crowd_energy + meta["delta"]

        score = 1.0

        energy_distance = abs(projected - target)
        if energy_distance < 10:
            score += 0.3
        elif energy_distance < 20:
            score += 0.1
        elif energy_distance > 40:
            score -= 0.4

        if meta["style"] in preferred:
            score += 0.3

        if projected < meta["min_energy"] or projected > meta["max_energy"]:
            score -= 0.5

        if self.crowd_energy < 30 and meta["delta"] < -5:
            score -= 0.6
        if self.crowd_energy > 85 and meta["delta"] > 15:
            score -= 0.4

        since_bomb = self.transitions_done - self.last_bomb_at
        if meta["style"] == "bomb":
            if since_bomb < 3:
                score -= 0.5
            elif since_bomb >= 4:
                score += 0.2

        return max(0.0, min(2.0, score))

    def rank_techniques(self, candidates: List[str]) -> List[Dict[str, Any]]:
        """Rank techniques by energy fit. Returns sorted list with scores."""
        scored = []
        for tech in candidates:
            s = self.score_technique(tech)
            meta = TECHNIQUE_ENERGY.get(tech, {})
            scored.append({
                "technique": tech,
                "energy_score": round(s, 3),
                "delta": meta.get("delta", 0),
                "projected_energy": round(self.crowd_energy + meta.get("delta", 0), 1),
                "style": meta.get("style", "unknown"),
            })
        scored.sort(key=lambda x: x["energy_score"], reverse=True)
        return scored

    def apply_transition(self, technique: str):
        """Record a transition and update energy state."""
        meta = TECHNIQUE_ENERGY.get(technique, {"delta": 0, "style": "smooth"})
        old_energy = self.crowd_energy
        self.crowd_energy = max(10.0, min(100.0, self.crowd_energy + meta["delta"]))

        if meta["style"] == "bomb":
            self.last_bomb_at = self.transitions_done
        if self.crowd_energy >= 80:
            self.last_peak_at = self.transitions_done

        self.history.append({
            "transition": self.transitions_done,
            "technique": technique,
            "energy_before": round(old_energy, 1),
            "energy_after": round(self.crowd_energy, 1),
            "delta": meta["delta"],
            "style": meta["style"],
            "set_position": round(self.get_set_position(), 3),
        })
        self.transitions_done += 1

    def get_state(self) -> Dict[str, Any]:
        return {
            "crowd_energy": round(self.crowd_energy, 1),
            "target_energy": round(self.get_target_energy(), 1),
            "set_position": round(self.get_set_position(), 3),
            "transitions_done": self.transitions_done,
            "total_tracks": self.total_tracks,
            "arc_template": self.arc_template,
            "preferred_styles": self.get_preferred_styles(),
            "since_last_bomb": self.transitions_done - self.last_bomb_at if self.last_bomb_at >= 0 else -1,
            "energy_direction": "building" if self.crowd_energy < self.get_target_energy() else "cooling",
        }
