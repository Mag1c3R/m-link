# Значок для Chrome Web Store: 128x128, рисунок 96x96 по центру, прозрачные поля по 16 px.
# Тот же рисунок, что у иконок расширения (градиент индиго -> фиолетовый, белая «M»).
import sys
from PIL import Image, ImageDraw

S = 512  # рисуем крупно и уменьшаем, чтобы края были гладкими

def artwork():
    c1, c2 = (99, 102, 241), (139, 92, 246)
    grad = Image.new('RGBA', (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=120, fill=255)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    pts = [(130, 370), (130, 150), (256, 290), (382, 150), (382, 370)]
    d.line(pts, fill='white', width=58, joint='curve')
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - 29, p[1] - 29, p[0] + 29, p[1] + 29], fill='white')
    return img

out = sys.argv[1] if len(sys.argv) > 1 else 'store/icon-128.png'
canvas = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
canvas.paste(artwork().resize((96, 96), Image.LANCZOS), (16, 16))
canvas.save(out)
print(out)
