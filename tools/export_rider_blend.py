"""Export the Blender-built rider (blender/rider_male.blend) to the game: assets/riders/male.glb + male.json.

Run inside Blender with the .blend open (Text Editor > Run Script, or through the Blender MCP):
    exec(open('/path/to/gruppetto/tools/export_rider_blend.py').read())

What it does, without touching the saved .blend (it reverts the file at the end):
  1. Bakes the procedural materials into textures (Cycles, diffuse colour only):
       skin + aero socks -> one body texture, shoes (with their sock cuff) -> one texture,
       jersey and pockets -> a kit MASK (red = main colour, green = accent; the rest is the zip),
       so the game paints every rider's kit in their own colours.
  2. Bakes one crank revolution of the pedalling (IK + drivers follow ChainRing) into the
     armature action "pedal_cycle" (frames 1..17 at 24 fps = 90 rpm).
  3. Applies every modifier except the armature in the rest pose, then solves the rest shape back
     from Blender's posed mesh (match_pose) so the game's 4-bone linear skinning shows exactly what
     Blender shows; simplifies the helmet and glasses, and exports the skinned rider, its head gear and the clip as a GLB.
  4. Writes male.json: where the model sits relative to the game's bike (bottom bracket at
     x 0, y 0.29) and the switches that make the game play the clip in step with the cranks.
"""
import bpy, os, json
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(bpy.data.filepath)))
OUT_GLB = os.path.join(REPO, 'assets', 'riders', 'male.glb')
OUT_CFG = os.path.join(REPO, 'assets', 'riders', 'male.json')
TMP = os.path.join(bpy.app.tempdir, 'rider_bake')
os.makedirs(TMP, exist_ok=True)

RIG = 'MH_Rig'
BODY_PARTS = ['MH_Body_v2', 'MH_Eyebrows', 'MH_Eyelashes', 'MH_Eyes', 'MH_Hair', 'MH_Jersey',
              'MH_JerseyPockets', 'MH_Shoes', 'MH_Shorts']
CLEATS = {'Cleat.L': 'foot_l', 'Cleat.R': 'foot_r'}   # shoe cleats, parented to the foot bones
HEAD_GEAR = ['Helmet', 'HelmetStraps', 'HelmetBuckle', 'StrapSlider_R', 'StrapSlider_L', 'Glasses']
DECIMATE = {'Helmet': 0.25}                         # ratio of the source mesh
SUBSURF = {'MH_Body_v2': 1, 'MH_Jersey': 1, 'MH_JerseyPockets': 1}  # levels used for the game
MORPH_PARTS = ['MH_Body_v2', 'MH_Jersey', 'MH_JerseyPockets', 'MH_Shorts']  # get per-frame shape keys (pockets too, or they slide on the jersey)
TUCK = {'MH_Body_v2'}                               # skin kept inside the kit in the game (see tuck)
KIT_OVER_SKIN = ['MH_Jersey', 'MH_Shorts']
TUCK_GAP = 0.0015                                   # skin at least 1.5 mm under the cloth
TUCK_REACH = 0.012                                  # only skin within 12 mm of the cloth
MORPH_STEP = 2                                     # a key every 2nd frame of the clip, blended between
MORPH_EPS = 0.0003                                  # deltas under 0.3 mm dropped (sparse in the GLB)
FRAMES = (1, 17)                                    # one crank turn (ChainRing keyed 0..2pi over 1..17)
BIKE_BB = (0.0, 0.29)                               # bottom bracket in the game's rider group (x, y)
HAIR_RGB = (0.075, 0.068, 0.062)                    # hair and eyebrow colour (sRGB, near black); None keeps the texture

O = bpy.data.objects
sc = bpy.context.scene


def principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def set_engine_cycles():
    try:
        sc.render.engine = 'CYCLES'
    except TypeError as e:
        raise RuntimeError(f'Cycles is needed for baking: {e}')
    sc.cycles.samples = 1
    sc.cycles.use_denoising = False
    sc.render.bake.margin = 8


