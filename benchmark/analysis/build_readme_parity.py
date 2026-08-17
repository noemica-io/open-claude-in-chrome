#!/usr/bin/env python3
"""README variant of the scalar-space plot: the official extension vs this one.

Deliberately makes two claims at once, because only one of them is "we are
faster" and the honest version needs both:

  1. PARITY. 1a (official Claude in Chrome) and 1c (this harness, cold) are
     statistically indistinguishable - ringed together, with the p-values on
     the chart. Nobody has to take "it's just as good" on faith.
  2. CEILING. 1a -> 6b, the best method in the study, is a long arrow into the
     better quadrant. That gain is what the open harness makes available, not
     something the baseline comparison shows.

Same axes and conventions as the writeup's scalar-space charts (x = mean
num_turns per task, y = suite total minutes, lower-left is better), trimmed for
a README: fewer arms, larger type, no legend sprawl. The other 11 arms stay as
faded context so the two highlighted points read against the full study.

Writes an inline-SVG HTML page to readme_parity.html; render that page in a
headless browser to produce docs/img/parity.png (the PNG is committed in the
repo and is what README.md embeds).
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
REPO = os.path.dirname(BENCH)
D = json.load(open(os.path.join(HERE, "capstone.json")))

RENAME = {"CinC": "1a", "OCIC-Ch": "1b", "OCIC-Br": "1c", "2A": "2a", "2B": "2b",
          "3D": "3a", "3C": "3b", "4A": "4a", "4B": "4b", "5B": "5a", "5A": "5b",
          "5C": "6a", "5D": "6b"}
COLOR = {RENAME[k]: v for k, v in D["dist_byleg"]["color"].items()}
ARMS = [{"short": RENAME[a["short"]], "turns": a["turns"], "min": a["min"]}
        for a in D["rankcompare"]["arms"]]
BY = {a["short"]: a for a in ARMS}

W, H = 1000, 560
PL, PR, PT, PB = 78, 44, 92, 68
XMIN, XMAX = 22, 42
YMIN, YMAX = 17, 30          # 4a/4b sit far above this; they are not the story here
def X(v): return PL + (W - PL - PR) * (v - XMIN) / (XMAX - XMIN)
def Y(v): return PT + (H - PT - PB) * (YMAX - v) / (YMAX - YMIN)

GOOD = "#0f8a5f"
CINC, OPEN = "#8a6d3b", "#1d6fa5"


def star(cx, cy, ro, ri, n=5):
    pts = []
    for i in range(n * 2):
        r = ro if i % 2 == 0 else ri
        a = -math.pi / 2 + i * math.pi / n
        pts.append(f"{cx + r*math.cos(a):.2f},{cy + r*math.sin(a):.2f}")
    return "M" + "L".join(pts) + "Z"


def arrow(x0, y0, x1, y1, color, width=3.4):
    ang = math.atan2(y1 - y0, x1 - x0); ah = 10
    a1, a2 = ang + math.radians(150), ang - math.radians(150)
    return (f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="{color}" '
            f'stroke-width="{width}" stroke-linecap="round"/>'
            f'<path d="M{x1:.1f} {y1:.1f} L{x1+ah*math.cos(a1):.1f} {y1+ah*math.sin(a1):.1f} '
            f'M{x1:.1f} {y1:.1f} L{x1+ah*math.cos(a2):.1f} {y1+ah*math.sin(a2):.1f}" '
            f'stroke="{color}" stroke-width="{width}" stroke-linecap="round" fill="none"/>')


s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
     f'font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif">']
s.append(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')

a1, c1, b6 = BY["1a"], BY["1c"], BY["6b"]
# better-quadrant wash, anchored on the official extension
s.append(f'<rect x="{PL}" y="{Y(a1["min"]):.1f}" width="{X(a1["turns"])-PL:.1f}" '
         f'height="{H-PB-Y(a1["min"]):.1f}" fill="{GOOD}" fill-opacity="0.06"/>')

for g in range(25, XMAX + 1, 5):
    s.append(f'<line x1="{X(g):.1f}" y1="{PT}" x2="{X(g):.1f}" y2="{H-PB}" stroke="#f1f0ec"/>')
    s.append(f'<text x="{X(g):.1f}" y="{H-PB+19}" text-anchor="middle" font-size="11.5" fill="#8a929c">{g}</text>')
for g in range(18, YMAX + 1, 3):
    s.append(f'<line x1="{PL}" y1="{Y(g):.1f}" x2="{W-PR}" y2="{Y(g):.1f}" stroke="#f6f5f1"/>')
    s.append(f'<text x="{PL-9}" y="{Y(g)+4:.1f}" text-anchor="end" font-size="11.5" fill="#8a929c">{g}m</text>')

# the rest of the study, faded, for context
for a in ARMS:
    if a["short"] in ("1a", "1c", "6b") or a["min"] > YMAX:
        continue
    s.append(f'<circle cx="{X(a["turns"]):.1f}" cy="{Y(a["min"]):.1f}" r="4.5" '
             f'fill="{COLOR[a["short"]]}" opacity="0.24"/>')

# claim 2: the ceiling. drawn first so the dots sit on top of it
s.append(arrow(X(a1["turns"]) - 12, Y(a1["min"]) + 10, X(b6["turns"]) + 13, Y(b6["min"]) - 11, GOOD))
mx, my = (X(a1["turns"]) + X(b6["turns"])) / 2, (Y(a1["min"]) + Y(b6["min"])) / 2
s.append(f'<text x="{mx-10:.1f}" y="{my-15:.1f}" text-anchor="end" font-size="14.5" font-weight="800" '
         f'fill="{GOOD}">&#8722;23% turns, &#8722;15% time</text>')
s.append(f'<text x="{mx-10:.1f}" y="{my+2:.1f}" text-anchor="end" font-size="11.5" fill="#5b6571">'
         f'with the study\'s best method</text>')

# claim 1: parity, ringed
cx, cy = (X(a1["turns"]) + X(c1["turns"])) / 2, (Y(a1["min"]) + Y(c1["min"])) / 2
rx = abs(X(c1["turns"]) - X(a1["turns"])) / 2 + 34
ry = abs(Y(c1["min"]) - Y(a1["min"])) / 2 + 27
s.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{rx:.1f}" ry="{ry:.1f}" fill="#3f6ea8" '
         f'fill-opacity="0.05" stroke="#3f6ea8" stroke-width="1.4" stroke-dasharray="6 4"/>')
s.append(f'<text x="{cx:.1f}" y="{cy-ry-20:.1f}" text-anchor="middle" font-size="13" font-weight="700" '
         f'fill="#3f6ea8">statistically indistinguishable</text>')
s.append(f'<text x="{cx:.1f}" y="{cy-ry-5:.1f}" text-anchor="middle" font-size="11" fill="#5b6571">'
         f'p=0.44 latency, p=0.67 turns &#183; same accuracy</text>')

for sh, col, lbl, dx, dy, anc in (("1a", CINC, "official Claude in Chrome", 13, 5, "start"),
                                  ("1c", OPEN, "this harness, cold", 13, 16, "start")):
    a = BY[sh]
    px, py = X(a["turns"]), Y(a["min"])
    s.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="8" fill="{col}" stroke="#fff" stroke-width="2"/>')
    s.append(f'<text x="{px+dx:.1f}" y="{py+dy:.1f}" text-anchor="{anc}" font-size="12.5" '
             f'font-weight="700" fill="{col}">{lbl}</text>')

px, py = X(b6["turns"]), Y(b6["min"])
s.append(f'<path d="{star(px, py, 14, 5.8)}" fill="{OPEN}" stroke="#0d4f78" stroke-width="1.6"/>')
s.append(f'<text x="{px:.1f}" y="{py+30:.1f}" text-anchor="middle" font-size="12.5" font-weight="700" '
         f'fill="{OPEN}">this harness, best method</text>')

s.append(f'<text x="{(PL+W-PR)/2:.1f}" y="{H-20}" text-anchor="middle" font-size="12.5" fill="#5b6571">'
         f'turns per task &#8594; more</text>')
s.append(f'<text x="22" y="{(PT+H-PB)/2:.1f}" text-anchor="middle" font-size="12.5" fill="#5b6571" '
         f'transform="rotate(-90 22 {(PT+H-PB)/2:.1f})">time for the 12-task suite &#8594; slower</text>')
s.append(f'<text x="{PL}" y="36" font-size="19" font-weight="700" fill="#1b1f24">'
         f'Same performance out of the box. A much higher ceiling.</text>')
s.append(f'<text x="{PL}" y="57" font-size="12.5" fill="#8a929c">'
         f'13 arms &#183; 12 held-out REAL benchmark tasks each &#183; Sonnet, medium effort throughout &#183; '
         f'lower-left is better</text>')
s.append('</svg>')

out_dir = os.path.join(REPO, "docs", "img")
os.makedirs(out_dir, exist_ok=True)
open(os.path.join(HERE, "readme_parity.html"), "w").write(
    f'<!doctype html><meta charset="utf-8"><title>parity</title>'
    f'<style>*{{margin:0}}body{{background:#fff}}</style>{"".join(s)}')
print(f"1a {a1['turns']} turns / {a1['min']}m   1c {c1['turns']} / {c1['min']}m   6b {b6['turns']} / {b6['min']}m")
print("wrote", os.path.join(HERE, "readme_parity.html"))
