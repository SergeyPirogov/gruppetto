"""The standing (out of the saddle) pose of a Blender rider, kept as data in the .blend.

Run headless on blender/rider_<figure>.blend:
    blender -b blender/rider_male.blend --python tools/stand_pose.py -- <command> [args]

Commands:
    author DX DZ PELVIS SPINE1 SPINE2 SPINE3 NECK HEAD AMP [save]
        From the seated pose, raise the rider DZ m and move him DX m forward (bike space: x forward, z up),
        roll the pelvis and spine forward by the given degrees (neck and head back up, negative), and store
        the result on MH_Rig as "standPose" (JSON: bone -> loc, rot) with the seated values as "seatPose" and
        the bike rock as "standRock" ({"amp": radians, "phase": radians}). With "save", saves the .blend.
    measure [on]        feet, hands and hip height over one crank turn (seated, or standing with "on")
    render DIR [on]     Workbench renders (side, front, rear) at frames 1, 5, 9, 13

The exporter imports apply_pose() and rock_at() from here, so the game gets exactly what is measured.
The bike rock: roll = amp * sin(crank + phase) about the tyre contact line (+ = the bike leans right).
The clip is baked in bike space, so the rider is rolled the other way about that line here; the game rolls
the whole group (bike and rider) by +roll, which puts the bike over and the rider back near upright.
"""
import bpy, json, math, sys
from mathutils import Matrix, Vector

RIG = 'MH_Rig'
POSE_BONES = ['Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'clavicle_r']
FRAMES = (1, 17)
O = bpy.data.objects
sc = bpy.context.scene


def rig():
    return O[RIG]


def crank_angle():
    """The crank angle at the current frame (ChainRing's spin, 0..2pi over one clip)."""
    return O['ChainRing'].rotation_euler[1]


def rock_at(amp, phase, angle):
    return amp * math.sin(angle + phase)


def _values(r):
    return {n: {'loc': list(r.pose.bones[n].location), 'rot': list(r.pose.bones[n].rotation_quaternion)} for n in POSE_BONES}


def _set(r, vals):
    for n, v in vals.items():
        pb = r.pose.bones[n]
        pb.rotation_mode = 'QUATERNION'
        pb.location = v['loc']
        pb.rotation_quaternion = v['rot']
    bpy.context.view_layer.update()


def _world_to_arm(r):
    return r.matrix_world.inverted()


def _turn(r, name, axis_world, deg, about=None):
    """Turn a pose bone by deg about a world axis through its head (or `about`)."""
    pb = r.pose.bones[name]
    bpy.context.view_layer.update()
    w2a = _world_to_arm(r)
    head = (r.matrix_world @ pb.head) if about is None else about
    axis = (w2a.to_3x3() @ Vector(axis_world)).normalized()
    pivot = w2a @ head
    R = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(deg), 4, axis) @ Matrix.Translation(-pivot)
    pb.matrix = R @ pb.matrix
    bpy.context.view_layer.update()


def _move(r, name, world_delta):
    pb = r.pose.bones[name]
    bpy.context.view_layer.update()
    d = _world_to_arm(r).to_3x3() @ Vector(world_delta)
    m = pb.matrix.copy()
    m.translation += d
    pb.matrix = m
    bpy.context.view_layer.update()


def author(dx, dz, pelvis, s1, s2, s3, neck, head, amp):
    r = rig()
    for n in POSE_BONES:
        r.pose.bones[n].rotation_mode = 'QUATERNION'
    seat = _values(r)
    lateral = (0, 1, 0)  # the bike's side axis: a positive turn pitches the bone's tail down and forward
    _move(r, 'Root', (dx, 0, dz))
    for n, deg in (('pelvis', pelvis), ('spine_01', s1), ('spine_02', s2), ('spine_03', s3), ('neck_01', neck), ('head', head)):
        _turn(r, n, lateral, deg)
    stand = _values(r)
    _set(r, seat)
    r['seatPose'] = json.dumps(seat)
    r['standPose'] = json.dumps(stand)
    # left pedal forward (power stroke of the left leg) -> the bike leans right; the phase is fixed by
    # measuring where the left pedal is at crank angle 0
    r['standRock'] = json.dumps({'amp': amp, 'phase': _left_forward_phase()})


