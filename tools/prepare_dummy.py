"""Extracts the seated cyclist mannequin ("Human_dummy") from the Drivetrain V2 glTF into a small,
low-poly model for the app.

Usage (plain Python 3, no packages):
    python3 tools/prepare_dummy.py "<folder with Drivetrain_V2_gltf_.gltf and .bin>"

The source is a CAD export (Open CASCADE): a bike with a mannequin made of rigid parts (thighs,
shins, feet, upper arms, forearms, hands, torso, head) and a ball at every joint. Only the mannequin
is kept. Each part is simplified by vertex clustering (the low-poly, flat-shaded look of the
scenery) and split into kit materials: jersey, collar/cuff stripe, shorts, skin, socks, shoes, hair.

Writes assets/rider/dummy.gltf + dummy.bin in the app's frame (x forward, y up, z right, ground at
y = 0, bottom bracket at x = 0) with the joint positions, the source bike's saddle and bottom
bracket in `scene.extras`; js/dummy-rider.js poses the parts around those joints.
"""
import array
import json
import math
import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'rider'
CELL = 0.011  # m, vertex clustering grid: bigger = fewer, flatter facets
COLLAR = (0.92, 0.95)  # collar band along the hips→neck line (0 = hips, 1 = neck joint)

PARTS = {  # app part name -> source node
    'torso': 'Torso_1', 'head': 'Head_1',
    'upperArmL': 'Left_Upper_Arm', 'lowerArmL': 'Left_Lower_Arm', 'handL': 'Left_Hand',
    'upperArmR': 'Right_Upper_Arm', 'lowerArmR': 'Right_Lower_Arm', 'handR': 'Right_Hand',
    'upperLegL': 'Left_Upper_Leg', 'lowerLegL': 'Left_Lower_Leg', 'footL': 'Left_Foot',
    'upperLegR': 'Right_Upper_Leg', 'lowerLegR': 'Right_Lower_Leg', 'footR': 'Right_Foot',
}
JOINTS = {  # app joint name -> source joint ball
    'neck': 'Neck_Torso_Joint',
    'hipL': 'Left_Hip_Leg_Joint', 'kneeL': 'Left_Knee_Upper_Leg_Joint', 'ankleL': 'Left_Ankle_Leg_Joint',
    'hipR': 'Right_Hip_Leg_Joint', 'kneeR': 'Right_Knee_Upper_Leg_Joint', 'ankleR': 'Right_Ankle_Leg_Joint',
    'shoulderL': 'Left_Shoulder_Upper_Arm_Joint', 'elbowL': 'Left_Elbow_Upper_Arm_Joint', 'wristL': 'Left_Wrist_Hand_Joint',
    'shoulderR': 'Right_Shoulder_Upper_Arm_Joint', 'elbowR': 'Right_Elbow_Upper_Arm_Joint', 'wristR': 'Right_Wrist_Hand_Joint',
}
MATERIALS = ['skin', 'jersey', 'stripe', 'shorts', 'sock', 'shoe', 'sole', 'hair']
SOCK = (0.58, 0.63)    # sock top (accent cuff between the two) along knee→ankle
SHOE = (0.2, 0.8)      # sole line and shoe collar, as fractions of the foot's height

