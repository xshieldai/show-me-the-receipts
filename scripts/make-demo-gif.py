#!/usr/bin/env python3
"""Draw docs/demo.gif from a REAL run of the tool on examples/demo-session.jsonl.

The tool's output is captured from the code in this repository (colour on), never retyped.
The agent's message shown first is the final message stored in the demo session itself.
Needs Python 3 with Pillow, Node 18+, and the DejaVu Sans Mono and Noto Color Emoji fonts.

    python3 scripts/make-demo-gif.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SESSION = "examples/demo-session.jsonl"
OUT = ROOT / "docs" / "demo.gif"

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"   # has the glyphs DejaVu Sans Mono lacks
NOT_IN_MONO = set("⟳")

SIZE = 17
CW, LH = 10, 24            # cell width, line height (DejaVu Sans Mono at 17px is 10px wide)
COLS, ROWS = 108, 25
PAD = 22
BAR = 34                   # window title bar
W, H = PAD * 2 + COLS * CW, BAR + PAD * 2 + ROWS * LH

BG = (24, 26, 33)
FG = (220, 223, 228)
DIM = (128, 134, 148)
PROMPT = (110, 180, 255)
ANSI = {"32": (120, 210, 120), "31": (240, 100, 100), "33": (235, 195, 90), "35": (200, 140, 230)}

font = ImageFont.truetype(MONO, SIZE)
bold = ImageFont.truetype(MONO_BOLD, SIZE)
emoji_font = ImageFont.truetype(EMOJI, 109)
sans = ImageFont.truetype(SANS, SIZE)
_emoji_cache = {}


def emoji(ch):
    if ch not in _emoji_cache:
        im = Image.new("RGBA", (136, 128), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((0, 0), ch, font=emoji_font, embedded_color=True)
        im = im.crop(im.getbbox()).resize((19, 19), Image.LANCZOS)
        _emoji_cache[ch] = im
    return _emoji_cache[ch]


def is_emoji(ch):
    return ord(ch) >= 0x1F300


def real_output():
    js = (
        "import('./src/index.js').then(m => {"
        f"const r = m.grade({json.dumps(SESSION)}, {{ repo: null }});"
        "process.stdout.write(m.render(r, { color: true }));"
        "process.stdout.write('\\n__EXIT__' + m.exitCodeFor(r.results));"
        "})"
    )
    out = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    text, code = out.rsplit("\n__EXIT__", 1)
    return text, int(code)


def agent_message():
    last = None
    for line in (ROOT / SESSION).read_text().splitlines():
        rec = json.loads(line)
        for block in (rec.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                last = block["text"]
    return last


def parse_ansi(line):
    """Split one line into (text, colour, bold) runs."""
    runs, colour, is_bold, pos = [], FG, False, 0
    for m in re.finditer(r"\x1b\[(\d+)m", line):
        if m.start() > pos:
            runs.append((line[pos:m.start()], colour, is_bold))
        code = m.group(1)
        if code == "0":
            colour, is_bold = FG, False
        elif code == "1":
            is_bold = True
        elif code == "2":
            colour = DIM
        elif code in ANSI:
            colour = ANSI[code]
        pos = m.end()
    if pos < len(line):
        runs.append((line[pos:], colour, is_bold))
    return runs


def draw_frame(lines, caption):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, BAR], fill=(36, 39, 48))
    for i, c in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 84)]):
        d.ellipse([16 + i * 22, 11, 28 + i * 22, 23], fill=c)
    d.text((W // 2, BAR // 2), caption, font=font, fill=DIM, anchor="mm")
    y = BAR + PAD
    for runs in lines:
        x = PAD
        for text, colour, is_bold in runs:
            for ch in text:
                if is_emoji(ch):
                    im.paste(emoji(ch), (x, y + 1), emoji(ch))
                    x += CW * 2
                elif ch in NOT_IN_MONO:
                    d.text((x, y), ch, font=sans, fill=colour)
                    x += CW
                else:
                    d.text((x, y), ch, font=bold if is_bold else font, fill=colour)
                    x += CW
        y += LH
    return im


def main():
    output, code = real_output()
    if code != 1:
        sys.exit(f"the demo session should grade exit 1, got {code}; not drawing a GIF that would show something else")

    caption = "demo session · examples/demo-session.jsonl"
    frames, durations = [], []

    def add(lines, ms):
        frames.append(draw_frame(lines, caption))
        durations.append(ms)

    # 1. The agent's final message, as stored in the demo session.
    msg = ["The agent says:", ""] + ["  " + l for l in agent_message().splitlines()]
    screen = []
    for l in msg:
        screen.append([(l, DIM if l == "The agent says:" else FG, False)])
        add(list(screen), 140)
    add(list(screen), 2600)

    # 2. The command, typed.
    cmd = f"npx show-me-the-receipts {SESSION}"
    screen.append([("", FG, False)])
    for i in range(0, len(cmd) + 1, 3):
        add(screen + [[("$ ", PROMPT, True), (cmd[:i], FG, False)]], 45)
    screen.append([("$ ", PROMPT, True), (cmd, FG, False)])
    add(list(screen), 500)

    # 3. The real output, scrolled into view line by line.
    for l in output.splitlines():
        screen.append(parse_ansi(l))
        add(screen[-ROWS:], 260 if l.strip() else 80)
    add(screen[-ROWS:], 5500)

    OUT.parent.mkdir(exist_ok=True)
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=64) for f in frames]
    pal[0].save(OUT, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{OUT.relative_to(ROOT)}: {len(frames)} frames, {OUT.stat().st_size // 1024} KB, {W}x{H}")


if __name__ == "__main__":
    main()
