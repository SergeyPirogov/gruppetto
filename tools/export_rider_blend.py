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
BODY_PARTS = ['MH_Body', 'MH_Eyebrows', 'MH_Eyelashes', 'MH_Eyes', 'MH_Hair', 'MH_Jersey',
              'MH_JerseyPockets', 'MH_Shoes', 'MH_Shorts']
HEAD_GEAR = ['Helmet', 'HelmetStraps', 'HelmetBuckle', 'StrapSlider_R', 'StrapSlider_L', 'Glasses', 'GlassesEnds']
DECIMATE = {'Helmet': 0.25, 'Glasses': 0.06}        # ratio of the source mesh
SUBSURF = {'MH_Body': 0, 'MH_Jersey': 1, 'MH_JerseyPockets': 0}  # levels used for the game
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
    ob = bpy.data.objects.new('X_' + src.name.replace('MH_', ''), me)
    sc.collection.objects.link(ob)
    for vg in src.vertex_groups:
        ob.vertex_groups.new(name=vg.name)
    ob.parent = rig
    ob.matrix_world = src.matrix_world.copy()
    mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = rig
    return ob


def match_pose(ob, src, rig):
    """Make the game show exactly what Blender shows in the riding pose.

    Blender deforms with preserve volume, any number of bones and modifiers after the armature
    (OverShorts, Thick); the game skins linearly with the 4 strongest bones. So the rest shape of
    the export copy is solved backwards from Blender's posed mesh: rest = (sum w*S)^-1 @ posed, with
    the same top-4 normalised weights the glTF exporter writes. Call with the rig in POSE.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    ev = src.evaluated_get(dg)
    tm = ev.to_mesh()
    n = len(ob.data.vertices)
    if len(tm.vertices) != n:
        ev.to_mesh_clear()
        print('match_pose: vertex count differs, skipped', src.name)
        return
    mw = src.matrix_world
    target = np.array([tuple(mw @ v.co) for v in tm.vertices])
    ev.to_mesh_clear()
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
    for v in ob.data.vertices:
        ws = sorted(((g.weight, g.group) for g in v.groups if g.group in skin and g.weight > 0), reverse=True)[:4]
        tot = sum(w for w, _ in ws)
        if tot <= 0:
            out[v.index] = tuple(v.co)
            continue
        M = sum((w / tot) * skin[gi] for w, gi in ws)
        r = np.linalg.solve(M, np.append(target[v.index], 1.0))
        out[v.index] = (obwi @ (r / r[3]))[:3]
    ob.data.vertices.foreach_set('co', out.ravel())
    ob.data.update()


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


def run():
    assert bpy.data.filepath, 'open blender/rider_male.blend first'
    bpy.ops.wm.save_mainfile()
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    rig = O[RIG]
    sc.frame_set(FRAMES[0])

    # 1. textures
    set_engine_cycles()
    body_img = save_jpeg(bake_object(O['MH_Body'], 2048, 'rider_body'), 'rider_body')
    shoe_img = save_jpeg(bake_object(O['MH_Shoes'], 1024, 'rider_shoes'), 'rider_shoes')
    kit_img = save_jpeg(bake_kit_mask(O['MH_Jersey'], 1024, 'rider_kit'), 'rider_kit', 95)
    pocket_img = save_jpeg(bake_kit_mask(O['MH_JerseyPockets'], 512, 'rider_pockets'), 'rider_pockets', 95)
    mats = {
        'MH_Body': textured_material('Skin', body_img, src=bpy.data.materials['Skin.001']),
        'MH_Shoes': textured_material('Shoes', shoe_img, rough=0.35),
        'MH_Jersey': textured_material('JerseyMask', kit_img, rough=0.45),
        'MH_JerseyPockets': textured_material('PocketsMask', pocket_img, rough=0.45),
    }
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
    for n in HEAD_GEAR:
        copies.append(gear_copy(O[n]))
    bpy.ops.object.select_all(action='DESELECT')
    for ob in copies + [rig]:
        ob.hide_set(False); ob.select_set(True)
    bpy.context.view_layer.objects.active = rig
    opts = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_apply=False,
                export_skins=True, export_def_bones=True, export_animations=True, export_animation_mode='ACTIONS',
                export_anim_slide_to_zero=True, export_force_sampling=True, export_morph=False,
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
        'jerseyMaterials': ['-'], 'shortsMaterials': ['-'],
        'sleeve': False, 'sockHeight': False, 'armSlim': 1, 'helmet': False, 'glasses': False,
    }
    with open(OUT_CFG, 'w') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    size = os.path.getsize(OUT_GLB)
    # back to the saved file: nothing above is kept in the .blend
    bpy.ops.wm.revert_mainfile()
    return f'{OUT_GLB}: {size / 1e6:.1f} MB'


print(run())