COMP = {5126: ('f', 4), 5125: ('I', 4), 5123: ('H', 2), 5121: ('B', 1)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Gltf:
    def __init__(self, path):
        self.g = json.loads(path.read_text())
        self.buf = (path.parent / self.g['buffers'][0]['uri']).read_bytes()
        self.parent = {c: i for i, n in enumerate(self.g['nodes']) for c in n.get('children', [])}
        self.by_name = {}
        for i, n in enumerate(self.g['nodes']):
            self.by_name.setdefault(n.get('name'), i)

    def accessor(self, i):
        a = self.g['accessors'][i]
        bv = self.g['bufferViews'][a['bufferView']]
        code, size = COMP[a['componentType']]
        n = NCOMP[a['type']]
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride') or size * n
        out = array.array(code)
        if stride == size * n:
            out.frombytes(self.buf[off:off + a['count'] * stride])
        else:
            for k in range(a['count']):
                out.frombytes(self.buf[off + k * stride: off + k * stride + size * n])
        return out, n

    def local(self, i):
        n = self.g['nodes'][i]
        if 'matrix' in n:
            m = n['matrix']
            return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
        x, y, z, w = n.get('rotation', [0, 0, 0, 1])
        sx, sy, sz = n.get('scale', [1, 1, 1])
        tx, ty, tz = n.get('translation', [0, 0, 0])
        r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
             [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
             [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        return [[r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx],
                [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
                [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz], [0, 0, 0, 1]]

    def world(self, i):
        m = self.local(i)
        while i in self.parent:
            i = self.parent[i]
            p = self.local(i)
            m = [[sum(p[r][k] * m[k][c] for k in range(4)) for c in range(4)] for r in range(4)]
        return m

    def mesh_nodes(self, i):
        out, stack = [], [i]
        while stack:
            k = stack.pop()
            if 'mesh' in self.g['nodes'][k]:
                out.append(k)
            stack += self.g['nodes'][k].get('children', [])
        return out

    def triangles(self, i):
        """World-space triangles of every mesh under node i, as a list of 3 (x, y, z) tuples."""
        tris = []
        for k in self.mesh_nodes(i):
            m = self.world(k)
            for p in self.g['meshes'][self.g['nodes'][k]['mesh']]['primitives']:
                if p.get('mode', 4) != 4:
                    continue
                pos, _ = self.accessor(p['attributes']['POSITION'])
                v = [tuple(m[r][0] * pos[j] + m[r][1] * pos[j + 1] + m[r][2] * pos[j + 2] + m[r][3] for r in range(3))
                     for j in range(0, len(pos), 3)]
                idx = self.accessor(p['indices'])[0] if 'indices' in p else range(len(v))
                tris += [(v[idx[j]], v[idx[j + 1]], v[idx[j + 2]]) for j in range(0, len(idx) - 2, 3)]
        return tris

    def centre(self, i):
        pts = [p for t in self.triangles(i) for p in t]
        lo = [min(p[a] for p in pts) for a in range(3)]
        hi = [max(p[a] for p in pts) for a in range(3)]
        return tuple((lo[a] + hi[a]) / 2 for a in range(3)), lo, hi


def to_app(p, axle_x, wheel_r):
    """Source frame (x forward, y left→right, z down) -> app (x forward, y up, z right)."""
    return (p[0] - axle_x, -p[2] + wheel_r, p[1])


def cluster(tris):
    """Vertex clustering: snap to a grid, merge, drop collapsed and duplicate triangles."""
    verts, index, out, seen = [], {}, [], set()
    sums = {}
    for t in tris:
        ids = []
        for p in t:
            key = (round(p[0] / CELL), round(p[1] / CELL), round(p[2] / CELL))
            if key not in index:
                index[key] = len(verts)
                verts.append(key)
                sums[key] = [0.0, 0.0, 0.0, 0]
            s = sums[key]
            s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3] += 1
            ids.append(index[key])
        if len(set(ids)) < 3:
            continue
        k = tuple(sorted(ids))
        if k in seen:
            continue
        seen.add(k)
        out.append(ids)
    pos = [(sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]) for k in verts]
    return pos, out


def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def mid(a, b): return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
def length(a): return math.sqrt(dot(a, a))


def along(p, a, b):
    """0 at joint a, 1 at joint b."""
    ab = sub(b, a)
    return dot(sub(p, a), ab) / dot(ab, ab)


def seams(part, J):
    """Where the kit changes along a part: [(joint a, joint b, [t, ...])], t = 0 at a, 1 at b."""
    s = part[-1] if part[-1] in 'LR' else ''
    if part == 'torso':
        return [(mid(J['hipL'], J['hipR']), J['neck'], [0.17, COLLAR[0], COLLAR[1]])]
    if part.startswith('upperArm'):
        return [(J['shoulder' + s], J['elbow' + s], [0.45, 0.53])]
    if part.startswith('upperLeg'):
        return [(J['hip' + s], J['knee' + s], [0.78])]
    if part.startswith('lowerLeg'):
        return [(J['knee' + s], J['ankle' + s], list(SOCK))]
    if part.startswith('foot'):
        return [(J['footBase' + s], J['footTop' + s], list(SHOE))]
    return []


def split(tris, a, b, t):
    """Cuts triangles crossing the plane at `t` along a→b, so kit seams are straight lines."""
    ab = sub(b, a)
    n2 = dot(ab, ab)
    f = lambda p: dot(sub(p, a), ab) / n2 - t
    lerp = lambda p, q, k: tuple(p[i] + (q[i] - p[i]) * k for i in range(3))
    out = []
    for tri in tris:
        d = [f(p) for p in tri]
        if all(x >= 0 for x in d) or all(x <= 0 for x in d):
            out.append(tri)
            continue
        # rotate so vertex 0 is alone on its side
        for r in range(3):
            if (d[r] > 0) != (d[(r + 1) % 3] > 0) and (d[r] > 0) != (d[(r + 2) % 3] > 0):
                break
        p0, p1, p2 = tri[r], tri[(r + 1) % 3], tri[(r + 2) % 3]
        d0, d1, d2 = d[r], d[(r + 1) % 3], d[(r + 2) % 3]
        q1 = lerp(p0, p1, d0 / (d0 - d1))
        q2 = lerp(p0, p2, d0 / (d0 - d2))
        out += [(p0, q1, q2), (q1, p1, p2), (q1, p2, q2)]
    return out


def classify(part, c, J):
    """Kit material of a triangle with centroid c."""
    s = part[-1] if part[-1] in 'LR' else ''
    if part == 'torso':
        t = along(c, mid(J['hipL'], J['hipR']), J['neck'])
        # a thin collar band where the neck leaves the jersey; the neck itself is skin
        return 'shorts' if t < 0.17 else 'jersey' if t < COLLAR[0] else 'stripe' if t < COLLAR[1] else 'skin'
    if part.startswith('upperArm'):
        t = along(c, J['shoulder' + s], J['elbow' + s])
        return 'jersey' if t < 0.45 else 'stripe' if t < 0.53 else 'skin'
    if part.startswith('upperLeg'):
        return 'shorts' if along(c, J['hip' + s], J['knee' + s]) < 0.78 else 'skin'
    if part.startswith('lowerLeg'):
        t = along(c, J['knee' + s], J['ankle' + s])
        return 'skin' if t < SOCK[0] else 'stripe' if t < SOCK[1] else 'sock'
    if part.startswith('foot'):
        # road shoe: stiff white sole and a dark upper; the sock shows above the shoe's collar
        h = along(c, J['footBase' + s], J['footTop' + s])   # 0 at the sole .. 1 at the top
        t = along(c, J['heel' + s], J['toe' + s])            # 0 at the heel .. 1 at the toe
        if h < SHOE[0]:
            return 'sole'
        if h > SHOE[1] and t < 0.5:
            return 'sock'
        return 'shoe'  # the dial on the instep is added by the app (extras "dials")
    if part == 'head':
        # hair: the top and back of the head, above the ears
        neck = J['neck']
        head_c = J['headCentre']
        up = c[1] - head_c[1]
        back = (head_c[0] - c[0])
        return 'hair' if up > 0.015 or (back > 0.035 and up > -0.04 and c[1] > neck[1] + 0.06) else 'skin'
    return 'skin'


def main(src):
    src = pathlib.Path(src)
    gl = Gltf(next(src.glob('*.gltf')))
    # wheels: rear axle at the source origin; app ground = axle height below
    _, lo, hi = gl.centre(gl.by_name['Rear_Wheel'])
    wheel_r = (hi[2] - lo[2]) / 2
    crank, _, _ = gl.centre(gl.by_name['fc1'])
    bb_src = crank
    axle_x = bb_src[0]  # app x = 0 at the bottom bracket
    app = lambda p: to_app(p, axle_x, wheel_r)

    J = {k: app(gl.centre(gl.by_name[v])[0]) for k, v in JOINTS.items()}
    J['headCentre'] = app(gl.centre(gl.by_name['Head_1'])[0])
    # each foot's own frame: heel→toe along its length, "up" square to it in the side plane
    dials = {}
    for s, node in (('L', 'Left_Foot'), ('R', 'Right_Foot')):
        pts = [app(p) for t in gl.triangles(gl.by_name[node]) for p in t]
        toe, heel = max(pts, key=lambda p: p[0]), min(pts, key=lambda p: p[0])
        f = sub(toe, heel)
        n = math.hypot(f[0], f[1])
        up = (-f[1] / n, f[0] / n, 0.0)
        lo, hi = min(dot(p, up) for p in pts), max(dot(p, up) for p in pts)
        base = tuple(heel[i] + up[i] * (lo - dot(heel, up)) for i in range(3))
        J['heel' + s], J['toe' + s] = heel, toe
        J['footBase' + s] = base
        J['footTop' + s] = tuple(base[i] + up[i] * (hi - lo) for i in range(3))
        J['footMid' + s] = tuple(sum(p[i] for p in pts) / len(pts) for i in range(3))
        # the shoe's dial: top of the instep, a little over halfway from heel to toe
        L2 = dot(f, f)
        instep = [p for p in pts if abs(dot(sub(p, heel), f) / L2 - 0.55) < 0.05 and abs(p[2] - J['footMid' + s][2]) < 0.015]
        top = max(instep, key=lambda p: dot(p, up))
        dials[s] = {'at': [round(x, 4) for x in top], 'up': [round(x, 4) for x in up]}
    _, slo, shi = gl.centre(gl.by_name['Saddle'])
    saddle = ((slo[0] + shi[0]) / 2 - axle_x, -slo[2] + wheel_r)  # middle, top
    bb = app(bb_src)

    bin_out = bytearray()
    views, accessors, meshes, nodes = [], [], [], []
    mat_index = {m: i for i, m in enumerate(MATERIALS)}
    total = 0

    def add_view(data, target):
        while len(bin_out) % 4:
            bin_out.append(0)
        views.append({'buffer': 0, 'byteOffset': len(bin_out), 'byteLength': len(data), 'target': target})
        bin_out.extend(data)
        return len(views) - 1

    for part, node in PARTS.items():
        tris = [tuple(app(p) for p in t) for t in gl.triangles(gl.by_name[node])]
        pos, faces = cluster(tris)
        # straight seams: cut the simplified triangles at the kit boundaries, then re-index
        ftris = [tuple(pos[i] for i in f) for f in faces]
        for a, b, ts in seams(part, J):
            for t in ts:
                ftris = split(ftris, a, b, t)
        index, pos, faces = {}, [], []
        for tri in ftris:
            ids = []
            for p in tri:
                k = tuple(round(x, 5) for x in p)
                if k not in index:
                    index[k] = len(pos)
                    pos.append(p)
                ids.append(index[k])
            faces.append(ids)
        total += len(pos)
        groups = {}
        for f in faces:
            c = tuple(sum(pos[i][a] for i in f) / 3 for a in range(3))
            groups.setdefault(classify(part, c, J), []).append(f)
        prims = []
        for mat, fs in groups.items():
            used = sorted({i for f in fs for i in f})
            remap = {o: n for n, o in enumerate(used)}
            p = array.array('f', [x for i in used for x in pos[i]])
            idx = array.array('H' if len(used) < 65536 else 'I', [remap[i] for f in fs for i in f])
            pv = add_view(p.tobytes(), 34962)
            accessors.append({'bufferView': pv, 'componentType': 5126, 'count': len(used), 'type': 'VEC3',
                              'min': [min(pos[i][a] for i in used) for a in range(3)],
                              'max': [max(pos[i][a] for i in used) for a in range(3)]})
            iv = add_view(idx.tobytes(), 34963)
            accessors.append({'bufferView': iv, 'componentType': 5123 if idx.typecode == 'H' else 5125,
                              'count': len(idx), 'type': 'SCALAR'})
            prims.append({'attributes': {'POSITION': len(accessors) - 2}, 'indices': len(accessors) - 1,
                          'material': mat_index[mat]})
        meshes.append({'name': part, 'primitives': prims})
        nodes.append({'name': part, 'mesh': len(meshes) - 1})

    r3 = lambda p: [round(x, 4) for x in p]
    gltf = {
        'asset': {'version': '2.0', 'generator': 'power-up tools/prepare_dummy.py'},
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes))), 'extras': {
            'joints': {k: r3(v) for k, v in J.items() if not k.startswith(('heel', 'toe', 'foot'))}, 'saddle': r3(saddle), 'bb': r3(bb), 'dials': dials}}],
        'nodes': nodes, 'meshes': meshes,
        'materials': [{'name': m, 'pbrMetallicRoughness': {'baseColorFactor': [0.8, 0.8, 0.8, 1], 'metallicFactor': 0}} for m in MATERIALS],
        'accessors': accessors, 'bufferViews': views,
        'buffers': [{'uri': 'dummy.bin', 'byteLength': len(bin_out)}],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'dummy.bin').write_bytes(bytes(bin_out))
    (OUT / 'dummy.gltf').write_text(json.dumps(gltf, separators=(',', ':')))
    print(f'Wrote {OUT / "dummy.gltf"}: {len(nodes)} parts, {total} vertices, {len(bin_out) // 1024} KB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
