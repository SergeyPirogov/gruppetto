"""Makes the rider's head (face, helmet, glasses and straps in one stylized model) web-sized.

Usage (macOS, uses `sips`):
    python3 tools/prepare_head.py "<downloaded .glb>"

The source is the "Stylized Cycling Helmet" from the Summer Engine asset store (a text-to-3D model
of a head wearing a road helmet and glasses). Its 4096 px PNG texture is shrunk to a 1024 px JPEG;
the geometry is kept as is. Writes assets/rider/head.glb; js/dummy-rider.js puts it on the
mannequin in place of its own head.
"""
import json
import pathlib
import struct
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'rider' / 'head.glb'
SIZE = 1024


def read_glb(path):
    b = path.read_bytes()
    magic, _version, _length = struct.unpack('<III', b[:12])
    assert magic == 0x46546C67, 'not a GLB file'
    n, kind = struct.unpack('<II', b[12:20])
    gltf = json.loads(b[20:20 + n])
    off = 20 + n
    bn, _bkind = struct.unpack('<II', b[off:off + 8])
    return gltf, b[off + 8: off + 8 + bn]


def write_glb(path, gltf, binary):
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    binary += b'\0' * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, total)
                     + struct.pack('<II', len(js), 0x4E4F534A) + js
                     + struct.pack('<II', len(binary), 0x004E4942) + binary)


def main(src):
    gltf, binary = read_glb(pathlib.Path(src))
    images = {im['bufferView']: i for i, im in enumerate(gltf.get('images', [])) if 'bufferView' in im}
    out = bytearray()
    with tempfile.TemporaryDirectory() as tmp:
        for k, view in enumerate(gltf['bufferViews']):
            data = binary[view.get('byteOffset', 0): view.get('byteOffset', 0) + view['byteLength']]
            if k in images:  # shrink the texture
                src_img, dst_img = pathlib.Path(tmp) / f'{k}.png', pathlib.Path(tmp) / f'{k}.jpg'
                src_img.write_bytes(data)
                subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', str(SIZE),
                                str(src_img), '--out', str(dst_img)], check=True, capture_output=True)
                data = dst_img.read_bytes()
                gltf['images'][images[k]]['mimeType'] = 'image/jpeg'
            out += b'\0' * (-len(out) % 4)
            view['byteOffset'] = len(out)
            view['byteLength'] = len(data)
            view.pop('byteStride', None) if k in images else None
            out += data
    gltf['buffers'] = [{'byteLength': len(out)}]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    write_glb(OUT, gltf, bytes(out))
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