def bake_object(obj, size, name):
    """Diffuse colour of every material of `obj` into one image (its UVs must not overlap)."""
    img = bpy.data.images.new(name, size, size, alpha=False)
    nodes = []
    for slot in obj.material_slots:
        nt = slot.material.node_tree
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = img
        nt.nodes.active = n; nodes.append((nt, n))
    bpy.ops.object.select_all(action='DESELECT')
    obj.hide_set(False); obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_clear=True)
    for nt, n in nodes:
        nt.nodes.remove(n)
    return img


def save_jpeg(img, name, quality=90):
    path = os.path.join(TMP, name + '.jpg')
    img.filepath_raw = path
    img.file_format = 'JPEG'
    img.save()  # raw pixels (save_render would add the scene's view transform)
    out = bpy.data.images.load(path, check_existing=False)
    out.name = name
    return out


def pixels(img):
    a = np.empty(len(img.pixels), np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def bake_kit_mask(obj, size, name):
    """Red = jersey main colour, green = accent, black = zip (the game mixes its own colours in)."""
    nt = bpy.data.materials['Jersey'].node_tree
    main, accent, zip_ = (nt.nodes[n].outputs[0] for n in ('J_32', 'J_33', 'J_34'))
    keep = [tuple(s.default_value) for s in (main, accent, zip_)]
    try:
        main.default_value, accent.default_value, zip_.default_value = (1, 1, 1, 1), (0, 0, 0, 1), (0, 0, 0, 1)
        a = pixels(bake_object(obj, size, name + '_a'))
        main.default_value, accent.default_value = (0, 0, 0, 1), (1, 1, 1, 1)
        b = pixels(bake_object(obj, size, name + '_b'))
    finally:
        main.default_value, accent.default_value, zip_.default_value = keep
    img = bpy.data.images.new(name, size, size, alpha=False)
    out = np.zeros_like(a)
    out[:, 0], out[:, 1], out[:, 3] = a[:, 0], b[:, 0], 1
    img.pixels.foreach_set(out.ravel())
    return img


def fill_uvs(*objs):
    """Stretch the objects' UV layout over the whole texture, the same box for all of them.

    The kit's UVs use only about a quarter of the image, so the baked mask had few pixels across the
    zip and the collar and sleeve edges (jagged in the game). The kit colours are procedural, so the
    layout itself does not matter in Blender; the file is reverted after the export anyway.
    """
    uvs = []
    for ob in objs:
        a = np.empty(len(ob.data.loops) * 2, np.float32)
        ob.data.uv_layers.active.data.foreach_get('uv', a)
        uvs.append(a.reshape(-1, 2))
    lo, hi = np.min([u.min(0) for u in uvs], 0), np.max([u.max(0) for u in uvs], 0)
    pad = 0.01
    for ob, u in zip(objs, uvs):
        u = pad + (u - lo) / (hi - lo) * (1 - 2 * pad)
        ob.data.uv_layers.active.data.foreach_set('uv', u.ravel())
        ob.data.update()


def textured_material(name, img, rough=0.6, alpha=False, src=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = principled(m)
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if alpha:
        nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
        m.surface_render_method = 'BLENDED'
    b.inputs['Roughness'].default_value = rough
    if src is not None:
        sb = principled(src)
        b.inputs['Roughness'].default_value = sb.inputs['Roughness'].default_value
    return m


def image_of(mat, prefer='diffuseTexture'):
    nodes = [n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
    named = [n for n in nodes if n.name == prefer]
    return (named or nodes)[0].image if nodes else None


def tinted(img, rgb):
    """A copy of a hair texture recoloured to rgb: its light and dark kept, its own colour dropped."""
    import numpy as np
    w, h = img.size
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], np.float32)
    seen = px[:, 3] > 0.5
    mean = float(lum[seen].mean()) if seen.any() else 1.0
    k = np.clip(lum / max(mean, 1e-4), 0.0, 2.5)[:, None]
    px[:, :3] = np.clip(k * np.array(rgb, np.float32), 0.0, 1.0)
    out = bpy.data.images.new(img.name + '_tint', w, h, alpha=True)
    out.colorspace_settings.name = img.colorspace_settings.name
    out.pixels.foreach_set(px.ravel())
    out.filepath_raw = os.path.join(TMP, img.name.rsplit('.', 1)[0] + '_tint.png'); out.file_format = 'PNG'; out.save()
    return out


def rest_copy(src, rig):
    """The mesh with every modifier but the armature applied in the rest pose, re-skinned to the rig."""
    arm = [m for m in src.modifiers if m.type == 'ARMATURE']
    for m in arm:
        m.show_viewport = False
    for m in src.modifiers:
        if m.type == 'SUBSURF' and src.name in SUBSURF:
            m.levels = SUBSURF[src.name]
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(src.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    for m in arm:
        m.show_viewport = True
    if me.shape_keys:
        pass
    ob = bpy.data.objects.new('X_' + src.name.replace('MH_', '').replace('_v2', ''), me)
    sc.collection.objects.link(ob)
    for vg in src.vertex_groups:
        ob.vertex_groups.new(name=vg.name)
    ob.parent = rig
    ob.matrix_world = src.matrix_world.copy()
    mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = rig
    return ob


def match_pose(ob, src, rig):
    res = solve_rest(ob, src, rig, normals=True)
    if res is None:
        return
    out, nrm = res
    ob.data.vertices.foreach_set('co', out.ravel())
    ob.data.update()
    if nrm is not None:
        # after the positions: custom normals are kept relative to the mesh's own shape
        ob.data.normals_split_custom_set([tuple(n) for n in nrm])
        ob.data.update()


def pose_morphs(copies, rig):
    """Per-frame corrections as shape keys, keyed into the "pedal_cycle" action.

    match_pose makes the game exact in one pose only; as the legs go round, linear skinning drifts
    from Blender's preserve volume (the seat and the hips most). For every MORPH_STEP-th frame of the
    clip the rest shape is solved again and stored as a shape key that is on (1) at that frame and
    off at its neighbours, so the game blends the right shape in between. Small deltas are zeroed,
    so the exporter can write them as sparse accessors.
    """
    act = rig.animation_data.action
    frames = list(range(FRAMES[0], FRAMES[1] + 1, MORPH_STEP))
    if frames[-1] != FRAMES[1]:
        frames.append(FRAMES[1])
    for src_name, ob in copies:
        if src_name not in MORPH_PARTS:
            continue
        src = O[src_name]
        base = np.array([tuple(v.co) for v in ob.data.vertices])
        ob.shape_key_add(name='Basis', from_mix=False)
        keys = []
        for f in frames[1:]:
            sc.frame_set(f)
            out = solve_rest(ob, src, rig)
            if out is None:
                break
            d = out - base
            d[np.linalg.norm(d, axis=1) < MORPH_EPS] = 0
            kb = ob.shape_key_add(name='f%02d' % f, from_mix=False)
            kb.data.foreach_set('co', (base + d).ravel())
            kb.slider_min, kb.slider_max = 0.0, 1.0
            keys.append((f, kb))
        sc.frame_set(FRAMES[0])
        if not keys:
            continue
        key = ob.data.shape_keys
        ad = key.animation_data_create()
        ad.action = act
        slot = act.slots.new(id_type='KEY', name=ob.name)
        ad.action_slot = slot
        for i, (f, kb) in enumerate(keys):
            prev = frames[i]                                   # neighbour frames: the key is 0 there
            nxt = frames[i + 2] if i + 2 < len(frames) else None
            for fr, val in ((prev, 0.0), (f, 1.0)) + (((nxt, 0.0),) if nxt else ()):
                kb.value = val
                kb.keyframe_insert('value', frame=fr)
        kb.value = 0.0
        for fc in act_fcurves(act, slot):
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'


def act_fcurves(act, slot):
    try:
        return list(act.layers[0].strips[0].channelbag(slot).fcurves)
    except Exception:
        return [fc for fc in getattr(act, 'fcurves', [])]


def tuck(target, dg):
    """Keep the skin TUCK_GAP inside the kit in the game.

    The body goes out at a lower subdivision than Blender shows it, and a coarser cage stands
    proud of the smooth surface on convex parts (shoulders, upper back) by a few mm: enough for
    the skin to show through the jersey. So every skin vertex close under (or poking through)
    the jersey or shorts is pushed back in along the cloth's normal.
    """
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    out = target.copy()
    for name in KIT_OVER_SKIN:
        cloth = O[name]
        tree = BVHTree.FromObject(cloth.evaluated_get(dg), dg)
        mw, mi = cloth.matrix_world, cloth.matrix_world.inverted()
        rot = mw.to_3x3()
        for i, p in enumerate(out):
            q = mi @ Vector(p)
            loc, nrm, _, dist = tree.find_nearest(q, TUCK_REACH)
            if loc is None:
                continue
            s = (q - loc).dot(nrm)                      # > 0: skin outside the cloth
            side = ((q - loc) - nrm * s).length         # > 0: nearest point is the cloth's edge, not over the skin
            if s > -TUCK_GAP and side < 0.001:
                n = (rot @ nrm).normalized()
                out[i] = tuple(Vector(p) - n * (s + TUCK_GAP) * mw.to_scale()[0])
    return out


def solve_rest(ob, src, rig, normals=False):
    """Make the game show exactly what Blender shows in the riding pose.

    Blender deforms with preserve volume, any number of bones and modifiers after the armature
    (OverShorts, Thick); the game skins linearly with the 4 strongest bones. So the rest shape of
    the export copy is solved backwards from Blender's posed mesh: rest = (sum w*S)^-1 @ posed, with
    the same top-4 normalised weights the glTF exporter writes. Call with the rig in POSE.

    normals=True also returns the rest corner normals that skin back to Blender's posed normals
    (the game turns a normal by the blended skin matrix): the solved rest shape is sheared where
    the weights change from bone to bone, and normals worked out from it would shade the riding
    pose with dark blotches (lower back, under the pockets). Returns (rest, normals) then.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    ev = src.evaluated_get(dg)
    tm = ev.to_mesh()
    n = len(ob.data.vertices)
    if len(tm.vertices) != n:
        ev.to_mesh_clear()
        print('match_pose: vertex count differs, skipped', src.name)
        return None
    mw = src.matrix_world
    target = np.array([tuple(mw @ v.co) for v in tm.vertices])
    cn = lv = None
    if normals and len(tm.loops) == len(ob.data.loops):
        cn = np.empty(len(tm.loops) * 3)
        tm.corner_normals.foreach_get('vector', cn)
        cn = cn.reshape(-1, 3) @ np.array(mw.to_3x3()).T
        lv = np.empty(len(tm.loops), dtype=np.int64)
        tm.loops.foreach_get('vertex_index', lv)
    ev.to_mesh_clear()
    if src.name in TUCK:
        target = tuck(target, dg)
    bones = rig.data.bones
    names = [vg.name for vg in ob.vertex_groups]
    skin = {}
    for i, nm in enumerate(names):
        b = bones.get(nm)
        if b is None or not b.use_deform:
            continue
        S = rig.matrix_world @ rig.pose.bones[nm].matrix @ b.matrix_local.inverted() @ rig.matrix_world.inverted()
        skin[i] = np.array(S)
    obw = ob.matrix_world
    obwi = np.array(obw.inverted())
    out = np.empty((n, 3))
    inv3 = np.tile(np.eye(3), (n, 1, 1))  # per vertex: posed -> rest for directions
    for v in ob.data.vertices:
        ws = sorted(((g.weight, g.group) for g in v.groups if g.group in skin and g.weight > 0), reverse=True)[:4]
        tot = sum(w for w, _ in ws)
        if tot <= 0:
            out[v.index] = tuple(v.co)
            continue
        M = sum((w / tot) * skin[gi] for w, gi in ws)
        r = np.linalg.solve(M, np.append(target[v.index], 1.0))
        out[v.index] = (obwi @ (r / r[3]))[:3]
        inv3[v.index] = np.linalg.inv(M[:3, :3])
    if not normals:
        return out
    if cn is None:
        return out, None
    nr = np.einsum('lij,lj->li', inv3[lv], cn) @ obwi[:3, :3].T
    nr /= np.maximum(np.linalg.norm(nr, axis=1, keepdims=True), 1e-9)
    return out, nr


def gear_copy(src):
    for m in src.modifiers:
        if m.type == 'DECIMATE' and src.name in DECIMATE:
            m.ratio = DECIMATE[src.name]
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(src.evaluated_get(dg), preserve_all_data_layers=False, depsgraph=dg)
    ob = bpy.data.objects.new('X_' + src.name, me)
    sc.collection.objects.link(ob)
    ob.parent = src.parent; ob.parent_type = src.parent_type; ob.parent_bone = src.parent_bone
    ob.matrix_parent_inverse = src.matrix_parent_inverse.copy()
    ob.matrix_basis = src.matrix_basis.copy()
    return ob


def cleat_copy(src, rig, bone):
    """A cleat parented straight to its foot bone (its Sole empty is not exported), kept where it is now."""
    me = src.data.copy()
    ob = bpy.data.objects.new('X_' + src.name.replace('.', '_'), me)
    sc.collection.objects.link(ob)
    mw = src.matrix_world.copy()
    ob.parent = rig; ob.parent_type = 'BONE'; ob.parent_bone = bone
    bpy.context.view_layer.update()
    ob.matrix_world = mw
    return ob


def pedal_tilt():
    """How the drive-side pedal tilts over one crank turn, fitted as [mean, cos, sin] in degrees.

    In Blender the pedals copy the soles' pitch (toe down near the bottom of the stroke); the game turns
    the bike's pedals by the same angle (js/bike-model.js), left pedal half a turn later. Positive = toe
    down; the crank angle is that of the clip (0 at frame FRAMES[0]).
    """
    ped = O['RightPedal']
    rows, vals = [], []
    n = FRAMES[1] - FRAMES[0]
    for f in range(FRAMES[0], FRAMES[1]):
        sc.frame_set(f)
        a = 2 * np.pi * (f - FRAMES[0]) / n
        rows.append((1, np.cos(a), np.sin(a)))
        vals.append(np.degrees(ped.matrix_world.to_euler().y))
    sc.frame_set(FRAMES[0])
    k = np.linalg.lstsq(np.array(rows), np.array(vals), rcond=None)[0]
    return [round(float(x), 2) for x in k]


def run():
    assert bpy.data.filepath, 'open blender/rider_male.blend first'
    bpy.ops.wm.save_mainfile()
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    rig = O[RIG]
    sc.frame_set(FRAMES[0])

    # 1. textures
    set_engine_cycles()
    body_img = save_jpeg(bake_object(O['MH_Body_v2'], 2048, 'rider_body'), 'rider_body')
    shoe_img = save_jpeg(bake_object(O['MH_Shoes'], 1024, 'rider_shoes'), 'rider_shoes')
    fill_uvs(O['MH_Jersey'])
    # parts hidden from render in the .blend stay out of the game (e.g. the pockets, switched off)
    BODY_PARTS[:] = [n for n in BODY_PARTS if not O[n].hide_render]
    kit_img = save_jpeg(bake_kit_mask(O['MH_Jersey'], 2048, 'rider_kit'), 'rider_kit', 95)
    pocket_img = None
    if 'MH_JerseyPockets' in BODY_PARTS:
        fill_uvs(O['MH_JerseyPockets'])
        pocket_img = save_jpeg(bake_kit_mask(O['MH_JerseyPockets'], 1024, 'rider_pockets'), 'rider_pockets', 95)
    mats = {
        'MH_Body_v2': textured_material('Skin', body_img, src=bpy.data.materials['Skin.001']),
        'MH_Shoes': textured_material('Shoes', shoe_img, rough=0.35),
        'MH_Jersey': textured_material('JerseyMask', kit_img, rough=0.45),
    }
    if pocket_img:
        mats['MH_JerseyPockets'] = textured_material('PocketsMask', pocket_img, rough=0.45)
    for part, mname in (('MH_Hair', 'Hair'), ('MH_Eyebrows', 'Eyebrows'), ('MH_Eyelashes', 'Eyelashes'), ('MH_Eyes', 'Eyes')):
        src = O[part].material_slots[0].material
        img = image_of(src) if part != 'MH_Eyebrows' else image_of(src, 'bumpmapTexture')
        if HAIR_RGB and part in ('MH_Hair', 'MH_Eyebrows'):
            img = tinted(img, HAIR_RGB)
        mats[part] = textured_material(mname, img, alpha=part != 'MH_Eyes', src=src)
    shorts = bpy.data.materials['Shorts.001'].copy(); shorts.name = 'Shorts'
    mats['MH_Shorts'] = shorts

    # 2. the pedalling clip
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True); bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.nla.bake(frame_start=FRAMES[0], frame_end=FRAMES[1], only_selected=True, visual_keying=True,
                     clear_constraints=False, use_current_action=False, bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.animation_data.action.name = 'pedal_cycle'
    sc.frame_set(FRAMES[0])

    # 3. export copies
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    copies = []
    for n in BODY_PARTS:
        ob = rest_copy(O[n], rig)
        ob.data.materials.clear(); ob.data.materials.append(mats[n])
        for p in ob.data.polygons: p.material_index = 0
        copies.append(ob)
    rig.data.pose_position = 'POSE'
    bpy.context.view_layer.update()
    for n, ob in zip(BODY_PARTS, copies):
        match_pose(ob, O[n], rig)
    pose_morphs(list(zip(BODY_PARTS, copies)), rig)
    for n in HEAD_GEAR:
        copies.append(gear_copy(O[n]))
    sc.frame_set(FRAMES[0])
    for n, bone in CLEATS.items():
        copies.append(cleat_copy(O[n], rig, bone))
    bpy.ops.object.select_all(action='DESELECT')
    for ob in copies + [rig]:
        ob.hide_set(False); ob.select_set(True)
    bpy.context.view_layer.objects.active = rig
    opts = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_apply=False,
                export_skins=True, export_def_bones=True, export_animations=True, export_animation_mode='ACTIONS',
                export_anim_slide_to_zero=True, export_force_sampling=True, export_morph=True, export_morph_normal=False, export_morph_animation=True,
                export_yup=True, export_image_format='AUTO', export_cameras=False, export_lights=False,
                export_extras=False)
    bpy.ops.export_scene.gltf(**opts)

    # 4. where it sits on the game's bike, and how the game should use it
    cr = O['ChainRing'].matrix_world.translation
    cfg = {
        'asModelled': True,                        # no rescaling, no re-tailoring: the model is final
        'offset': [round(BIKE_BB[0] - cr.x, 4), round(BIKE_BB[1] - cr.z, 4), 0],
        'rotateY': 0,
        'clipFollowsCrank': True,                  # clip time = crank angle (one turn = one clip)
        'kitMask': ['JerseyMask', 'PocketsMask'],  # red = jersey colour, green = accent (stripe)
        'kitZip': '#1a1a1a',
        'helmetMaterials': ['Helmet main'], 'lensMaterials': ['Glasses lens'],  # recoloured per rider
        'jerseyMaterials': ['-'], 'shortsMaterials': ['-'],
        'sleeve': False, 'sockHeight': False, 'armSlim': 1, 'helmet': False, 'glasses': False,
        'pedalTilt': pedal_tilt(),                 # the bike's pedals follow the soles, as in Blender
    }
    with open(OUT_CFG, 'w') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    size = os.path.getsize(OUT_GLB)
    # back to the saved file: nothing above is kept in the .blend
    bpy.ops.wm.revert_mainfile()
    return f'{OUT_GLB}: {size / 1e6:.1f} MB'


print(run())
