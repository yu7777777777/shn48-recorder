"""Local cover scoring and typesetting. No images leave this process."""
import json
import math
import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter

cv2.setNumThreads(1)
Image.MAX_IMAGE_PIXELS = 40_000_000
MODEL = str(Path(__file__).parents[2] / "assets" / "cover-models" / "yunet.onnx")
with tempfile.TemporaryDirectory(prefix="cover-model-") as model_dir:
    # OpenCV's native Windows loader does not accept Unicode filenames.
    model_path = str(Path(model_dir) / "yunet.onnx")
    Path(model_path).write_bytes(Path(MODEL).read_bytes())
    detector = cv2.FaceDetectorYN.create(model_path, "", (320, 320), 0.8, 0.3, 5000)


def face_of(image):
    rgb = np.array(image.convert("RGB"))
    h, w = rgb.shape[:2]
    factor = min(1, 640 / max(h, w))
    bgr = cv2.cvtColor(cv2.resize(rgb, (max(1, round(w * factor)), max(1, round(h * factor)))), cv2.COLOR_RGB2BGR)
    detector.setInputSize((bgr.shape[1], bgr.shape[0]))
    _, faces = detector.detect(bgr)
    if faces is None:
        return None
    face = max(faces, key=lambda f: f[2] * f[3] * f[-1])
    return [float(v / factor) for v in face[:4]] + [float(face[-1])]


def score(image, source, expected_face):
    image.thumbnail((640, 640))
    gray = np.array(image.convert("L"))
    brightness, contrast = float(gray.mean()), float(gray.std())
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    face = face_of(image)
    good = image.width >= 100 and image.height >= 100 and 22 < brightness < 239 and contrast > 12 and sharpness > 5
    reason = "清晰画面"
    if not good:
        reason = "画面过暗、过亮、模糊或内容不足"
    if source == "smart" and expected_face and not face:
        good, reason = False, "未检测到清晰人脸，可能是等待画面或遮挡"
    focus = sharpness
    if face:
        x, y, w, h, confidence = face
        roi = gray[max(0, int(y)):min(gray.shape[0], int(y + h)), max(0, int(x)):min(gray.shape[1], int(x + w))]
        if roi.size:
            focus = float(cv2.Laplacian(roi, cv2.CV_64F).var())
        if source == "smart" and (focus < 9 or w * h / gray.size < 0.015):
            good, reason = False, "人物过小或人脸模糊"
        elif good:
            reason = "人脸清晰"
    value = min(35, math.log1p(focus) * 6) + max(0, 15 - abs(brightness - 125) / 8) + min(15, contrast / 3)
    if face:
        value += 35 * face[-1]
    small = np.array(image.resize((9, 8)).convert("L"))
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    dhash = sum(int(bit) << i for i, bit in enumerate(bits))
    return dict(acceptable=bool(good), score=round(value, 2), reason=reason, face=face, hash=str(dhash))


def font(size):
    choices = [os.environ.get("COVER_FONT", ""), "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "C:/Windows/Fonts/msyh.ttc"]
    for filename in choices:
        if filename and Path(filename).is_file():
            return ImageFont.truetype(filename, size)
    raise RuntimeError("封面中文字体缺失，请安装 Noto Sans CJK 或设置 COVER_FONT")


def wrap(draw, text, typeface, width, max_lines):
    lines, line = [], ""
    for char in str(text).replace("\n", " "):
        if draw.textlength(line + char, font=typeface) > width and line:
            lines.append(line)
            line = char
        else:
            line += char
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while lines[-1] and draw.textlength(lines[-1] + "…", font=typeface) > width:
            lines[-1] = lines[-1][:-1]
        lines[-1] += "…"
    return lines


def open_image(filename):
    with Image.open(filename) as raw:
        raw.seek(0)
        return ImageOps.exif_transpose(raw).convert("RGB")


def render(job):
    image = open_image(job["input"]) if job.get("input") else None
    if image is not None:
        canvas = ImageOps.fit(image, (960, 540), method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(32))
        canvas = Image.blend(canvas, Image.new("RGB", canvas.size, "#000000"), 0.16)
        picture = ImageOps.contain(image, (960, 540), method=Image.Resampling.LANCZOS)
        canvas.paste(picture, ((960 - picture.width) // 2, (540 - picture.height) // 2))
    elif job["style"] == "plain":
        raise RuntimeError("图片不存在")
    else:
        # Audio-only/missing-photo fallback stays neutral and centered.
        canvas = Image.new("RGB", (960, 540), "#252528")
        draw = ImageDraw.Draw(canvas)
        name_font = font(52)
        names = wrap(draw, job.get("memberName") or "直播录像", name_font, 840, 2)
        for i, line in enumerate(names):
            draw.text((480, 230 + (i - (len(names) - 1) / 2) * 70), line, font=name_font, fill="#f7f7f8", anchor="mm")
        draw.text((480, 330), "直播存档", font=font(24), fill="#bcbcc2", anchor="mm")
    canvas.save(job["output"], "JPEG", quality=91, optimize=True)
    return {"output": job["output"]}


def main(job):
    if job["mode"] == "analyze":
        result = []
        for item in job["images"]:
            image = open_image(item["file"])
            result.append({**item, **score(image, item["source"], job.get("expectedFace", False))})
        return result
    return render(job)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        print(json.dumps(main(job), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
