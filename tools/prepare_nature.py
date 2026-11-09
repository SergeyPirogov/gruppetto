"""Copies the scenery models PowerUp uses out of Quaternius' Stylized Nature MegaKit (CC0).

Usage (macOS, uses `sips` to resize textures):
    python3 tools/prepare_nature.py "<unzipped MegaKit folder>"

Download: https://opengameart.org/content/stylized-nature-megakit (Standard, free, CC0).
Writes assets/nature/: the glTF models with their texture references stripped (the app makes
its own materials so it can tint leaves per route) and the textures resized for the web.
"""
import json
import pathlib
import shutil
import subprocess
import sys

MODELS = [
    'CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5',
    'Pine_1', 'Pine_2', 'Pine_3', 'Pine_4', 'Pine_5',
    'Bush_Common', 'Bush_Common_Flowers',
    'Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3',
    'Grass_Common_Short', 'Grass_Wispy_Short',
    'Flower_3_Single', 'Flower_4_Single', 'Clover_1',
    'Fern_1', 'Mushroom_Common',
    'Flower_3_Group', 'Flower_4_Group', 'Grass_Common_Tall', 'Grass_Wispy_Tall', 'Plant_1', 'Plant_7',
    'Pebble_Round_1', 'Pebble_Round_2', 'Pebble_Round_3',
]
# texture -> max size in px. Tree leaves use the coloured (_C) maps: the app keeps their light and
# shade and swaps the hue for the route's palette (green meadow, orange autumn...).
TEXTURES = {
    'Bark_NormalTree.png': 512, 'Leaves_NormalTree_C.png': 512, 'Leaf_Pine_C.png': 512,
    'Leaves_TwistedTree_C.png': 512, 'Leaves.png': 512, 'Flowers.png': 512, 'Grass.png': 256,
    'Rocks_Diffuse.png': 512, 'Mushrooms.png': 256, 'PathRocks_Diffuse.png': 256,
}

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'nature'


def main(src):
    src = pathlib.Path(src)
    gltf_dir = src / 'glTF'
    OUT.mkdir(parents=True, exist_ok=True)
    for name in MODELS:
        g = json.loads((gltf_dir / f'{name}.gltf').read_text())
        for key in ('images', 'textures', 'samplers'):
            g.pop(key, None)
        for m in g.get('materials', []):
            pbr = m.get('pbrMetallicRoughness', {})
            pbr.pop('baseColorTexture', None)
            pbr.pop('metallicRoughnessTexture', None)
            for key in ('normalTexture', 'occlusionTexture', 'emissiveTexture'):
                m.pop(key, None)
        for buf in g['buffers']:
            shutil.copy(gltf_dir / buf['uri'], OUT / buf['uri'])
        (OUT / f'{name}.gltf').write_text(json.dumps(g, separators=(',', ':')))
    tex_out = OUT / 'textures'
    tex_out.mkdir(exist_ok=True)
    for name, size in TEXTURES.items():
        subprocess.run(['sips', '-Z', str(size), str(src / 'Textures' / name), '--out', str(tex_out / name)],
                       check=True, capture_output=True)
    shutil.copy(src / 'License_Standard.txt', OUT / 'LICENSE.txt')
    print(f'Wrote {len(MODELS)} models and {len(TEXTURES)} textures to {OUT}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
