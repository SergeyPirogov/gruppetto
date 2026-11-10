"""Builds the realistic riders (male and female) with MPFB 2 (MakeHuman for Blender, CC0 assets).

Runs inside Blender, in the background (the open scene is not touched):
    /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/prepare_mpfb_riders.py -- [male] [female]

Needs the MPFB 2 extension (extensions.blender.org, "mpfb") and its CC0 asset packs loaded into it:
"MakeHuman system assets" (makehuman_system_assets_cc0.zip) and "Skins 02" (skins02_cc0.zip), from
https://static.makehumancommunity.org/assets/assetpacks.html (MPFB: Apply assets -> Load pack).

Each rider is an athletic body on the MPFB "game_engine" skeleton (pelvis, thigh_l, calf_l, ball_l,
upperarm_l ...) in a T-pose with the palms down, as the app expects, with:
  - Body (skin texture), Eyes, Eyebrows, Eyelashes, Hair, Shoes (white socks included);
  - Jersey and Shorts cut from the body surface (tight lycra, plain colours the app repaints per rider);
    the skin under them is removed so it cannot poke through.
Writes assets/riders/<gender>.glb (WebP textures). The output is CC0 like its sources.
"""
import math
import os
import pathlib
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import addon_utils

MPFB = 'bl_ext.user_default.mpfb'
if not addon_utils.check(MPFB)[1]:
    addon_utils.enable(MPFB, default_set=False)
from bl_ext.user_default.mpfb.services.assetservice import AssetService  # noqa: E402 (needs the add-on enabled)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402
from bl_ext.user_default.mpfb.services.targetservice import TargetService  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'riders'

RIDERS = {
    'male': {
        'macro': {'gender': 1.0, 'age': 0.5, 'muscle': 0.95, 'weight': 0.32, 'height': 0.62, 'proportions': 1.0},
        'targets': {
            'torso/torso-vshape-incr': 0.55, 'torso/torso-muscle-dorsi-incr': 0.4, 'torso/torso-muscle-pectoral-incr': 0.3,
            'torso/measure-waist-circ-decr': 0.4,
            'legs/l-upperleg-muscle-incr': 0.7, 'legs/r-upperleg-muscle-incr': 0.7,
            'legs/l-lowerleg-muscle-incr': 0.7, 'legs/r-lowerleg-muscle-incr': 0.7,
            'arms/l-upperarm-shoulder-muscle-incr': 0.35, 'arms/r-upperarm-shoulder-muscle-incr': 0.35,
            'arms/l-upperarm-muscle-incr': 0.3, 'arms/r-upperarm-muscle-incr': 0.3,
            'arms/l-lowerarm-muscle-incr': 0.3, 'arms/r-lowerarm-muscle-incr': 0.3,
        },
        'skin': 'young_caucasian_male', 'hair': 'short02', 'eyebrows': 'eyebrow001',
    },
    'female': {
        'macro': {'gender': 0.0, 'age': 0.5, 'muscle': 0.8, 'weight': 0.3, 'height': 0.55, 'proportions': 1.0},
        'targets': {
            'torso/torso-vshape-incr': 0.2, 'torso/measure-waist-circ-decr': 0.3,
            'legs/l-upperleg-muscle-incr': 0.6, 'legs/r-upperleg-muscle-incr': 0.6,
            'legs/l-lowerleg-muscle-incr': 0.6, 'legs/r-lowerleg-muscle-incr': 0.6,
            'arms/l-upperarm-shoulder-muscle-incr': 0.2, 'arms/r-upperarm-shoulder-muscle-incr': 0.2,
        },
        'skin': 'young_caucasian_female', 'hair': 'ponytail01', 'eyebrows': 'eyebrow010',
    },
}
SHOES = 'shoes05'          # white trainers with white socks
JERSEY_OFFSET, SHORTS_OFFSET = 0.007, 0.004  # m off the skin
SLEEVE = 0.46              # of the upper arm
SHORTS_LEG = 0.68          # of the thigh
COLLAR_R = 0.072           # crew neck radius around the neck axis, m
ARM = ('upperarm', 'lowerarm', 'hand', 'index', 'middle', 'ring', 'pinky', 'thumb')
LEG = ('thigh', 'calf', 'foot', 'ball')
MESHES = ('Body', 'Eyes', 'Eyebrows', 'Eyelashes', 'Hair', 'Shoes', 'Jersey', 'Shorts')


