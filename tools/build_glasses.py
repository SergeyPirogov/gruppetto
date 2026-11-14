"""Original sport sunglasses for the Gruppetto rider: one wrap shield lens with a nose cut-out,
a thin top frame and temple arms back over the ears. Built in world space, parented to the head bone."""
import bpy, bmesh, numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

X0 = 0.5480      # lens front at the centre
K = 5.0         # wrap: x drops K*y^2
YW = 0.082      # half width of the lens
ZT = 1.5195     # top edge
ZB = 1.4560     # lowest point of the lens under each eye
ZN = 1.4990    # bottom at the nose
ZO = 1.4900     # bottom at the outer corner
TH = 0.0016     # lens thickness
TILT = 0.16     # bottom of the lens closer to the face (dx per dz)


def front(y, z):
    return X0 - K * y * y - TILT * (ZT - z)


NOSE = None
GAP = 0.002     # cut-out edge this far off the nose


PADS = None


def nose_table():
    """Nose pads lie on the sides of the nose; the cut-out follows them. Returns (a, z) of the cut edge."""
    global PADS
    T = body_bvh(); PADS = {}
    zs = np.linspace(ZN - 0.002, ZB + 0.010, 10); A = []
    for sgn in (1, -1):
        pts = []
        for z in zs:
            loc, nrm, _, d = T.find_nearest(Vector((0.532, sgn * 0.010, z)))
            pts.append((loc + nrm * 0.0026, nrm))
        PADS[sgn] = pts
    for k, z in enumerate(zs):
        A.append(max(abs(PADS[1][k][0].y), abs(PADS[-1][k][0].y)) + 0.0025)
    A = np.maximum.accumulate(np.array(A))               # wider further down
    zs = list(zs) + [ZB]; A = list(A) + [A[-1] + 0.004]
    return [A, zs]


def zbot(a):
    """Shield bottom: a narrow nose cut-out, then one sweep rising gently from the nose
    and rounding up into the outer top corner (no bottom corner)."""
    import math
    def ss(t):
        t = min(max(t, 0.0), 1.0); return t * t * (3 - 2 * t)
    a0 = NOSE[0][-1] if NOSE else 0.027
    if a < a0:
        if NOSE:
            return float(np.interp(a, NOSE[0], NOSE[1]))
        return ZN + (ZB - ZN) * ss((a - 0.005) / (a0 - 0.005)) ** 0.8
    t = (a - a0) / (YW - a0)
    base = ZB + 0.012 * t
    u = max(0.0, (t - 0.55) / 0.45)
    top = ztop(YW) - 0.0025
    z = base + (top - base) * (1 - math.sqrt(max(0.0, 1 - u * u)))
    return min(z, ztop(a) - 0.0025)


def ztop(a):
    """Top edge: straight, with a small round at the outer corner."""
    t = a / YW
    return ZT - 0.0015 * t ** 2 - 0.004 * max(0.0, (t - 0.93) / 0.07) ** 2


def body_bvh(name='MH_Body_v2'):
    o = bpy.data.objects[name]; dg = bpy.context.evaluated_depsgraph_get(); e = o.evaluated_get(dg); me = e.to_mesh()
    t = BVHTree.FromPolygons([o.matrix_world @ v.co for v in me.vertices], [tuple(p.vertices) for p in me.polygons]); e.to_mesh_clear()
    return t


def lens(bm, nu=150, nv=14):
    rows = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            y = -YW + 2 * YW * i / nu; a = abs(y)
            zb, zt = zbot(a), ztop(a)
            z = zb + (zt - zb) * j / nv
            row.append(bm.verts.new((front(y, z), y, z)))
        rows.append(row)
    fs = []
    for j in range(nv):
        for i in range(nu):
            fs.append(bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i])))
    return fs, rows


