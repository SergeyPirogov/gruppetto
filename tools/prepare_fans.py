#!/usr/bin/env python3
"""Copies the people for the crowds at the tops of climbs (#45) out of Quaternius' Universal Base
Characters (Standard, CC0): the female body and a few hairstyles, as glTF without textures (the
fans are painted with plain colours in the app, so the 1–4 MB textures stay out).

    python3 tools/prepare_fans.py "<unzipped 'Universal Base Characters[Standard]' folder>"

Download: https://quaternius.itch.io/universal-base-characters (Standard is free, CC0).
"""
import json, pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'fans'
FILES = [
    ('Base Characters/Godot - UE', 'Superhero_Female_FullBody', 'female'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Hair_Long', 'hair_long'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Hair_Buns', 'hair_buns'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Hair_SimpleParted', 'hair_parted'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Hair_Buzzed', 'hair_buzzed'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Hair_Beard', 'beard'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Eyebrows_Female', 'brows_female'),
    ('Hairstyles/Origin at 0/glTF (Godot)', 'Eyebrows_Regular', 'brows_male'),
]

def main(src):
    src = pathlib.Path(src)
    OUT.mkdir(parents=True, exist_ok=True)
    for folder, name, out in FILES:
        g = json.loads((src / folder / f'{name}.gltf').read_text())
        for b in g.get('buffers', []):
            uri = b['uri']
            shutil.copy(src / folder / uri, OUT / f'{out}.bin')
            b['uri'] = f'{out}.bin'
        # no textures: drop images, textures and samplers, and the material slots that pointed at them
        for k in ('images', 'textures', 'samplers'):
            g.pop(k, None)
        for m in g.get('materials', []):
            pbr = m.get('pbrMetallicRoughness', {})
            for k in ('baseColorTexture', 'metallicRoughnessTexture'):
                pbr.pop(k, None)
            for k in ('normalTexture', 'occlusionTexture', 'emissiveTexture'):
                m.pop(k, None)
        (OUT / f'{out}.gltf').write_text(json.dumps(g, separators=(',', ':')))
        print('wrote', OUT / f'{out}.gltf')

if __name__ == '__main__':
    main(sys.argv[1])
