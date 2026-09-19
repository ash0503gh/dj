#!/usr/bin/env python3
"""
QA Stress Test: Headless Chrome Screenshot & Layout Verification
Tests the DJ console layout at 1920px, 1440px, and 1280px viewports.
Verifies:
1. Deck 1 and Deck 2 panels are visible and not pushed off-screen
2. Center mixer section is visible between decks
3. No horizontal overflow (all elements fit within viewport width)
4. Pixel analysis measuring exact deck and mixer coordinates and widths
"""

import os
import sys
import time
import json
import zlib
import struct
import shutil
import subprocess

TARGET_SCRATCH = "/Users/ashwinsona/.gemini/antigravity/brain/cf15b0ac-3886-4c27-aede-71280fd50e00/scratch"
LOCAL_SCRATCH = "/Users/ashwinsona/.gemini/antigravity/brain/0ee009a1-9f61-42b2-b04a-22a561ddf648/scratch"
CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SERVER_URL = "http://127.0.0.1:8000"

VIEWPORTS = [
    {"width": 1920, "height": 1080, "name": "stress_test_1920.png"},
    {"width": 1440, "height": 1080, "name": "stress_test_1440.png"},
    {"width": 1280, "height": 1080, "name": "stress_test_1280.png"},
]


def ensure_dirs():
    os.makedirs(TARGET_SCRATCH, exist_ok=True)
    os.makedirs(LOCAL_SCRATCH, exist_ok=True)
    # Also copy this script into the target scratch directory
    target_script = os.path.join(TARGET_SCRATCH, "test_screenshots.py")
    try:
        shutil.copyfile(__file__, target_script)
    except Exception as e:
        print(f"Note copying script: {e}")


