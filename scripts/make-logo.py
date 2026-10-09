"""生成 Crew 的像素 logo：docs/logo-light|dark.svg、docs/crew-icon.svg 和 web/logo.svg。
PNG 用无头 Chrome 渲染，见 scripts/make-logo.sh。只用标准库。"""
from pathlib import Path

U = 12  # 一个像素格的边长（SVG 坐标）

# 5 宽字模；小写字母底部对齐到第 7 行
GLYPHS = {
    'C': (0, [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."]),
    'r': (2, ["#.##.", "##..#", "#....", "#....", "#...."]),
    'e': (2, [".###.", "#...#", "#####", "#....", ".####"]),
    'w': (2, ["#...#", "#...#", "#.#.#", "#.#.#", ".#.#."]),
}

# 船员：X 身体 V 面罩 D 眼睛 A 天线
CREW = ["...A....",
        "..XXXX..",
        ".XXXXXX.",
        "XXXXXXXX",
        "XVVVVVVX",
        "XVDVVDVX",
        "XVVVVVVX",
        "XXXXXXXX",
        ".XX..XX."]

PALETTES = {
    'light': {'ink': '#171B26', 'body': ['#A9A8F5', '#4F52D9', '#3FBF8A'], 'visor': '#EDEDFD', 'eye': '#171B26'},
    'dark': {'ink': '#ECEEF6', 'body': ['#7C7BE0', '#8F92FF', '#46C795'], 'visor': '#1B1F2E', 'eye': '#ECEEF6'},
}


def rects(rows, x0, y0, scale, colors, unit=U):
    out = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in colors:
                out.append(f'<rect x="{(x0 + x * scale) * unit}" y="{(y0 + y * scale) * unit}" width="{scale * unit}" height="{scale * unit}" fill="{colors[ch]}"/>')
    return out


def crew(palette, x0, y0):
    out = []
    for i, body in enumerate(palette['body']):
        lead = i == 1  # 中间的是领队：带天线，比两边高一格，脚底对齐
        colors = {'X': body, 'V': palette['visor'], 'D': palette['eye'], 'A': body}
        out += rects(CREW if lead else CREW[1:], x0 + i * 9, y0 if lead else y0 + 1, 1, colors)
    return out


def wordmark(ink, x0, y0, scale):
    out, x = [], x0
    for ch in 'Crew':
        top, rows = GLYPHS[ch]
        out += rects(rows, x, y0 + top * scale, scale, {'#': ink})
        x += (5 + 1) * scale
    return out


def svg(width_u, height_u, parts):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width_u * U} {height_u * U}" '
            f'width="{width_u * U}" height="{height_u * U}" shape-rendering="crispEdges">' + ''.join(parts) + '</svg>')


def main():
    docs = Path(__file__).resolve().parent.parent / 'docs'
    for name, p in PALETTES.items():
        # 左：三个船员；右：Crew 字样（2 倍格，23 格宽）。画布 80×19 格
        parts = crew(p, 2, 4) + wordmark(p['ink'], 32, 2, 2)
        (docs / f'logo-{name}.svg').write_text(svg(80, 19, parts), encoding='utf-8')
    p = PALETTES['light']
    # 窗口、卡片和终端首页用的小图标：只放领队，16×16 格。
    # 坐标必须是格子序号（0–15）：src/tui.ts 的 renderLogo 直接读这些 rect 画终端里的像素图。
    lead = rects(CREW, 4, 3, 1, {'X': p['body'][1], 'V': p['visor'], 'D': p['eye'], 'A': p['body'][1]}, unit=1)
    (docs.parent / 'web' / 'logo.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="256" height="256" shape-rendering="crispEdges"><title>Crew</title>' + ''.join(lead) + '</svg>', encoding='utf-8')
    (docs / 'crew-icon.svg').write_text(svg(30, 16, crew(p, 2, 3)), encoding='utf-8')


if __name__ == '__main__':
    main()
