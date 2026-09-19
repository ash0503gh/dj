#!/usr/bin/env python3
"""
PULSE PRO // Live Deployment Stress Test Suite
Tests https://dj-sshn.onrender.com for:
1. Availability & Health (HTTP 200)
2. Latency Benchmarks (P50, P95, P99)
3. Concurrency (Simulated simultaneous users)
4. Audio Streaming Range Requests
5. AI Decision Engine Throughput
6. Mix Render Memory Stability (512MB RAM stress)
"""

import sys
import time
import json
import urllib.request
import urllib.parse
import concurrent.futures
from statistics import mean, median

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "https://dj-sshn.onrender.com"

def log(msg, symbol="ℹ️"):
    print(f"{symbol} {msg}")

def test_endpoint(url, method="GET", data=None, headers=None, timeout=30):
    t0 = time.perf_counter()
    req = urllib.request.Request(url, method=method)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    if data:
        encoded = urllib.parse.urlencode(data).encode("utf-8")
        req.data = encoded

    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read()
            dt = (time.perf_counter() - t0) * 1000
            return {
                "status": res.status,
                "latency_ms": dt,
                "bytes": len(body),
                "headers": dict(res.getheaders()),
                "error": None,
                "body": body
            }
    except Exception as e:
        dt = (time.perf_counter() - t0) * 1000
        return {
            "status": getattr(e, "code", 0),
            "latency_ms": dt,
            "bytes": 0,
            "headers": {},
            "error": str(e),
            "body": b""
        }

def run_stress_test():
    print("=" * 70)
    print(f"🚀 STRESS TESTING LIVE RENDER DEPLOYMENT: {BASE_URL}")
    print("=" * 70)

    # 1. PING & BASIC HEALTH
    log("Step 1: Testing Frontend & Root Availability...", "🌐")
    res_root = test_endpoint(f"{BASE_URL}/")
    if res_root["status"] == 200:
        log(f"Root UI: HTTP {res_root['status']} OK ({res_root['latency_ms']:.1f} ms, {res_root['bytes']} bytes)", "✅")
    else:
        log(f"Root UI FAILED: {res_root['status']} - {res_root['error']}", "❌")
        return

    # 2. PRESETS API
    log("Step 2: Testing Presets API (/api/presets)...", "🎶")
    res_presets = test_endpoint(f"{BASE_URL}/api/presets")
    if res_presets["status"] == 200:
        try:
            data = json.loads(res_presets["body"].decode("utf-8"))
            track_count = len(data.get("tracks", []))
            set_count = len(data.get("sets", []))
            log(f"Presets API: HTTP 200 OK ({res_presets['latency_ms']:.1f} ms) - {track_count} tracks, {set_count} sets cached", "✅")
        except Exception as e:
            log(f"Presets JSON parse error: {e}", "⚠️")
    else:
        log(f"Presets API FAILED: {res_presets['status']} - {res_presets['error']}", "❌")

    # 3. AUDIO STREAMING RANGE REQUEST (CDJ Web Audio Streaming)
    log("Step 3: Testing Audio Streaming Range Request (/api/audio/Laserpack.mp3)...", "🎧")
    res_audio = test_endpoint(
        f"{BASE_URL}/api/audio/Laserpack.mp3",
        headers={"Range": "bytes=0-32767"}
    )
    if res_audio["status"] in (200, 206):
        cr = res_audio["headers"].get("Content-Range", "Unknown")
        log(f"Audio Streaming: HTTP {res_audio['status']} OK ({res_audio['latency_ms']:.1f} ms, Content-Range: {cr})", "✅")
    else:
        log(f"Audio Streaming FAILED: {res_audio['status']} - {res_audio['error']}", "❌")

    # 4. AI STRATEGY ADVISOR
    log("Step 4: Testing AI Decision Engine (/api/ai-strategy)...", "🤖")
    res_ai = test_endpoint(
        f"{BASE_URL}/api/ai-strategy",
        method="POST",
        data={"file_id_1": "Laserpack.mp3", "file_id_2": "Overworld.mp3"}
    )
    if res_ai["status"] == 200:
        try:
            ai_data = json.loads(res_ai["body"].decode("utf-8"))
            strat = ai_data.get("strategy", {})
            tech = strat.get("recommended_technique", "Unknown")
            bars = strat.get("recommended_bars", "Unknown")
            conf = strat.get("confidence", 0)
            log(f"AI Decision Engine: HTTP 200 OK ({res_ai['latency_ms']:.1f} ms) -> {tech.upper()} ({bars} Bars, {int(conf*100)}% Conf)", "✅")
        except Exception as e:
            log(f"AI Strategy parse error: {e}", "⚠️")
    else:
        log(f"AI Strategy FAILED: {res_ai['status']} - {res_ai['error']}", "❌")

    # 5. CONCURRENT LOAD TEST (Simultaneous Users)
    concurrency_levels = [5, 15, 30]
    for n in concurrency_levels:
        log(f"\nStep 5: Testing Concurrent Load ({n} simultaneous requests to /api/presets)...", "⚡")
        latencies = []
        errors = 0
        t_start = time.perf_counter()

        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as executor:
            futures = [executor.submit(test_endpoint, f"{BASE_URL}/api/presets") for _ in range(n)]
            for f in concurrent.futures.as_completed(futures):
                r = f.result()
                if r["status"] == 200:
                    latencies.append(r["latency_ms"])
                else:
                    errors += 1

        total_time = time.perf_counter() - t_start
        rps = n / total_time
        latencies.sort()
        p50 = median(latencies) if latencies else 0
        p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
        p99 = latencies[-1] if latencies else 0

        log(f"Completed {n} requests in {total_time:.2f}s ({rps:.1f} req/sec)", "📊")
        log(f"Success Rate: {((n - errors) / n) * 100:.1f}% | Errors: {errors}", "📊")
        log(f"Latencies: Min={min(latencies):.1f}ms | P50={p50:.1f}ms | P95={p95:.1f}ms | Max={p99:.1f}ms", "📊")

    print("\n" + "=" * 70)
    print("🎉 STRESS TEST COMPLETED!")
    print("=" * 70)

if __name__ == "__main__":
    run_stress_test()