def tube(bm, pts, w, h, mat):
    """Rectangular section swept along pts (world), section w across, h tall; w/h may be per point lists."""
    n = len(pts); W = w if isinstance(w, list) else [w] * n; Hh = h if isinstance(h, list) else [h] * n
    rings = []
    for k, p in enumerate(pts):
        p = Vector(p)
        t = (Vector(pts[min(k + 1, n - 1)]) - Vector(pts[max(k - 1, 0)])).normalized()
        up = Vector((0, 0, 1)); side = t.cross(up).normalized(); up = side.cross(t).normalized()
        r = []
        for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            r.append(bm.verts.new(p + side * (sx * W[k] / 2) + up * (sz * Hh[k] / 2)))
        rings.append(r)
    fs = []
    for k in range(n - 1):
        a, b = rings[k], rings[k + 1]
        for q in range(4):
            fs.append(bm.faces.new((a[q], a[(q + 1) % 4], b[(q + 1) % 4], b[q])))
    fs.append(bm.faces.new(list(reversed(rings[0])))); fs.append(bm.faces.new(rings[-1]))
    for f in fs: f.material_index = mat
    return fs


def build(name='Glasses'):
    global NOSE
    NOSE = nose_table()
    T = body_bvh(); TH_ = body_bvh('MH_Hair')
    bm = bmesh.new()
    lf, rows = lens(bm)
    for f in lf: f.material_index = 1
    # thickness: shell the lens towards the face
    ret = bmesh.ops.solidify(bm, geom=lf, thickness=TH)
    for f in bm.faces:
        if f.material_index != 0: f.material_index = 1
    # top frame along the upper edge, a little above and behind the lens front
    top = []
    FE = 0.90                                   # the top frame ends here; the arms start from it
    for i in range(0, 41):
        y = -FE * YW + 2 * FE * YW * i / 40; a = abs(y)
        z = ztop(a) + 0.0012
        top.append((front(y, z) + 0.0004, y, z))
    tube(bm, top, 0.0034, 0.0052, 0)
    # temples: from the outer lens corners back over the ears, 2.5 mm off the skin
    for s in (1, -1):
        y0 = s * FE * YW; z0 = ztop(FE * YW) + 0.0012
        p0 = Vector((front(y0, z0) + 0.0004, y0, z0))
        path = [p0]
        for x, z in ((0.505, 1.5255), (0.48, 1.5295), (0.455, 1.5345), (0.43, 1.5385), (0.405, 1.5425), (0.388, 1.5435)):
            q = Vector((x, s * 0.095, z))
            loc, nrm, _, d = T.find_nearest(q)
            if loc is not None:
                q = loc + nrm * 0.0035
                q.z = z
            # over the hair too: push out along y until 2.5 mm clear of the hair surface
            for _ in range(20):
                hl, hn, _, hd = TH_.find_nearest(q)
                if hl is None or (q - hl).dot(hn) > 0.0025 or hd > 0.02: break
                q = q + Vector((0, s * 0.001, 0))
            path.append(q)
        # keep the arm going outward smoothly from the lens corner
        # smooth the arm (ends fixed), never letting it sink back towards the head
        for _ in range(6):
            nxt = [path[0]] + [(path[k - 1] + path[k] * 2 + path[k + 1]) / 4 for k in range(1, len(path) - 1)] + [path[-1]]
            for k in range(1, len(path) - 1):
                if s * nxt[k].y < s * path[k].y: nxt[k].y = path[k].y
            path = nxt
        hs = [0.0075, 0.0085, 0.008, 0.0068, 0.0055, 0.0048, 0.0045]
        tube(bm, [tuple(p) for p in path], 0.0030, hs, 0)
    # nose pads on the nose, joined to the lens at the top and the bottom of the cut-out
    for sgn in (1, -1):
        P = [p for p, n in PADS[sgn]]
        tube(bm, [tuple(p) for p in P], 0.0024, 0.0042, 0)
        for k in (0, len(P) - 1):
            p = P[k]; z = p.z; a = abs(p.y) + 0.0025
            q = Vector((front(sgn * a, z) - TH, sgn * a, z))
            tube(bm, [tuple(q), tuple((q + p) / 2), tuple(p)], 0.0022, 0.0026, 0)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    return ob
