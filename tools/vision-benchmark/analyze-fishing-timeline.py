from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import cv2
import numpy as np


def load_image(path: Path) -> np.ndarray:
    image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise RuntimeError(f"cannot read image {path}")
    return image


def scaled_template(path: Path, scale: float, mirror: bool = False) -> tuple[np.ndarray, np.ndarray]:
    image = load_image(path)
    image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    if mirror:
        image = cv2.flip(image, 1)
    if image.shape[2] == 4:
        return image[:, :, :3], image[:, :, 3]
    return image, np.full(image.shape[:2], 255, np.uint8)


def match_in_region(frame: np.ndarray, template: np.ndarray, mask: np.ndarray,
                    region: tuple[int, int, int, int]) -> tuple[float, float, float]:
    x, y, width, height = region
    scene = frame[y:y + height, x:x + width]
    result = cv2.matchTemplate(scene, template, cv2.TM_CCORR_NORMED, mask=mask)
    result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)
    _, score, _, point = cv2.minMaxLoc(result)
    return float(score), float(x + point[0]), float(y + point[1])


def interpolate_crossing(a: dict[str, float], b: dict[str, float], target_x: float) -> float | None:
    ax, bx = a["center_x"], b["center_x"]
    if ax == bx or (ax - target_x) * (bx - target_x) > 0:
        return None
    fraction = (target_x - ax) / (bx - ax)
    if fraction < 0.0 or fraction > 1.0:
        return None
    return a["elapsed"] + fraction * (b["elapsed"] - a["elapsed"])


