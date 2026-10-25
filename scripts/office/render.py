# 办公室场景：用 Kenney Furniture Kit（CC0）在 Blender 里摆一间斜视角的屋子，预渲成图给网页用。
# 用法：blender -b -P scripts/office/render.py -- <Furniture Kit 的 glb 目录> [输出目录，默认 web/office] [all|bg]
#       Furniture Kit 从 https://kenney.nl/assets/furniture-kit 下载，模型不进仓库；bg 只渲两张背景，调场景时用。
# 产出：bg-day.webp / bg-night.webp（整间屋子，浅色和深色模式各一张，相机一样）、
#       body-<day|night>-<种类>.webp（坐在第一张桌后的 Agent 身子，桌子和笔记本挡住的部分已经抠掉；
#       正交相机下平移不变，其余桌位用同一张图挪过去）、
#       layout.js（白板、书架、收件盘、每张桌子的脸、头顶、名牌和点击区在图里的像素位置，网页按它叠实时信息）。
import bpy, sys, os, json, math, mathutils
import numpy as np
from bpy_extras.object_utils import world_to_camera_view

argv = sys.argv[sys.argv.index('--') + 1:]
KIT = argv[0].rstrip('/') + '/'
OUT = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'web', 'office')
MODE = argv[2] if len(argv) > 2 else 'all'
os.makedirs(OUT, exist_ok=True)

W, D = 7, 2                       # 地板 x 方向 7 格、y 方向 2 格；左墙在 x=0，后墙在 y=D
SLOTS = [(0.95 + 1.1 * k, 0.5) for k in range(5)]  # 五个桌位（桌子左前角），跟 office.js 的 MAX_DESKS 一致
BOARD = (2.45, 0.84)              # 白板中心的 x 和高度
WINDOWS = (4, 5)                  # 后墙第几格开窗
TRAY = (6.55, 0.32)               # 收件盘中心
SHELF_Y = 1.25                    # 书架中心的 y
RES_X = 2400                      # 高度按屋子比例自动算
AZIM, ELEV = -26.0, 26.0          # 相机在右前方，偏 26°，俯角 26°

DAY = {'wall': '#EEE9E1', 'wall2': '#E6E0D6', 'trim': '#D8CDBD', 'floor': '#D7C7AF', 'rug': '#E8E2D6', 'rug2': '#CFC6B6',
       'wood': '#E2CFAE', 'metal': '#B4B0A8', 'dark': '#3B3A37', 'mid': '#8A867E', 'chair': '#5E6B73', 'plant': '#7FA588',
       'board': '#FBFAF7', 'frame': '#CFC6B7', 'sky': '#CFE3EE', 'b1': '#B4664C', 'b2': '#5D7A8C', 'b3': '#8AA37E'}
NIGHT = {'wall': '#34322D', 'wall2': '#2E2C28', 'trim': '#45403A', 'floor': '#2E2B25', 'rug': '#38352F', 'rug2': '#433F38',
         'wood': '#6A5F4E', 'metal': '#5E5C56', 'dark': '#161615', 'mid': '#4A4843', 'chair': '#3A434A', 'plant': '#4E6B55',
         'board': '#A8A59C', 'frame': '#5A5248', 'sky': '#22304C', 'b1': '#8A5141', 'b2': '#465C6B', 'b3': '#5B6E53'}
KINDS = {'day': {'codex': '#1F1F1D', 'claude': '#D97757', 'web': '#B9B6AE', 'agent': '#566B7A'},   # 跟 style.css 的 --av-* 一致
         'night': {'codex': '#ECEBE6', 'claude': '#D97757', 'web': '#5E5C57', 'agent': '#566B7A'}}
BODY_R = 0.17                     # 身子半径，网页按它算眼睛多大


def seat_of(x, y):
    return (x + 0.37, y + 0.6, 0.5)