def take_screenshot(width: int, height: int, output_path: str):
    """Takes a headless Chrome screenshot of the DJ console at specified dimensions."""
    user_data_dir = f"/tmp/chrome_qa_stress_{width}"
    if os.path.exists(user_data_dir):
        shutil.rmtree(user_data_dir, ignore_errors=True)
    if os.path.exists(output_path):
        os.remove(output_path)

    cmd = [
        CHROME_BIN,
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-extensions",
        f"--screenshot={output_path}",
        f"--window-size={width},{height}",
        f"--user-data-dir={user_data_dir}",
        SERVER_URL,
    ]
    print(f"Executing: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # Monitor for screenshot creation
    start_time = time.time()
    generated = False
    while time.time() - start_time < 15:
        if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
            time.sleep(0.5)  # allow flush
            generated = True
            break
        if proc.poll() is not None:
            break
        time.sleep(0.2)

    # Terminate process cleanly
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

    if not generated and not (os.path.exists(output_path) and os.path.getsize(output_path) > 0):
        stdout, stderr = proc.communicate()
        raise RuntimeError(f"Screenshot failed at {output_path}. Stderr: {stderr.decode('utf-8', errors='ignore')}")

    size_kb = os.path.getsize(output_path) / 1024
    print(f"Successfully saved screenshot to {output_path} ({size_kb:.1f} KB)")


class PNGDecoder:
    """Zero-dependency pure Python PNG decoder."""
    def __init__(self, filepath: str):
        with open(filepath, "rb") as f:
            data = f.read()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("Not a valid PNG file")

        pos = 8
        idat_parts = []
        self.width = 0
        self.height = 0
        self.bit_depth = 0
        self.color_type = 0

        while pos < len(data):
            length = struct.unpack(">I", data[pos:pos + 4])[0]
            pos += 4
            chunk_type = data[pos:pos + 4]
            pos += 4
            chunk_data = data[pos:pos + length]
            pos += length
            pos += 4  # skip crc

            if chunk_type == b"IHDR":
                (self.width, self.height, self.bit_depth,
                 self.color_type, comp, filt, interlace) = struct.unpack(">IIBBBBB", chunk_data)
            elif chunk_type == b"IDAT":
                idat_parts.append(chunk_data)
            elif chunk_type == b"IEND":
                break

        if self.color_type == 6:
            self.bpp = 4  # RGBA
        elif self.color_type == 2:
            self.bpp = 3  # RGB
        else:
            raise ValueError(f"Unsupported PNG color type: {self.color_type}")

        decompressed = zlib.decompress(b"".join(idat_parts))
        stride = self.width * self.bpp
        self.rows = []
        prev_row = bytearray(stride)
        decomp_pos = 0

        for y in range(self.height):
            filter_type = decompressed[decomp_pos]
            decomp_pos += 1
            raw = decompressed[decomp_pos:decomp_pos + stride]
            decomp_pos += stride
            curr = bytearray(stride)

            if filter_type == 0:
                curr[:] = raw
            elif filter_type == 1:  # Sub
                bpp = self.bpp
                for x in range(stride):
                    left = curr[x - bpp] if x >= bpp else 0
                    curr[x] = (raw[x] + left) & 0xff
            elif filter_type == 2:  # Up
                for x in range(stride):
                    curr[x] = (raw[x] + prev_row[x]) & 0xff
            elif filter_type == 3:  # Average
                bpp = self.bpp
                for x in range(stride):
                    left = curr[x - bpp] if x >= bpp else 0
                    curr[x] = (raw[x] + ((left + prev_row[x]) >> 1)) & 0xff
            elif filter_type == 4:  # Paeth
                bpp = self.bpp
                for x in range(stride):
                    left = curr[x - bpp] if x >= bpp else 0
                    up = prev_row[x]
                    up_left = prev_row[x - bpp] if x >= bpp else 0
                    p = left + up - up_left
                    pa = abs(p - left)
                    pb = abs(p - up)
                    pc = abs(p - up_left)
                    if pa <= pb and pa <= pc:
                        pred = left
                    elif pb <= pc:
                        pred = up
                    else:
                        pred = up_left
                    curr[x] = (raw[x] + pred) & 0xff
            else:
                raise ValueError(f"Unknown filter type {filter_type}")

            self.rows.append(curr)
            prev_row = curr

    def get_pixel(self, x: int, y: int):
        if 0 <= x < self.width and 0 <= y < self.height:
            offset = x * self.bpp
            r = self.rows[y][offset]
            g = self.rows[y][offset + 1]
            b = self.rows[y][offset + 2]
            return r, g, b
        return 0, 0, 0


def is_cyan(r, g, b):
    """Deck 1 top accent: #00e5ff (0, 229, 255)"""
    return r < 60 and g > 160 and b > 180


def is_orange(r, g, b):
    """Deck 2 top accent: #ff8c00 (255, 140, 0)"""
    return r > 180 and 60 < g < 180 and b < 60


def analyze_screenshot(png_path: str, expected_width: int):
    """
    Analyzes the screenshot image using pixel inspection to find:
    - Deck 1 panel (marked by cyan border #00e5ff)
    - Deck 2 panel (marked by orange border #ff8c00)
    - Center Mixer (located between Deck 1 and Deck 2)
    - Checks for horizontal overflow and off-screen elements
    """
    decoder = PNGDecoder(png_path)
    w, h = decoder.width, decoder.height
    print(f"Analyzing {os.path.basename(png_path)} ({w}x{h})...")

    # Scan rows below top nav & waveform (y between 150 and 600) to locate Deck 1 cyan border and Deck 2 orange border
    deck1_candidates = {}
    deck2_candidates = {}

    for y in range(150, min(650, h)):
        cyan_xs = []
        orange_xs = []
        for x in range(w):
            r, g, b = decoder.get_pixel(x, y)
            if is_cyan(r, g, b):
                cyan_xs.append(x)
            elif is_orange(r, g, b):
                orange_xs.append(x)

        if len(cyan_xs) > 100:
            deck1_candidates[y] = cyan_xs
        if len(orange_xs) > 100:
            deck2_candidates[y] = orange_xs

    if not deck1_candidates:
        raise ValueError(f"Could not locate Deck 1 cyan top border in {png_path}!")
    if not deck2_candidates:
        raise ValueError(f"Could not locate Deck 2 orange top border in {png_path}!")

    # Find row with most cyan pixels for Deck 1
    best_d1_y = max(deck1_candidates.keys(), key=lambda y: len(deck1_candidates[y]))
    d1_xs = deck1_candidates[best_d1_y]
    d1_left, d1_right = min(d1_xs), max(d1_xs)
    d1_width = d1_right - d1_left + 1

    # Find row with most orange pixels for Deck 2
    best_d2_y = max(deck2_candidates.keys(), key=lambda y: len(deck2_candidates[y]))
    d2_xs = deck2_candidates[best_d2_y]
    d2_left, d2_right = min(d2_xs), max(d2_xs)
    d2_width = d2_right - d2_left + 1

    # Center mixer is between Deck 1 and Deck 2
    mixer_left = d1_right + 1
    mixer_right = d2_left - 1
    mixer_width = mixer_right - mixer_left + 1

    # Verify center mixer content by checking pixels in the center region
    mixer_mid_x = (mixer_left + mixer_right) // 2
    mixer_active_pixels = 0
    for y in range(best_d1_y + 10, min(best_d1_y + 300, h)):
        r, g, b = decoder.get_pixel(mixer_mid_x, y)
        if (r, g, b) != (10, 11, 14) and (r, g, b) != (0, 0, 0):
            mixer_active_pixels += 1

    mixer_verified = (mixer_active_pixels > 30) and (mixer_width > 200)

    # Verification checks
    d1_visible = d1_left >= 0 and d1_right < d2_left and d1_width >= 200
    d2_visible = d2_left > d1_right and d2_right <= w and d2_width >= 200
    no_horizontal_overflow = (d1_left >= 0) and (d2_right <= w) and (d1_right < mixer_left <= mixer_right < d2_left)
    left_margin = d1_left
    right_margin = w - d2_right
    symmetric_margin = abs(left_margin - right_margin) <= 15

    results = {
        "viewport_width": w,
        "viewport_height": h,
        "deck1": {
            "visible": d1_visible,
            "top_y": best_d1_y,
            "left_x": d1_left,
            "right_x": d1_right,
            "width_px": d1_width,
            "status": "PASS" if d1_visible else "FAIL"
        },
        "mixer": {
            "visible": mixer_verified,
            "left_x": mixer_left,
            "right_x": mixer_right,
            "width_px": mixer_width,
            "active_pixel_count": mixer_active_pixels,
            "status": "PASS" if mixer_verified else "FAIL"
        },
        "deck2": {
            "visible": d2_visible,
            "top_y": best_d2_y,
            "left_x": d2_left,
            "right_x": d2_right,
            "width_px": d2_width,
            "status": "PASS" if d2_visible else "FAIL"
        },
        "horizontal_overflow": {
            "has_overflow": not no_horizontal_overflow,
            "left_margin_px": left_margin,
            "right_margin_px": right_margin,
            "symmetric": symmetric_margin,
            "status": "PASS" if no_horizontal_overflow else "FAIL"
        },
        "overall_status": "PASS" if (d1_visible and mixer_verified and d2_visible and no_horizontal_overflow) else "FAIL"
    }

    return results


def main():
    ensure_dirs()
    all_reports = {}

    print("=== DJ Console Multi-Viewport UI QA Stress Test ===")
    print(f"Target URL: {SERVER_URL}")
    print(f"Screenshots Target Directory: {TARGET_SCRATCH}\n")

    for vp in VIEWPORTS:
        width = vp["width"]
        height = vp["height"]
        filename = vp["name"]
        target_path = os.path.join(TARGET_SCRATCH, filename)
        local_path = os.path.join(LOCAL_SCRATCH, filename)

        print(f"--- Testing Viewport {width}x{height} ---")
        try:
            take_screenshot(width, height, target_path)
            shutil.copyfile(target_path, local_path)

            report = analyze_screenshot(target_path, width)
            all_reports[f"{width}px"] = report

            print(f"  Deck 1: [{report['deck1']['left_x']} -> {report['deck1']['right_x']}] width={report['deck1']['width_px']}px ({report['deck1']['status']})")
            print(f"  Mixer : [{report['mixer']['left_x']} -> {report['mixer']['right_x']}] width={report['mixer']['width_px']}px ({report['mixer']['status']})")
            print(f"  Deck 2: [{report['deck2']['left_x']} -> {report['deck2']['right_x']}] width={report['deck2']['width_px']}px ({report['deck2']['status']})")
            print(f"  Overflow Check: {report['horizontal_overflow']['status']} (Left Margin: {report['horizontal_overflow']['left_margin_px']}px, Right Margin: {report['horizontal_overflow']['right_margin_px']}px, Symmetric: {report['horizontal_overflow']['symmetric']})")
            print(f"  => Result for {width}px: {report['overall_status']}\n")
        except Exception as e:
            print(f"  => Error testing {width}px: {e}\n")
            all_reports[f"{width}px"] = {"status": "ERROR", "error": str(e)}

    # Summary Reports in both scratch dirs
    for sdir in [TARGET_SCRATCH, LOCAL_SCRATCH]:
        json_path = os.path.join(sdir, "layout_stress_test_report.json")
        with open(json_path, "w") as f:
            json.dump(all_reports, f, indent=2)

    print(f"Report saved to {os.path.join(TARGET_SCRATCH, 'layout_stress_test_report.json')}")
    print("All viewport tests completed.")


if __name__ == "__main__":
    main()