def _left_forward_phase():
    """Phase so that sin(angle + phase) = 1 where the left pedal is level and forward."""
    best, best_a = -1e9, 0.0
    for f in range(FRAMES[0], FRAMES[1]):
        sc.frame_set(f)
        x = O['PedalPt.L'].matrix_world.translation.x - O['ChainRing'].matrix_world.translation.x
        if x > best:
            best, best_a = x, crank_angle()
    sc.frame_set(FRAMES[0])
    return math.pi / 2 - best_a


def apply_pose(on, frame_rock=True):
    """Seated (on=False) or standing pose; standing also rolls the rider for the bike rock at this frame."""
    r = rig()
    key = 'standPose' if on else 'seatPose'
    if key not in r:  # not authored yet: the .blend's own (seated) pose
        return
    _set(r, json.loads(r[key]))
    if on and frame_rock and 'standRock' in r:
        k = json.loads(r['standRock'])
        roll = rock_at(k['amp'], k['phase'], crank_angle())
        _turn(r, 'Root', (1, 0, 0), -math.degrees(roll), about=Vector((0, 0, 0)))  # the rider, opposite to the bike


def measure(on):
    r = rig()
    out = {'feet_mm': 0.0, 'hands_mm': 0.0, 'hip_lift_m': None}
    sc.frame_set(FRAMES[0]); apply_pose(False)
    hip0 = (r.matrix_world @ r.pose.bones['pelvis'].head).z
    for f in range(FRAMES[0], FRAMES[1] + 1):
        sc.frame_set(f)
        apply_pose(on)
        bpy.context.view_layer.update()
        W = r.matrix_world
        for s, S in (('l', 'L'), ('r', 'R')):
            ankle = W @ r.pose.bones['calf_' + s].tail
            out['feet_mm'] = max(out['feet_mm'], (ankle - O['AnkleT.' + S].matrix_world.translation).length * 1000)
            wrist = W @ r.pose.bones['lowerarm_' + s].tail
            out['hands_mm'] = max(out['hands_mm'], (wrist - O['HandT.' + S].matrix_world.translation).length * 1000)
        lift = (W @ r.pose.bones['pelvis'].head).z - hip0
        out['hip_lift_m'] = lift if out['hip_lift_m'] is None else min(out['hip_lift_m'], lift)
    sc.frame_set(FRAMES[0]); apply_pose(False)
    return {k: round(v, 4) for k, v in out.items()}


def render(outdir, on):
    import os
    os.makedirs(outdir, exist_ok=True)
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = 800, 800
    cd = bpy.data.cameras.new('standcam'); cd.type = 'ORTHO'; cd.ortho_scale = 2.0
    cam = bpy.data.objects.new('standcam', cd); sc.collection.objects.link(cam); sc.camera = cam
    views = {'side': ((0.1, -4, 0.85), (math.pi / 2, 0, 0)), 'front': ((4, 0, 0.85), (math.pi / 2, 0, math.pi / 2)),
             'rear': ((-4, 0, 0.85), (math.pi / 2, 0, -math.pi / 2))}
    for f in (1, 5, 9, 13):
        sc.frame_set(f); apply_pose(on)
        for name, (loc, rot) in views.items():
            cam.location, cam.rotation_euler = loc, rot
            sc.render.filepath = os.path.join(outdir, f'{"stand" if on else "seat"}_{name}_{f:02d}.png')
            bpy.ops.render.render(write_still=True)


if __name__ == '__main__' and '--' in sys.argv:
    a = sys.argv[sys.argv.index('--') + 1:]
    cmd = a[0]
    if cmd == 'author':
        author(*map(float, a[1:10]))
        print('STANDPOSE', measure(True))
        if len(a) > 10 and a[10] == 'save':
            bpy.ops.wm.save_mainfile(); print('SAVED')
    elif cmd == 'measure':
        print('MEASURE', measure(len(a) > 1 and a[1] == 'on'))
    elif cmd == 'render':
        render(a[1], len(a) > 2 and a[2] == 'on')
