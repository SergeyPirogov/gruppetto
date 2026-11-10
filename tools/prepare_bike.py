"""Builds Gruppetto's own aero road bike (an original design, CC0) as assets/bikes/aero.glb.

Runs inside Blender, in the background (the open scene is not touched):
    /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/prepare_bike.py

The file follows the "rigged" bike format of js/bike-model.js: plain nodes the app turns every frame,
  BackWheel, FrontWheel (around their axles), ChainRing (around the bottom bracket) and on it
  RightPedal / LeftPedal (kept level).
Its own PBR materials render as they are, except "Paint" (the frame), which the app repaints per rider;
the GRUPPETTO decal on the down tube is part of the model. At rest the right crank (drive side, three.js
+z) points forward, as the rider's feet. Also writes assets/bikes/aero.json (wheel radius for rolling).

Geometry, a 56 cm race fit: bottom bracket 0.29 m up, wheelbase 0.995 m, 700x28c tyres (r 0.345 m),
saddle top 0.75 m above the bottom bracket, hoods 0.62 m ahead of it, 0.42 m apart.
Blender axes: +X forward, +Z up, -Y the drive side (three.js +z).
"""
import json
import math
import pathlib

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'bikes' / 'aero.glb'

# materials: base colour (linear), metallic, roughness, clear coat
MATERIALS = {
    'Paint': ((0.6, 0.03, 0.03), 0.0, 0.32, 1.0),    # frame and fork, repainted per rider by the app
    'Carbon': ((0.018, 0.018, 0.02), 0.0, 0.3, 1.0),  # glossy carbon cockpit and seatpost
    'Rim': ((0.022, 0.022, 0.024), 0.0, 0.42, 0.6),   # matt-ish carbon rims, spokes, hubs
    'Rubber': ((0.012, 0.012, 0.012), 0.0, 0.85, 0.0),  # tyres
    'Black': ((0.02, 0.02, 0.022), 0.0, 0.65, 0.0),   # saddle, bar tape, hoods, pedals, calipers
    'Metal': ((0.55, 0.56, 0.58), 1.0, 0.32, 0.0),    # chainrings, cassette, chain, rotors
    'Decal': ((0.85, 0.85, 0.85), 0.0, 0.4, 1.0),     # GRUPPETTO on the down tube, rim logos
}
PAINT, CARBON, RIM, RUBBER, BLACK, METAL, DECAL = 'Paint', 'Carbon', 'Rim', 'Rubber', 'Black', 'Metal', 'Decal'

BB = Vector((0.0, 0.0, 0.29))
R_TYRE = 0.345
REAR = Vector((-0.41, 0.0, R_TYRE))
FRONT = Vector((0.585, 0.0, R_TYRE))
CRANK = 0.17
SEAT_ANGLE, HEAD_ANGLE = math.radians(73.5), math.radians(73.0)
ST_TOP = BB + 0.53 * Vector((-math.cos(SEAT_ANGLE), 0, math.sin(SEAT_ANGLE)))
HT_TOP = BB + Vector((0.385, 0, 0.565))
HEAD_DOWN = Vector((math.cos(HEAD_ANGLE), 0, -math.sin(HEAD_ANGLE)))
HT_BOT = HT_TOP + HEAD_DOWN * 0.15
SEAT_UP = Vector((-math.cos(SEAT_ANGLE), 0, math.sin(SEAT_ANGLE)))


# ---------- mesh helpers ----------

def new_object(name, bm, color, parent=None, origin=Vector()):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    paint(me, color)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if origin.length:
        me.transform(Matrix.Translation(-origin))
        o.location = origin
    if parent:
        o.parent = parent
        o.location = origin - parent.location  # parents are unrotated and the root sits at the origin
    for p in me.polygons:
        p.use_smooth = True
    return o


def material(key):
    m = bpy.data.materials.get(key)
    if m:
        return m
    rgb, metal, rough, coat = MATERIALS[key]
    m = bpy.data.materials.new(key)
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = 0.06
    return m


def paint(me, key):
    me.materials.clear()
    me.materials.append(material(key))


def airfoil(chord, thick, n=20, kamm=0.82):
    """Kamm-tail aero profile: (along chord, across) points, leading edge at 0."""
    pts = []
    for i in range(n + 1):
        s = kamm * (1 - math.cos(math.pi * i / n)) / 2
        h = thick / 2 * min(1.0, (2.969 * math.sqrt(s) - 1.26 * s - 3.516 * s ** 2 + 2.843 * s ** 3 - 1.036 * s ** 4) / 0.6)
        pts.append((s * chord, h))
    upper = pts
    lower = [(x, -y) for x, y in reversed(pts[1:-1])]
    ring = upper + lower
    cx = chord * kamm / 2
    return [(x - cx, y) for x, y in ring]