def analyze_motion(video: Path, assets: Path, output: Path, start: float, end: float,
                   fish_scale: float, fish_region: tuple[int, int, int, int],
                   pull_region: tuple[int, int, int, int], hook_region: tuple[int, int, int, int]) -> None:
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"cannot open {video}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = count / fps
    start_frame = max(0, round(start * fps))
    end_frame = min(count - 1, round(min(end, duration) * fps))

    pull_template, pull_mask = scaled_template(assets / "拉杆.png", 1.0)
    hook_template, hook_mask = scaled_template(assets / "鱼钩-二次扣图.png", fish_scale)
    fish_templates = [
        scaled_template(assets / "鱼-二次扣图.png", fish_scale),
        scaled_template(assets / "鱼-二次扣图.png", fish_scale, mirror=True),
    ]

    # t0 is the first rendered frame containing the pull UI, not the beginning of the recording.
    t0_frame: int | None = None
    t0_score = 0.0
    capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    for frame_index in range(start_frame, end_frame + 1):
        ok, frame = capture.read()
        if not ok:
            continue
        score, _, _ = match_in_region(frame, pull_template, pull_mask, pull_region)
        if score >= 0.95:
            t0_frame = frame_index
            t0_score = score
            break
    if t0_frame is None:
        raise RuntimeError("pull UI transition was not found")

    capture.set(cv2.CAP_PROP_POS_FRAMES, t0_frame)
    ok, t0_image = capture.read()
    if not ok:
        raise RuntimeError("cannot decode t0 frame")
    hook_score, hook_left, hook_top = match_in_region(t0_image, hook_template, hook_mask, hook_region)
    hook_x = hook_left + hook_template.shape[1] / 2.0

    rows: list[dict[str, float]] = []
    last_center: float | None = None
    capture.set(cv2.CAP_PROP_POS_FRAMES, t0_frame)
    for frame_index in range(t0_frame, end_frame + 1):
        ok, frame = capture.read()
        if not ok:
            continue
        candidates = []
        for direction, (template, mask) in enumerate(fish_templates):
            score, left, top = match_in_region(frame, template, mask, fish_region)
            center_x = left + template.shape[1] / 2.0
            center_y = top + template.shape[0] / 2.0
            continuity = 0.0 if last_center is None else abs(center_x - last_center)
            # Offline tracking favors the nearest plausible candidate when scores are close.
            rank = score - min(continuity, 80.0) * 0.0015
            candidates.append((rank, score, center_x, center_y, direction, template.shape[1]))
        _, score, center_x, center_y, direction, width = max(candidates)
        if score < 0.82:
            continue
        elapsed = (frame_index - t0_frame) / fps
        rows.append({
            "frame": float(frame_index), "video_time": frame_index / fps, "elapsed": elapsed,
            "center_x": center_x, "center_y": center_y, "score": score,
            "direction_template": float(direction), "width": float(width),
        })
        last_center = center_x
    capture.release()
    if len(rows) < 10:
        raise RuntimeError(f"too few fish samples: {len(rows)}")

    # A 3-frame median suppresses isolated one-frame template jumps without shifting constant-speed crossings.
    xs = np.array([row["center_x"] for row in rows])
    if len(xs) >= 3:
        smoothed = xs.copy()
        for index in range(1, len(xs) - 1):
            smoothed[index] = np.median(xs[index - 1:index + 2])
        for row, center_x in zip(rows, smoothed):
            row["center_x"] = float(center_x)

    rough_crossings: list[tuple[float, str, float]] = []
    for previous, current in zip(rows, rows[1:]):
        if current["elapsed"] - previous["elapsed"] > 0.1:
            continue
        center_time = interpolate_crossing(previous, current, hook_x)
        if center_time is None:
            continue
        direction = "R" if current["center_x"] > previous["center_x"] else "L"
        if rough_crossings and center_time - rough_crossings[-1][0] < 0.25:
            continue
        rough_crossings.append((center_time, direction,
                                abs(current["center_x"] - previous["center_x"])))

    # Fit a straight line through roughly 0.5 seconds around every crossing. The fish moves at
    # constant speed there, so this averages out sprite animation and one-pixel template jitter.
    crossings: list[dict[str, float | str]] = []
    half_width = float(np.median([row["width"] for row in rows])) / 2.0
    discarded_crossings = 0
    for rough_time, direction, crossing_step in rough_crossings:
        nearby = [row for row in rows
                  if abs(row["elapsed"] - rough_time) <= 0.25
                  and abs(row["center_x"] - hook_x) <= 70]
        if len(nearby) < 8:
            continue
        times = np.array([row["elapsed"] for row in nearby])
        positions = np.array([row["center_x"] for row in nearby])
        velocity, intercept = np.polyfit(times, positions, 1)
        expected_sign = 1 if direction == "R" else -1
        if velocity * expected_sign <= 20:
            discarded_crossings += 1
            continue
        predicted = velocity * times + intercept
        position_rmse = float(np.sqrt(np.mean((positions - predicted) ** 2)))
        center_time = float((hook_x - intercept) / velocity)
        boundary_times = [float((hook_x - half_width - intercept) / velocity),
                          float((hook_x + half_width - intercept) / velocity)]
        # 成年鱼约为幼年鱼两倍速度；这里的上限只用于排除模板跳点，
        # 不能把成年鱼的真实横向运动（约 120~160 px/s）过滤掉。
        if abs(velocity) < 45 or abs(velocity) > 200 or position_rmse > 3.0:
            # A click can freeze the fish on the crossing itself, spoiling the wider regression
            # window. Preserve that adjacent-frame crossing only when it was a small continuous
            # movement; reject large post-transition template jumps.
            if crossing_step <= 5.0:
                crossings.append({
                    "center_s": rough_time, "direction": direction,
                    "entry_s": rough_time, "exit_s": rough_time,
                    "velocity_px_s": float(velocity),
                    "position_rmse_px": position_rmse,
                    "method": "adjacent-at-freeze",
                })
            else:
                discarded_crossings += 1
            continue
        crossings.append({
            "center_s": center_time,
            "direction": direction,
            "entry_s": min(boundary_times),
            "exit_s": max(boundary_times),
            "velocity_px_s": float(velocity),
            "position_rmse_px": position_rmse,
            "method": "local-linear-fit",
        })

    # Estimate the full period independently by direction; median resists an occasional missed crossing.
    periods = []
    for direction in ("L", "R"):
        times = [float(item["center_s"]) for item in crossings if item["direction"] == direction]
        periods.extend(b - a for a, b in zip(times, times[1:]) if b - a > 0.5)
    period = float(np.median(periods)) if periods else None
    fitted_schedule = None
    if period is not None:
        design_rows = []
        observed_times = []
        direction_indices = {"R": 0, "L": 0}
        for item in crossings:
            direction = str(item["direction"])
            cycle = direction_indices[direction]
            direction_indices[direction] += 1
            design_rows.append([cycle, 1.0 if direction == "R" else 0.0,
                                1.0 if direction == "L" else 0.0])
            observed_times.append(float(item["center_s"]))
        coefficients, _, _, _ = np.linalg.lstsq(np.array(design_rows), np.array(observed_times), rcond=None)
        fitted_period, phase_r, phase_l = map(float, coefficients)
        residuals = np.array(observed_times) - np.array(design_rows) @ coefficients
        fitted_schedule = {
            "period_s": fitted_period,
            "phase_R_s": phase_r,
            "phase_L_s": phase_l,
            "residual_rmse_ms": float(np.sqrt(np.mean(residuals ** 2)) * 1000.0),
            "residual_max_ms": float(np.max(np.abs(residuals)) * 1000.0),
        }

    output.mkdir(parents=True, exist_ok=True)
    stem = video.stem
    with (output / f"{stem}-track.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    report = {
        "video": str(video), "fps": fps, "duration_s": duration,
        "t0_frame": t0_frame, "t0_video_s": t0_frame / fps, "t0_pull_score": t0_score,
        "hook_x": hook_x, "hook_y": hook_top + hook_template.shape[0] / 2.0,
        "hook_score": hook_score, "samples": len(rows), "period_s": period,
        "fitted_schedule": fitted_schedule, "discarded_crossings": discarded_crossings,
        "crossings": crossings,
    }
    report_path = output / f"{stem}-timeline.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"report={report_path}")