def lin(h):
    h = h.lstrip('#')
    return tuple((int(h[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4)) + (1,)


def material(name, hexcol, rough=0.75, emit=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    pb = m.node_tree.nodes['Principled BSDF']
    pb.inputs['Base Color'].default_value = lin(hexcol); pb.inputs['Roughness'].default_value = rough
    if emit:
        pb.inputs['Emission Color'].default_value = lin(hexcol); pb.inputs['Emission Strength'].default_value = emit
    return m


def load(name, loc=(0, 0, 0), rot=0.0, scale=1.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=KIT + name + '.glb')
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
    root.location = loc; root.rotation_euler[2] = math.radians(rot)
    root.scale = scale if isinstance(scale, tuple) else (scale,) * 3
    return [o for o in new if o.type == 'MESH']


def paint(meshes, table):
    """按 Kenney 的材质名换成这间屋子的配色。"""
    for o in meshes:
        for slot in o.material_slots:
            n = slot.material.name.split('.')[0] if slot.material else ''
            if n in table:
                slot.material = table[n]


def box(size, loc, mat, bevel=0.01):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    b = o.modifiers.new('bv', 'BEVEL'); b.width = bevel; b.segments = 3
    o.data.materials.append(mat)


def build(pal, night):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = {k: material(k, v) for k, v in pal.items()}
    glass = material('glass', pal['sky'], 0.2, 0.5 if night else 0.25)
    wall = {'_defaultMat': M['wall'], 'wood': M['trim'], 'metalDark': M['trim'], 'glass': glass}
    side = {'_defaultMat': M['wall2'], 'wood': M['trim'], 'metalDark': M['trim']}
    books = {'carpetDarker': M['b1'], 'carpetWhite': M['board'], 'metal': M['b2'], 'plant': M['b3']}
    furn = {'wood': M['wood'], 'metal': M['metal'], 'metalDark': M['dark'], 'metalMedium': M['mid'], 'carpet': M['chair'],
            'carpetDarker': M['rug2'], 'carpetWhite': M['board'], 'plant': M['plant'], 'woodDark': M['trim'],
            'lamp': material('lamp', '#F6E7BE', 0.5, 2.5 if night else 0.3), '_defaultMat': M['wood']}
    for i in range(W):
        for j in range(D):
            paint(load('floorFull', (i, j, -0.05)), {'wood': M['floor']})
        paint(load('wallWindow' if i in WINDOWS else 'wall', (i, D, 0)), wall)
    for j in range(D):
        paint(load('wall', (0, j + 1, 0), rot=-90), side)
    paint(load('rugRectangle', (0.7, 0.15, 0), scale=(3.65, 1.45, 1)), {'carpet': M['rug'], 'carpetDarker': M['rug2']})
    # 桌位：桌子、椅子在桌后（Agent 面朝镜头坐）、笔记本屏幕朝 Agent 背朝镜头，不挡脸
    for k, (x, y) in enumerate(SLOTS):
        paint(load('desk', (x, y, 0)), furn)
        paint(load('chairDesk', (x + 0.2, y + 0.42, 0)), furn)
        paint(load('laptop', (x + 0.2 + 0.264, y + 0.06 + 0.24, 0.384), rot=180), furn)
        if k in (1, 3):
            paint(load('plantSmall2' if k == 1 else 'plantSmall3', (x + 0.64, y + 0.1, 0.384)), furn)
    # 左墙：书架和书，墙角一盆绿植，门口一盏落地灯
    paint(load('bookcaseOpen', (0.05, SHELF_Y + 0.2, 0), rot=-90), furn)
    for z in (0.02, 0.3, 0.58):
        for n in range(2):
            paint(load('books', (0.08, SHELF_Y + 0.13 - n * 0.16, z + 0.035), rot=-90), books)
    paint(load('pottedPlant', (0.3, D - 0.3, 0)), furn)
    paint(load('lampRoundFloor', (0.25, 0.3, 0)), furn)
    # 白板：网页在上面贴规划便签
    box((2.2, 0.03, 0.72), (BOARD[0], D - 0.03, BOARD[1]), M['board'], 0.006)
    box((2.26, 0.02, 0.78), (BOARD[0], D - 0.015, BOARD[1]), M['frame'], 0.004)
    box((2.1, 0.06, 0.02), (BOARD[0], D - 0.05, BOARD[1] - 0.38), M['frame'], 0.004)
    # 收件盘：右前方一张小边桌上一只浅木盘，网页往里叠纸
    paint(load('sideTable', (TRAY[0] - 0.27, TRAY[1] - 0.11, 0)), furn)
    box((0.34, 0.2, 0.035), (TRAY[0], TRAY[1], 0.402), M['wood'], 0.006)
    box((0.3, 0.16, 0.02), (TRAY[0], TRAY[1], 0.414), M['board'], 0.002)


def camera_and_light(night):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = RES_X
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.eevee.taa_render_samples = 64
    sc.eevee.use_shadows = True
    sc.eevee.use_raytracing = True
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    target = mathutils.Vector((W / 2, D / 2, 0.5))
    a, e = math.radians(AZIM), math.radians(ELEV)
    cam.location = target + 30 * mathutils.Vector((-math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    # 画面宽度贴着屋子（地板四角、墙顶），高度按屋子比例算
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    pts = [inv @ mathutils.Vector(p) for p in ((0, 0, -0.05), (W, 0, -0.05), (0, D, 1.29), (W, D, 1.29), (0, 0, 1.29), (W, D, -0.05))]
    xs, ys = [p.x for p in pts], [p.y for p in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    cam.data.ortho_scale = w * 1.03
    sc.render.resolution_y = round(RES_X * h / w / 2) * 2
    cam.data.shift_x = (max(xs) + min(xs)) / 2 / cam.data.ortho_scale
    cam.data.shift_y = (max(ys) + min(ys)) / 2 / cam.data.ortho_scale
    world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.25, 0.3, 0.42, 1) if night else (0.95, 0.9, 0.82, 1)
    bg.inputs[1].default_value = 0.25 if night else 0.65

    def light(kind, loc, energy, color, size=None, aim=(W / 2, D / 2, 0), shadow=True):
        l = bpy.data.lights.new(kind, kind); l.energy = energy; l.color = color; l.use_shadow = shadow
        if kind == 'SUN':
            l.angle = math.radians(14)
        if size:
            l.size = size
        o = bpy.data.objects.new(kind, l); sc.collection.objects.link(o); o.location = loc
        o.rotation_euler = (mathutils.Vector(aim) - mathutils.Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    if not night:
        light('SUN', (W + 4, -3, 8), 3.4, (1.0, 0.97, 0.92))            # 右前上方的暖阳光
        light('AREA', (-2, -4, 4), 260, (0.86, 0.9, 1.0), size=8)       # 左前方冷补光，压住阴影
    else:
        light('SUN', (W + 4, -3, 8), 1.2, (0.62, 0.7, 0.95))            # 月光
        light('AREA', (-2, -4, 4), 160, (0.7, 0.78, 1.0), size=8)
        light('POINT', (0.3, 0.35, 1.05), 90, (1.0, 0.8, 0.55), shadow=False)  # 落地灯，灯罩不挡光
        for x, y in SLOTS:                                                # 笔记本屏幕照在 Agent 脸上
            light('AREA', (x + 0.33, y + 0.2, 0.5), 7, (0.7, 0.82, 1.0), size=0.25, aim=(x + 0.37, y + 0.6, 0.5))
    return cam


def px(cam, p):
    v = world_to_camera_view(bpy.context.scene, cam, mathutils.Vector(p))
    r = bpy.context.scene.render
    return [round(v.x * r.resolution_x, 1), round((1 - v.y) * r.resolution_y, 1)]


def bbox(cam, lo, hi):
    pts = [px(cam, (x, y, z)) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    x0, y0 = min(p[0] for p in pts), min(p[1] for p in pts)
    return [x0, y0, round(max(p[0] for p in pts) - x0, 1), round(max(p[1] for p in pts) - y0, 1)]


def body(kind, colors):
    """Agent 的身子：和 avatar.js 同一套形状和颜色，眼睛不建模，网页按神态叠上去。"""
    seat = seat_of(*SLOTS[0])
    if kind == 'claude':
        bpy.ops.mesh.primitive_uv_sphere_add(radius=BODY_R, location=seat, segments=48, ring_count=24)
        o = bpy.context.active_object; o.scale = (1.0, 0.88, 0.94)
    elif kind == 'web':
        bpy.ops.mesh.primitive_uv_sphere_add(radius=BODY_R * 0.92, location=seat, segments=48, ring_count=24)
        o = bpy.context.active_object
    else:
        bpy.ops.mesh.primitive_cube_add(size=BODY_R * 1.8, location=seat)
        o = bpy.context.active_object; o.scale = (1.0, 0.85, 0.98)
        b = o.modifiers.new('bv', 'BEVEL'); b.width = 0.085; b.segments = 8
    bpy.ops.object.shade_smooth()
    o.rotation_euler[2] = math.radians(AZIM)  # 正脸朝镜头
    o.data.materials.append(material('body-' + kind, colors[kind], 0.55))
    return o


def save_webp(pixels, w, h, path, quality=86):
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels = pixels.ravel().tolist()
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'WEBP'; sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.quality = quality
    img.save_render(path, scene=sc)
    bpy.data.images.remove(img)


def render_pixels():
    """渲一张，返回自下而上的 RGBA 数组（Blender 的像素顺序）。"""
    tmp = os.path.join(OUT, '_render.png')
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    sc.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp)
    A = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
    bpy.data.images.remove(img); os.remove(tmp)
    return A


def layout(cam):
    """网页要的位置，都是整张图里的像素坐标。"""
    bx, bz = BOARD
    r = bpy.context.scene.render
    out = {
        'size': [r.resolution_x, r.resolution_y],
        # 白板可写区域的左上、右上、左下三个角：网页用它把便签斜着贴到墙上
        'board': [px(cam, (bx - 1.06, D - 0.05, bz + 0.33)), px(cam, (bx + 1.06, D - 0.05, bz + 0.33)), px(cam, (bx - 1.06, D - 0.05, bz - 0.33))],
        'shelf': px(cam, (0.1, SHELF_Y, 0.95)),
        'tray': px(cam, (TRAY[0], TRAY[1], 0.43)),
        'trayHit': bbox(cam, (TRAY[0] - 0.3, TRAY[1] - 0.15, 0), (TRAY[0] + 0.3, TRAY[1] + 0.15, 0.45)),
        'faceR': round(BODY_R / cam.data.ortho_scale * r.resolution_x, 1),
        'slots': [],
    }
    for x, y in SLOTS:
        s = seat_of(x, y)
        out['slots'].append({
            'face': px(cam, s),
            'head': px(cam, (s[0], s[1], s[2] + BODY_R + 0.02)),
            'label': px(cam, (x + 0.37, y - 0.08, 0)),
            'hit': bbox(cam, (x - 0.03, y - 0.03, 0), (x + 0.76, y + 0.95, 0.72)),
        })
    return out


L = None
bodies = {}
for mode in ('day', 'night'):
    build(NIGHT if mode == 'night' else DAY, mode == 'night')
    cam = camera_and_light(mode == 'night')
    A = render_pixels()
    save_webp(A, A.shape[1], A.shape[0], os.path.join(OUT, f'bg-{mode}.webp'), 82)
    L = L or layout(cam)
    if MODE == 'bg':
        continue
    # 身子只在第一张桌后渲：别的东西都设成镂空，桌子、笔记本挡住的部分自然抠掉
    for o in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
        o.is_holdout = True
    for kind, color in KINDS[mode].items():
        b = body(kind, KINDS[mode])
        A = render_pixels()
        ys, xs = np.where(A[:, :, 3] > 0.01)
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        save_webp(A[y0:y1, x0:x1], x1 - x0, y1 - y0, os.path.join(OUT, f'body-{mode}-{kind}.webp'))
        rect = [x0, A.shape[0] - y1, x1 - x0, y1 - y0]  # 换成自上而下的坐标
        assert bodies.get(kind, rect) == rect, f'{kind} 白天黑夜的轮廓不一样：{bodies[kind]} vs {rect}'
        bodies[kind] = rect
        bpy.data.objects.remove(b, do_unlink=True)

if MODE != 'bg':
    f0 = L['slots'][0]['face']
    L['body'] = {k: [round(r[0] - f0[0], 1), round(r[1] - f0[1], 1), r[2], r[3]] for k, r in bodies.items()}  # 相对脸中心的偏移
with open(os.path.join(OUT, 'layout.js'), 'w') as f:
    f.write('// 由 scripts/office/render.py 生成，别手改。坐标是 bg-*.webp 里的像素。\n')
    f.write('export default ' + json.dumps(L, ensure_ascii=False) + ';\n')
print('OFFICE done', os.path.abspath(OUT))