def ellipse(a, b, n=20):
    return [(a * math.cos(2 * math.pi * i / n), b * math.sin(2 * math.pi * i / n)) for i in range(n)]


def sweep(bm, a, b, profile_a, profile_b=None, lead=Vector((1, 0, 0)), side=Vector((0, 1, 0)), cap=True):
    """A tube from a to b: profile (u along `lead`, v along `side`, both made square to the axis)."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    s = (side - d * side.dot(d)).normalized()
    u = s.cross(d).normalized()
    if u.dot(lead) < 0:
        u = -u
    rings = []
    for c, prof in ((a, profile_a), (b, profile_b or profile_a)):
        rings.append([bm.verts.new(c + u * x + s * y) for x, y in prof])
    n = len(rings[0])
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[1])
    return rings


def path_tube(bm, points, r, n=12):
    """A round tube through several points (bars, chain stays of the cockpit)."""
    pts = [Vector(p) for p in points]
    rings = []
    for k, p in enumerate(pts):
        d = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        s = d.cross(ref).normalized()
        u = s.cross(d).normalized()
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * i / n) + s * math.sin(2 * math.pi * i / n)) * r) for i in range(n)])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])


def lathe(bm, profile, centre, segments=64, axis='Y'):
    """Surface of revolution about the axle (Y): profile is (radius, y) points."""
    rings = []
    for k in range(segments):
        a = 2 * math.pi * k / segments
        rings.append([bm.verts.new(centre + Vector((r * math.cos(a), y, r * math.sin(a)))) for r, y in profile])
    n = len(profile)
    for k in range(segments):
        r0, r1 = rings[k], rings[(k + 1) % segments]
        for i in range(n - 1):
            bm.faces.new((r0[i], r1[i], r1[i + 1], r0[i + 1]))


def disc(bm, centre, r_out, r_in, y0, y1, segments=48):
    lathe(bm, [(r_in, y0), (r_out, y0), (r_out, y1), (r_in, y1), (r_in, y0)], centre, segments)


def box(bm, centre, size, rot=Matrix.Identity(3)):
    r = bmesh.ops.create_cube(bm, size=1.0)
    m = Matrix.Translation(centre) @ rot.to_4x4() @ Matrix.Diagonal((*size, 1))
    bmesh.ops.transform(bm, matrix=m, verts=r['verts'])


def blob(bm, centre, size, segs=16):
    r = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=segs // 2, radius=1.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(centre) @ Matrix.Diagonal((*size, 1)), verts=r['verts'])


# ---------- parts ----------

def frame():
    """Aero tubes, fork and dropouts, fused by a voxel remesh into one smooth shell."""
    bm = bmesh.new()
    fwd, up = Vector((1, 0, 0)), Vector((0, 0, 1))
    down_lead = Vector((0.7, 0, -0.7))
    sweep(bm, BB + Vector((0.02, 0, 0)), HT_BOT + Vector((0.005, 0, -0.02)), airfoil(0.085, 0.046), airfoil(0.075, 0.044), lead=down_lead)
    sweep(bm, BB, ST_TOP + SEAT_UP * 0.03, airfoil(0.07, 0.032), airfoil(0.058, 0.03), lead=fwd)
    sweep(bm, ST_TOP + Vector((0.0, 0, -0.025)), HT_TOP + Vector((0.0, 0, -0.03)), ellipse(0.024, 0.016), ellipse(0.03, 0.017), lead=up)
    sweep(bm, HT_TOP + HEAD_DOWN * -0.01, HT_BOT + HEAD_DOWN * 0.012, airfoil(0.08, 0.044), airfoil(0.09, 0.046), lead=fwd)
    # BB shell
    disc(bm, BB, 0.024, 0.0, -0.043, 0.043, 24)
    for side in (-1, 1):
        y = Vector((0, side, 0))
        sweep(bm, BB + y * 0.03 + Vector((-0.02, 0, 0)), REAR + y * 0.062 + Vector((0.012, 0, 0)), ellipse(0.024, 0.012), ellipse(0.013, 0.008), lead=up)
        ss = BB + SEAT_UP * 0.40
        sweep(bm, ss + y * 0.012 + Vector((-0.015, 0, 0)), REAR + y * 0.062 + Vector((0.006, 0, 0.012)), airfoil(0.032, 0.013), airfoil(0.018, 0.01), lead=Vector((-1, 0, 1)))
        box(bm, REAR + y * 0.064 + Vector((0.006, 0, 0.004)), (0.032, 0.008, 0.03))  # dropout
        # fork blades
        crown = HT_BOT + HEAD_DOWN * 0.03
        sweep(bm, crown + y * 0.03, FRONT + y * 0.053 + Vector((0, 0, 0.01)), airfoil(0.05, 0.022), airfoil(0.03, 0.015), lead=fwd)
        box(bm, FRONT + y * 0.055, (0.026, 0.008, 0.026))
    blob(bm, HT_BOT + HEAD_DOWN * 0.02, (0.045, 0.05, 0.03))  # fork crown
    o = new_object('FrameRaw', bm, PAINT)
    rm = o.modifiers.new('Remesh', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = 0.0028
    sm = o.modifiers.new('Smooth', 'CORRECTIVE_SMOOTH')
    sm.iterations = 6
    dec = o.modifiers.new('Decimate', 'DECIMATE')
    dec.ratio = 0.12
    bpy.context.view_layer.objects.active = o
    for m in ('Remesh', 'Smooth', 'Decimate'):
        bpy.ops.object.modifier_apply(modifier=m)
    paint(o.data, PAINT)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def seatpost_saddle(bm_carbon, bm_black):
    top = BB + SEAT_UP * 0.705
    sweep(bm_carbon, ST_TOP, top, airfoil(0.04, 0.024), lead=Vector((1, 0, 0)))
    clamp = top + Vector((0.0, 0, 0.012))
    box(bm_black, clamp, (0.05, 0.03, 0.018))
    for side in (-1, 1):
        path_tube(bm_black, [clamp + Vector((-0.07, side * 0.02, 0.008)), clamp + Vector((0.07, side * 0.02, 0.008))], 0.0035, 8)
    # saddle shell: sections along x (nose forward)
    xs = [-0.13, -0.11, -0.07, -0.02, 0.03, 0.08, 0.12, 0.14]
    half = [0.068, 0.07, 0.062, 0.042, 0.024, 0.018, 0.016, 0.01]
    thick = [0.03, 0.032, 0.03, 0.028, 0.026, 0.024, 0.022, 0.016]
    base = Vector((clamp.x - 0.005, 0, clamp.z + 0.016))
    secs = []
    for x, w, t in zip(xs, half, thick):
        ring = []
        for i in range(16):
            a = 2 * math.pi * i / 16
            y, z = math.cos(a) * w, math.sin(a) * t / 2
            z += 0.012 if z > 0 else 0  # a flat top above the rails
            ring.append(bm_black.verts.new(base + Vector((x, y, z + t / 2))))
        secs.append(ring)
    for r0, r1 in zip(secs, secs[1:]):
        for i in range(16):
            j = (i + 1) % 16
            bm_black.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm_black.faces.new(list(reversed(secs[0])))
    bm_black.faces.new(secs[-1])


def cockpit(bm_carbon, bm_black):
    """Integrated one-piece aero bar and stem, drops, hoods and bar tape."""
    spacer_top = HT_TOP - HEAD_DOWN * 0.045
    sweep(bm_carbon, HT_TOP, spacer_top, airfoil(0.062, 0.04), lead=Vector((1, 0, 0)))  # spacers / top cap
    stem_end = spacer_top + Vector((0.11, 0, 0.0))
    sweep(bm_carbon, spacer_top + Vector((-0.012, 0, 0)), stem_end, ellipse(0.016, 0.022), lead=Vector((0, 0, 1)), side=Vector((0, 1, 0)))
    # flat aero tops out to the corners, then forward to the hoods and down into the drops
    for side in (-1, 1):
        y = side
        top_end = stem_end + Vector((0.015, y * 0.19, 0))
        sweep(bm_carbon, stem_end + Vector((0, y * 0.005, 0)), top_end, airfoil(0.034, 0.012), lead=Vector((1, 0, 0)), side=Vector((0, 0, 1)))
        corner = [top_end, top_end + Vector((0.04, y * 0.012, 0.002)), top_end + Vector((0.07, y * 0.02, 0.0))]
        hood_base = corner[-1]
        drop = [hood_base, hood_base + Vector((0.03, 0, -0.02)), hood_base + Vector((0.04, 0, -0.06)), hood_base + Vector((0.025, 0, -0.105)),
                hood_base + Vector((-0.01, 0, -0.125)), hood_base + Vector((-0.07, 0, -0.13))]
        path_tube(bm_black, corner + drop[1:], 0.0125, 12)  # bar tape over the bends
        # hood (lever body): from the bar forward, with a raised top the palm rests on
        h0 = hood_base + Vector((0.0, 0, 0.012))
        box(bm_black, h0 + Vector((0.025, 0, 0.018)), (0.06, 0.03, 0.04))
        blob(bm_black, h0 + Vector((0.052, 0, 0.03)), (0.016, 0.015, 0.018), 12)
        path_tube(bm_black, [h0 + Vector((0.05, 0, 0.005)), h0 + Vector((0.06, 0, -0.05)), h0 + Vector((0.045, 0, -0.1))], 0.006, 8)  # lever
    # computer mount
    box(bm_black, stem_end + Vector((0.05, 0, 0.008)), (0.06, 0.05, 0.012))


def drivetrain(frame_bm_metal, parent):
    """ChainRing node (chainrings, spider, crank arms) with the pedals; chain and derailleurs on the frame."""
    ring = bmesh.new()
    disc(ring, Vector(), 0.105, 0.085, -0.047, -0.043, 64)     # 52T
    disc(ring, Vector(), 0.088, 0.07, -0.040, -0.036, 64)      # 36T
    for k in range(4):  # spider
        a = math.pi / 4 + k * math.pi / 2
        box(ring, Vector((math.cos(a) * 0.045, -0.042, math.sin(a) * 0.045)), (0.08, 0.008, 0.016), Matrix.Rotation(-a, 3, 'Y'))
    disc(ring, Vector(), 0.022, 0.0, -0.07, 0.07, 24)          # spindle
    for side, sign in ((-1, 1), (1, -1)):  # right arm forward, left arm back
        a = Vector((0, side * 0.062, 0))
        b = Vector((sign * CRANK, side * 0.07, 0))
        sweep(ring, a, b, ellipse(0.014, 0.009), ellipse(0.011, 0.008), lead=Vector((0, 0, 1)), side=Vector((0, 1, 0)))
    bmesh.ops.translate(ring, vec=BB, verts=ring.verts[:])
    cr = new_object('ChainRing', ring, METAL, parent, BB)
    for name, side, sign in (('RightPedal', -1, 1), ('LeftPedal', 1, -1)):
        p = bmesh.new()
        c = BB + Vector((sign * CRANK, side * 0.105, 0))
        box(p, c + Vector((0, side * 0.01, 0)), (0.09, 0.06, 0.016))
        disc(p, c, 0.006, 0.0, -0.035, 0.035, 12)
        new_object(name, p, BLACK, cr, c)
    # chain: top run to the cassette, bottom run through the rear derailleur
    y = -0.045
    cas_top = REAR + Vector((0, y, 0.026))
    path_tube(frame_bm_metal, [BB + Vector((0, y, 0.105)), cas_top], 0.0035, 6)
    jockey = REAR + Vector((0.01, -0.05, -0.075))
    path_tube(frame_bm_metal, [REAR + Vector((0, y, -0.026)), jockey, BB + Vector((0, y, -0.105))], 0.0035, 6)
    box(frame_bm_metal, REAR + Vector((0.0, -0.058, -0.04)), (0.02, 0.012, 0.075), Matrix.Rotation(math.radians(-15), 3, 'Y'))  # rear derailleur
    box(frame_bm_metal, BB + SEAT_UP * 0.2 + Vector((0.025, -0.04, 0)), (0.045, 0.012, 0.02))  # front derailleur
    return cr


def wheel(name, centre, rear, parent):
    w = bmesh.new()
    tyre = [(R_TYRE - 0.028 + 0.028 * (1 - math.cos(a)) / 2, 0.0145 * math.sin(a)) for a in [math.pi * i / 10 for i in range(11)]]
    lathe(w, [(R_TYRE - 0.03, 0.0)] + [(r, y) for r, y in tyre[1:]] + [(R_TYRE - 0.03, 0.0)], centre, 72)
    hub_r = 0.02
    new_object(name + '_tyre', w, RUBBER, None)
    rim = bmesh.new()
    lathe(rim, [(0.317, 0.0125), (0.300, 0.0138), (0.285, 0.013), (0.27, 0.009), (0.266, 0.0), (0.27, -0.009), (0.285, -0.013), (0.300, -0.0138), (0.317, -0.0125)], centre, 72)
    disc(rim, centre, hub_r, 0.006, -0.05, 0.05, 20)  # hub
    for y in (-0.03, 0.03):
        disc(rim, centre, 0.028, 0.0, y - 0.003, y + 0.003, 20)  # flanges
    for k in range(24):
        a = 2 * math.pi * k / 24
        y = 0.03 if k % 2 else -0.03
        p0 = centre + Vector((math.cos(a) * 0.026, y, math.sin(a) * 0.026))
        p1 = centre + Vector((math.cos(a + 0.12) * 0.268, 0, math.sin(a + 0.12) * 0.268))
        sweep(rim, p0, p1, ellipse(0.0022, 0.0009, 4), lead=Vector((math.cos(a), 0, math.sin(a))).cross(Vector((0, 1, 0))))
    rim_o = new_object(name + '_rim', rim, RIM, None)
    metal = bmesh.new()
    disc(metal, centre, 0.08, 0.06, 0.052, 0.054, 48)   # disc rotor (left side)
    for k in range(6):
        a = k * math.pi / 3
        box(metal, centre + Vector((math.cos(a) * 0.04, 0.053, math.sin(a) * 0.04)), (0.045, 0.002, 0.008), Matrix.Rotation(-a, 3, 'Y'))
    if rear:
        for k in range(11):  # cassette, 11-30
            r = 0.023 + 0.0027 * k
            y = -0.06 + 0.0036 * k
            disc(metal, centre, r, 0.015, y, y + 0.0018, 32)
    metal_o = new_object(name + '_metal', metal, METAL, None)
    tyre_o = bpy.data.objects[name + '_tyre']
    o = join([tyre_o, rim_o, metal_o], name)
    o.data.transform(Matrix.Translation(-centre))
    o.location = centre
    o.parent = parent
    return o


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = o.data.name = name
    return o


def brakes(bm_black):
    # flat-mount calipers on the left (non-drive) side, at the rotors
    box(bm_black, REAR + Vector((0.035, 0.062, 0.06)), (0.05, 0.02, 0.03), Matrix.Rotation(math.radians(-30), 3, 'Y'))
    box(bm_black, FRONT + Vector((-0.045, 0.062, 0.05)), (0.05, 0.02, 0.03), Matrix.Rotation(math.radians(40), 3, 'Y'))


def decal(frame_obj, text='GRUPPETTO', size=0.034, at=0.47):
    """The name on both sides of the down tube, read from the bottom bracket up on the drive side and
    left to right on the other; laid onto the tube surface by a shrinkwrap."""
    a = BB + Vector((0.02, 0, 0))
    b = HT_BOT + Vector((0.005, 0, -0.02))
    d = (b - a).normalized()
    centre = a.lerp(b, at)
    objs = []
    for out in (Vector((0, -1, 0)), Vector((0, 1, 0))):
        x = d if out.y < 0 else -d
        y = out.cross(x)
        if y.z < 0:
            x, y = -x, -y
        cu = bpy.data.curves.new('Decal', 'FONT')
        cu.body = text
        cu.size = size
        cu.align_x, cu.align_y = 'CENTER', 'CENTER'
        o = bpy.data.objects.new('Decal', cu)
        bpy.context.scene.collection.objects.link(o)
        o.matrix_world = Matrix.Translation(centre + out * 0.03) @ Matrix((x, y, out)).transposed().to_4x4()
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.convert(target='MESH')
        o = bpy.context.view_layer.objects.active
        sw = o.modifiers.new('Wrap', 'SHRINKWRAP')
        sw.target = frame_obj
        sw.wrap_method = 'NEAREST_SURFACEPOINT'
        sw.wrap_mode = 'OUTSIDE_SURFACE'
        sw.offset = 0.0008
        bpy.ops.object.modifier_apply(modifier='Wrap')
        paint(o.data, DECAL)
        objs.append(o)
    return objs


def main():
    bpy.ops.wm.read_homefile(use_empty=True)
    root = bpy.data.objects.new('AeroBike', None)
    bpy.context.scene.collection.objects.link(root)

    fr = frame()
    carbon, black, metal = bmesh.new(), bmesh.new(), bmesh.new()
    seatpost_saddle(carbon, black)
    cockpit(carbon, black)
    brakes(black)
    drivetrain(metal, root)
    parts = [fr, *decal(fr), new_object('Carbon', carbon, CARBON), new_object('Black', black, BLACK), new_object('FrameMetal', metal, METAL)]
    body = join(parts, 'Frame')
    body.parent = root
    wheel('BackWheel', REAR, True, root)
    wheel('FrontWheel', FRONT, False, root)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(OUT), export_format='GLB', use_selection=True, export_yup=True,
                              export_vertex_color='NONE', export_animations=False)
    OUT.with_suffix('.json').write_text(json.dumps({'wheelRadius': R_TYRE}) + '\n')
    faces = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH')
    print(f'{OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1e6:.2f} MB, {faces} faces')


if __name__ == '__main__':
    main()