def asset(kind, stem):
    found = AssetService.list_mhmat_assets(kind) if kind == 'skins' else AssetService.list_mhclo_assets(kind)
    for p in found:
        if p.stem == stem:
            return str(p)
    raise SystemExit(f'MPFB asset {kind}/{stem} not found: load the asset packs first (see the docstring)')


def select_only(o):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = o
    o.select_set(True)


def bake_basemesh(o):
    """Shape keys and the helper/hidden-vertex masks applied: a plain mesh with its final shape."""
    select_only(o)
    if o.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    for md in list(o.modifiers):
        if md.type == 'MASK':
            bpy.ops.object.modifier_apply(modifier=md.name)


def bone_heads(rig):
    return {b.name: rig.matrix_world @ b.head_local for b in rig.data.bones}


def limb_weights(v, dl, names):
    arm = {'l': 0.0, 'r': 0.0}
    leg = {'l': 0.0, 'r': 0.0}
    for gi, w in v[dl].items():
        n = names.get(gi, '')
        if n.endswith(('_l', '_r')):
            if n.startswith(ARM):
                arm[n[-1]] += w
            elif n.startswith(LEG):
                leg[n[-1]] += w
    return arm, leg


def largest_piece_only(b):
    seen, parts = set(), []
    for v in b.verts:
        if v in seen:
            continue
        stack, comp = [v], []
        seen.add(v)
        while stack:
            x = stack.pop()
            comp.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        parts.append(comp)
    parts.sort(key=len)
    bmesh.ops.delete(b, geom=[v for c in parts[:-1] for v in c], context='VERTS')


def cut_garment(src, rig, name, planes, keep, offset, local=None):
    """A copy of the body cut by planes (clean straight hems), keeping the vertices `keep` accepts."""
    o = src.copy()
    o.data = src.data.copy()
    o.name = o.data.name = name
    for c in src.users_collection:
        c.objects.link(o)
    names = {g.index: g.name for g in o.vertex_groups}
    b = bmesh.new()
    b.from_mesh(o.data)
    for co, no, only_local in planes:
        faces = [f for f in b.faces if local(f.calc_center_median())] if only_local else b.faces[:]
        geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + list(faces)
        bmesh.ops.bisect_plane(b, geom=geom, plane_co=co, plane_no=no.normalized(), dist=1e-5)
    dl = b.verts.layers.deform.active
    bmesh.ops.delete(b, geom=[v for v in b.verts if not keep(v.co, *limb_weights(v, dl, names))], context='VERTS')
    largest_piece_only(b)
    bmesh.ops.remove_doubles(b, verts=b.verts[:], dist=1e-5)
    for v in b.verts:
        v.co += v.normal * offset
    b.to_mesh(o.data)
    b.free()
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (0.05, 0.3, 0.85, 1) if name == 'Jersey' else (0.02, 0.02, 0.025, 1)
    bsdf.inputs['Roughness'].default_value = 0.55
    o.data.materials.clear()
    o.data.materials.append(mat)
    for p in o.data.polygons:
        p.use_smooth = True
    o.parent = rig
    for md in list(o.modifiers):
        if md.type == 'ARMATURE':
            md.object = rig
        else:
            o.modifiers.remove(md)
    return o