def read_frame(capture: cv2.VideoCapture, timestamp: float) -> np.ndarray:
    capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
    ok, frame = capture.read()
    if not ok:
        raise RuntimeError(f"cannot decode frame at {timestamp:.3f}s")
    return frame


def save_image(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(path.suffix, image)
    if not ok:
        raise RuntimeError(f"cannot encode {path}")
    encoded.tofile(path)


def make_contact_sheet(video: Path, output: Path, start: float, end: float, step: float,
                       crop: tuple[int, int, int, int] | None) -> None:
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"cannot open {video}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = count / fps
    timestamps = np.arange(max(0.0, start), min(end, duration) + 0.001, step)
    tiles: list[np.ndarray] = []
    for timestamp in timestamps:
        frame = read_frame(capture, float(timestamp))
        if crop is not None:
            x, y, width, height = crop
            frame = frame[y:y + height, x:x + width]
        scale = 480.0 / frame.shape[1]
        tile = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        cv2.rectangle(tile, (0, 0), (132, 28), (0, 0, 0), -1)
        cv2.putText(tile, f"{timestamp:06.2f}s", (7, 20), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (0, 255, 255), 1, cv2.LINE_AA)
        tiles.append(tile)
    capture.release()
    columns = 4
    tile_height, tile_width = tiles[0].shape[:2]
    rows: list[np.ndarray] = []
    for offset in range(0, len(tiles), columns):
        row = tiles[offset:offset + columns]
        while len(row) < columns:
            row.append(np.zeros((tile_height, tile_width, 3), np.uint8))
        rows.append(np.hstack(row))
    save_image(output, np.vstack(rows))
    print(f"video={video}")
    print(f"fps={fps:.6f} frames={count} duration={duration:.3f}s")
    print(f"contact_sheet={output}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create timestamped fishing-video diagnostics.")
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=45.0)
    parser.add_argument("--step", type=float, default=5.0)
    parser.add_argument("--crop", type=int, nargs=4, metavar=("X", "Y", "WIDTH", "HEIGHT"))
    parser.add_argument("--analyze-motion", action="store_true")
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--fish-scale", type=float, default=1.5)
    parser.add_argument("--fish-region", type=int, nargs=4, default=(650, 500, 500, 120))
    parser.add_argument("--pull-region", type=int, nargs=4, default=(850, 450, 200, 150))
    parser.add_argument("--hook-region", type=int, nargs=4, default=(760, 400, 180, 140))
    args = parser.parse_args()
    if args.analyze_motion:
        if args.assets is None:
            parser.error("--assets is required with --analyze-motion")
        analyze_motion(args.video, args.assets, args.output, args.start, args.end,
                       args.fish_scale, tuple(args.fish_region), tuple(args.pull_region),
                       tuple(args.hook_region))
    else:
        make_contact_sheet(args.video, args.output, args.start, args.end, args.step,
                           tuple(args.crop) if args.crop else None)


if __name__ == "__main__":
    main()
