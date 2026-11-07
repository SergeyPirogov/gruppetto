"""Copies the rider character out of Quaternius' Universal Base Characters (Standard, CC0).

Usage (macOS, uses `sips` to resize textures):
    python3 tools/prepare_rider.py "<unzipped 'Universal Base Characters[Standard]' folder>" [male|female] [light|dark] [hair,...]

hair: comma-separated hairstyle files from Hairstyles/Rigged to Head Bone (default Hair_Buzzed,Hair_Beard);
they are listed in rider.json "attach" and tinted with "hairColor" in the app.

Download: https://quaternius.itch.io/universal-base-characters (Standard is free, CC0).
Writes assets/rider/rider.gltf + rider.bin and web-sized base-colour textures. Normal and roughness
maps are dropped: the scenery is flat-shaded too, and they would add ~8 MB.
"""
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'rider'
SIZES = {'Superhero': 1024}  # body texture; everything else 256


def main(src, body='male', skin='light', hair='Hair_Buzzed,Hair_Beard'):
    src = pathlib.Path(src)
    base = src / 'Base Characters' / 'Godot - UE'
    name = f'Superhero_{body.capitalize()}_FullBody'
    g = json.loads((base / f'{name}.gltf').read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    for b in g['buffers']:
        shutil.copy(base / b['uri'], OUT / 'rider.bin')
        b['uri'] = 'rider.bin'
    # keep only base-colour textures
    keep_tex = set()
    for m in g['materials']:
        m.pop('normalTexture', None)
        pbr = m.get('pbrMetallicRoughness', {})
        pbr.pop('metallicRoughnessTexture', None)
        if 'baseColorTexture' in pbr:
            keep_tex.add(pbr['baseColorTexture']['index'])
    tex_map, images, textures = {}, [], []
    for old in sorted(keep_tex):
        t = dict(g['textures'][old])
        img = g['images'][t['source']]
        uri = img['uri'].replace('_png.png', '.png')
        size = next((s for k, s in SIZES.items() if k in uri), 256)
        path = base / uri
        if skin == 'light' and '_Dark' in uri:  # the light skin maps sit in the shared Textures folder
            light = [p for p in (src / 'Base Characters' / 'Textures').glob(uri.split('_Dark')[0] + '_Ligh*')]
            if light:
                path = light[0]
        out_name = 'body.png' if 'Superhero' in uri else pathlib.Path(uri).stem + '.png'
        subprocess.run(['sips', '-Z', str(size), str(path), '--out', str(OUT / out_name)], check=True, capture_output=True)
        images.append({'uri': out_name, **({'mimeType': img['mimeType']} if 'mimeType' in img else {})})
        t['source'] = len(images) - 1
        tex_map[old] = len(textures)
        textures.append(t)
    g['images'], g['textures'] = images, textures
    for m in g['materials']:
        pbr = m.get('pbrMetallicRoughness', {})
        if 'baseColorTexture' in pbr:
            pbr['baseColorTexture']['index'] = tex_map[pbr['baseColorTexture']['index']]
    (OUT / 'rider.gltf').write_text(json.dumps(g, separators=(',', ':')))
    shutil.copy(src / 'License_Standard.txt', OUT / 'LICENSE.txt')
    # hairstyles, rigged to the head bone of the same skeleton; their greyscale texture is tinted in the app
    hair_dir = src / 'Hairstyles' / 'Rigged to Head Bone' / 'glTF (Godot -Unreal)'
    for h in filter(None, hair.split(',')):
        hg = json.loads((hair_dir / f'{h}.gltf').read_text())
        for b in hg['buffers']:
            shutil.copy(hair_dir / b['uri'], OUT / b['uri'])
        for m in hg['materials']:
            m.pop('normalTexture', None)
        keep = {t['source'] for m in hg['materials'] for t in [m.get('pbrMetallicRoughness', {}).get('baseColorTexture')] if t for t in [hg['textures'][t['index']]]}
        for i, im in enumerate(hg['images']):
            name = pathlib.Path(im['uri'].replace('_png.png', '.png')).stem + '.png'
            if i in keep and not (OUT / name).exists():
                subprocess.run(['sips', '-Z', '512', str(src / 'Hairstyles' / 'Textures' / name), '--out', str(OUT / name)], check=True, capture_output=True)
            im['uri'] = name
        (OUT / f'{h}.gltf').write_text(json.dumps(hg, separators=(',', ':')))
    print(f'Wrote {OUT / "rider.gltf"} ({body}, {skin} skin) with {len(images)} textures')


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3, 4, 5):
        sys.exit(__doc__)
    main(*sys.argv[1:])