def make_kit(src, rig):
    H = bone_heads(rig)
    pel_z = H['pelvis'].z

    def frac(p, s, a, b):
        A, B = H[f'{a}_{s}'], H[f'{b}_{s}']
        d = B - A
        return (p - A).dot(d) / d.length_squared

    def across(s, a, b, t):
        A, B = H[f'{a}_{s}'], H[f'{b}_{s}']
        return (A + (B - A) * t, (B - A).normalized(), False)

    # crew neck: a cylinder round the neck axis (moved forward: the neck bone sits near the back of the
    # neck), above a base plane that is lower in front than at the back
    ax = (H['head'] - H['neck_01']).normalized()
    a0 = H['neck_01'] + Vector((0, -0.02, 0))
    u = ax.cross(Vector((1, 0, 0))).normalized()
    w = ax.cross(u).normalized()
    front = Vector((0, -1, 0))
    front = (front - ax * front.dot(ax)).normalized()
    base_p, base_n = a0 + ax * -0.035, (ax + front * 0.6).normalized()

    def neck(p):
        q = p - a0
        t = q.dot(ax)
        return t, (q - ax * t).length

    def near_neck(c):
        t, r = neck(c)
        return t > -0.12 and r < COLLAR_R * 1.8

    n_sides = 32
    hem_z = pel_z + 0.03
    planes = [(Vector((0, 0, hem_z)), Vector((0, 0, 1)), False)] + [across(s, 'upperarm', 'lowerarm', SLEEVE) for s in 'lr']
    for i in range(n_sides):
        d = u * math.cos(2 * math.pi * i / n_sides) + w * math.sin(2 * math.pi * i / n_sides)
        planes.append((a0 + d * COLLAR_R, d, True))
    planes.append((base_p, base_n, True))

    def keep_jersey(p, arm, leg):
        s = 'l' if p.x > 0 else 'r'
        if p.z < hem_z - 1e-4:
            return False
        if arm[s] > 0.3 and frac(p, s, 'upperarm', 'lowerarm') > SLEEVE + 1e-4:
            return False
        t, r = neck(p)
        if (p - base_p).dot(base_n) > 1e-4 and r < COLLAR_R * math.cos(math.pi / n_sides) - 1e-4:
            return False
        return t <= 0.02

    jersey = cut_garment(src, rig, 'Jersey', planes, keep_jersey, JERSEY_OFFSET, near_neck)

    top_z = pel_z + 0.11  # under the jersey

    def keep_shorts(p, arm, leg):
        s = 'l' if p.x > 0 else 'r'
        if p.z > top_z + 1e-4 or max(arm.values()) > 0.3:  # the hands hang below the waist in the A-pose
            return False
        return not (leg[s] > 0.3 and frac(p, s, 'thigh', 'calf') > SHORTS_LEG + 1e-4)

    shorts = cut_garment(src, rig, 'Shorts', [(Vector((0, 0, top_z)), Vector((0, 0, 1)), False)]
                         + [across(s, 'thigh', 'calf', SHORTS_LEG) for s in 'lr'], keep_shorts, SHORTS_OFFSET)
    return jersey, shorts


def hide_skin_under(body, garments):
    """Deletes the body faces the garments cover (keeping a margin at the hems)."""
    trees, hems = [], []
    for g in garments:
        b = bmesh.new()
        b.from_mesh(g.data)
        trees.append(BVHTree.FromBMesh(b))
        hems += [v.co.copy() for v in b.verts if v.is_boundary]
        b.free()
    kd = KDTree(len(hems))
    for i, c in enumerate(hems):
        kd.insert(c, i)
    kd.balance()
    b = bmesh.new()
    b.from_mesh(body.data)
    covered = {v: min((t.find_nearest(v.co)[3] or 9) for t in trees) < 0.015 and kd.find(v.co)[2] > 0.02 for v in b.verts}
    bmesh.ops.delete(b, geom=[f for f in b.faces if all(covered[v] for v in f.verts)], context='FACES_ONLY')
    bmesh.ops.delete(b, geom=[v for v in b.verts if not v.link_faces], context='VERTS')
    b.to_mesh(body.data)
    b.free()


def simplify_materials(objs):
    """MPFB routes textures through MixRGB, which glTF drops: texture straight into Base Color; skin and
    shoes opaque, hair / eyebrows / eyelashes alpha-clipped (a Round node reads as glTF MASK)."""
    for name, o in objs.items():
        for slot in o.material_slots:
            m = slot.material
            nt = m.node_tree
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image)
            for link in list(nt.links):
                if link.to_node == bsdf and link.to_socket.name in ('Base Color', 'Alpha', 'Normal'):
                    nt.links.remove(link)
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
            bsdf.inputs['Roughness'].default_value = 0.55 if name == 'Body' else 0.7
            bsdf.inputs['Metallic'].default_value = 0.0
            if name in ('Hair', 'Eyebrows', 'Eyelashes'):
                r = nt.nodes.new('ShaderNodeMath')
                r.operation = 'ROUND'
                nt.links.new(tex.outputs['Alpha'], r.inputs[0])
                nt.links.new(r.outputs[0], bsdf.inputs['Alpha'])
            else:
                bsdf.inputs['Alpha'].default_value = 1.0
            m.name = 'Skin' if name == 'Body' else name
            if tex.image.size[0] > 1024 and name != 'Body':
                tex.image.scale(1024, 1024)


def t_pose(rig, meshes):
    """Arms straight out, palms down, fingers straight (Mixamo-style T-pose), made the rest pose."""
    select_only(rig)
    bpy.ops.object.mode_set(mode='POSE')
    P = rig.pose.bones
    for pb in P:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()

    def align(name, target):
        pb = P[name]
        m = pb.matrix.copy()
        r = (pb.tail - pb.head).normalized().rotation_difference(target.normalized()).to_matrix().to_4x4()
        h = m.to_translation()
        pb.matrix = Matrix.Translation(h) @ r @ Matrix.Translation(-h) @ m
        bpy.context.view_layer.update()

    for s, sx in (('l', 1), ('r', -1)):
        for b in (f'upperarm_{s}', f'lowerarm_{s}', f'hand_{s}'):
            align(b, Vector((sx, 0, 0)))
        for f in ('index', 'middle', 'ring', 'pinky'):
            d = P[f'{f}_01_{s}'].tail - P[f'{f}_01_{s}'].head
            for k in ('01', '02', '03'):
                align(f'{f}_{k}_{s}', Vector((d.x, d.y, 0)))
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in meshes:
        select_only(o)
        am = next(m for m in o.modifiers if m.type == 'ARMATURE')
        bpy.ops.object.modifier_apply(modifier=am.name)
        o.modifiers.new('Armature', 'ARMATURE').object = rig
    select_only(rig)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def build(gender):
    spec = RIDERS[gender]
    bpy.ops.wm.read_homefile(use_empty=True)
    targets = pathlib.Path(LocationService.get_mpfb_data()) / 'targets'
    macro = {**spec['macro'], 'race': {'african': 0.0, 'asian': 0.0, 'caucasian': 1.0}}
    body = HumanService.create_human(macro_detail_dict=macro, feet_on_ground=True, scale=0.1)
    for t, weight in spec['targets'].items():
        TargetService.load_target(body, str(targets / f'{t}.target.gz'), weight=weight)
    HumanService.add_builtin_rig(body, 'game_engine')
    rig = next(m.object for m in body.modifiers if m.type == 'ARMATURE')
    HumanService.set_character_skin(asset('skins', spec['skin']), body, skin_type='MAKESKIN', material_instances=False)
    parts = {}
    for kind, stem, label in (('eyes', 'low-poly', 'Eyes'), ('eyebrows', spec['eyebrows'], 'Eyebrows'),
                              ('eyelashes', 'eyelashes01', 'Eyelashes'), ('hair', spec['hair'], 'Hair'),
                              ('clothes', SHOES, 'Shoes')):
        before = set(bpy.data.objects)
        HumanService.add_mhclo_asset(asset(kind, stem), body, asset_type='Clothes' if kind == 'clothes' else kind.capitalize(),
                                     subdiv_levels=0, material_type='MAKESKIN')
        parts[label] = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
    bake_basemesh(body)
    for o in parts.values():
        bake_basemesh(o)

    jersey, shorts = make_kit(body, rig)
    hide_skin_under(body, (jersey, shorts))
    simplify_materials({'Body': body, **parts})

    objs = {'Body': body, **parts, 'Jersey': jersey, 'Shorts': shorts}
    for name, o in objs.items():
        o.name = o.data.name = name  # plain names: the app recolours anything called like *short* / *top*
        if o.parent != rig:
            mw = o.matrix_world.copy()
            o.parent = rig
            o.matrix_world = mw
    rig.name = rig.data.name = 'RiderRig'
    t_pose(rig, list(objs.values()))

    OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in (*objs.values(), rig):
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    out = OUT / f'{gender}.glb'
    bpy.ops.export_scene.gltf(filepath=str(out), export_format='GLB', use_selection=True, export_skins=True,
                              export_animations=False, export_yup=True, export_image_format='WEBP', export_image_quality=88)
    faces = sum(len(o.data.polygons) for o in objs.values())
    print(f'{out.relative_to(ROOT)}: {out.stat().st_size / 1e6:.1f} MB, {faces} faces')


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for g in args or list(RIDERS):
        build(g)
