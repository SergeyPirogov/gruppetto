#!/usr/bin/env python3
"""Compare power and heart rate in two FIT files of the same kind of ride (e.g. Gruppetto and Zwift).

    python3 tools/compare_fit.py gruppetto.fit zwift.fit [--steps 120,160,200,240] [--skip 60]

Two ways to use it:
  * The same ride recorded twice at once (two apps or a head unit beside the app): the files are lined up
    by clock time and compared second by second.
  * The same ERG workout ridden in each app (docs/erg-check.zwo): with --steps, each file is cut into its
    steady blocks and the blocks are compared: average power against the target, and the heart rate at it.

Only the standard library; reads record messages (power, heart rate, cadence, timestamp).
"""
import argparse
import statistics
import struct
import sys

FIT_EPOCH = 631065600  # 1989-12-31 UTC
BASE = {0: 'B', 1: 'b', 2: 'B', 3: 'h', 4: 'H', 5: 'i', 6: 'I', 7: 's', 8: 'f', 9: 'd', 10: 'B', 11: 'h',
        12: 'H', 13: 'B', 14: 'q', 15: 'Q', 16: 'Q'}
INVALID = {'B': 0xFF, 'b': 0x7F, 'h': 0x7FFF, 'H': 0xFFFF, 'i': 0x7FFFFFFF, 'I': 0xFFFFFFFF}


def records(path):
    """Yield {t, power, hr, cad} for every record message (t in Unix seconds)."""
    data = open(path, 'rb').read()
    hsize = data[0]
    size = struct.unpack_from('<I', data, 4)[0]
    if data[8:12] != b'.FIT':
        sys.exit(f'{path}: not a FIT file')
    pos, end = hsize, hsize + size
    defs, last_t = {}, None
    while pos < end:
        h = data[pos]; pos += 1
        if h & 0x80:  # compressed timestamp header
            local, offset = (h >> 5) & 3, h & 0x1F
            d = defs[local]
            vals, pos = read_fields(data, pos, d)
            if last_t is not None:
                t = (last_t & ~0x1F) + offset
                if t < last_t: t += 0x20
                last_t = t
                vals[253] = t
        elif h & 0x40:  # definition
            local = h & 0x0F
            arch = data[pos + 1]
            endian = '>' if arch == 1 else '<'
            gmsg = struct.unpack_from(endian + 'H', data, pos + 2)[0]
            n = data[pos + 4]; pos += 5
            fields = []
            for _ in range(n):
                num, sz, bt = data[pos], data[pos + 1], data[pos + 2] & 0x1F; pos += 3
                fields.append((num, sz, bt))
            dev = []
            if h & 0x20:
                nd = data[pos]; pos += 1
                for _ in range(nd):
                    dev.append(data[pos + 1]); pos += 3
            defs[local] = {'g': gmsg, 'e': endian, 'f': fields, 'dev': sum(dev)}
            continue
        else:
            d = defs[h & 0x0F]
            vals, pos = read_fields(data, pos, d)
            if 253 in vals and vals[253] is not None: last_t = vals[253]
        if d['g'] == 20 and vals.get(253) is not None:
            yield {'t': vals[253] + FIT_EPOCH, 'power': vals.get(7), 'hr': vals.get(3), 'cad': vals.get(4)}


def read_fields(data, pos, d):
    vals = {}
    for num, sz, bt in d['f']:
        ch = BASE.get(bt, 'B')
        width = struct.calcsize(ch) if ch != 's' else 1
        if ch != 's' and sz == width:
            v = struct.unpack_from(d['e'] + ch, data, pos)[0]
            vals[num] = None if INVALID.get(ch) == v else v
        pos += sz
    return vals, pos + d['dev']


def series(path):
    out = {}
    for r in records(path):
        out[r['t']] = r
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else float('nan')


def summary(name, s):
    p = [r['power'] for r in s.values() if r['power'] is not None]
    hr = [r['hr'] for r in s.values() if r['hr']]
    print(f'{name}: {len(s)} s, power avg {mean(p):.0f} W (no zeros {mean([x for x in p if x > 0]):.0f}), '
          f'HR avg {mean(hr):.0f}, HR missing {sum(1 for r in s.values() if not r["hr"])} s, '
          f'HR jumps >10 bpm/s {hr_jumps(s)}, gaps {gaps(s)}')


def hr_jumps(s):
    ts = sorted(s)
    return sum(1 for x, y in zip(ts, ts[1:]) if s[x]['hr'] and s[y]['hr'] and y - x == 1 and abs(s[y]['hr'] - s[x]['hr']) > 10)


def gaps(s):
    ts = sorted(s)
    return sum(1 for a, b in zip(ts, ts[1:]) if b - a > 1)


def same_time(a, b):
    common = sorted(set(a) & set(b))
    if len(common) < 60:
        return False
    print(f'\nSame ride, {len(common)} s overlap, second by second:')
    dp = [a[t]['power'] - b[t]['power'] for t in common if a[t]['power'] is not None and b[t]['power'] is not None]
    pa = mean(a[t]['power'] for t in common); pb = mean(b[t]['power'] for t in common)
    print(f'  power A {pa:.1f} W, B {pb:.1f} W, A-B {pa - pb:+.1f} W ({(pa - pb) / pb * 100:+.1f}%)')
    print(f'  per second A-B: median {statistics.median(dp):+.1f} W, spread (sd) {statistics.pstdev(dp):.1f} W')
    dh = [a[t]['hr'] - b[t]['hr'] for t in common if a[t]['hr'] and b[t]['hr']]
    if dh:
        print(f'  heart rate A-B: mean {mean(dh):+.1f} bpm, median {statistics.median(dh):+.1f}, '
              f'sd {statistics.pstdev(dh):.1f}, seconds off by >5 bpm {sum(1 for x in dh if abs(x) > 5)}')
    print('  by 5 min (power A, B, %; HR A, B):')
    for i in range(0, len(common), 300):
        blk = common[i:i + 300]
        ba, bb = mean(a[t]['power'] for t in blk), mean(b[t]['power'] for t in blk)
        ha, hb = mean(a[t]['hr'] for t in blk if a[t]['hr']), mean(b[t]['hr'] for t in blk if b[t]['hr'])
        print(f'    {i // 60:3d}-{(i + len(blk)) // 60:<3d} min  A {ba:5.0f}  B {bb:5.0f}  {(ba - bb) / bb * 100 if bb else 0:+5.1f}%'
              f'   HR {ha:5.0f} {hb:5.0f}')
    return True


def blocks(s, steps, skip):
    """Cut a ride into its steady ERG blocks: runs where power sits within 8% of one of the targets."""
    ts = sorted(s)
    out = []
    for target in steps:
        run = [t for t in ts if s[t]['power'] and abs(s[t]['power'] - target) <= 0.08 * target]
        if not run:
            out.append((target, None, None, 0)); continue
        # the longest stretch with no hole over 15 s
        best, cur = [], [run[0]]
        for x, y in zip(run, run[1:]):
            if y - x <= 15: cur.append(y)
            else: best = max(best, cur, key=len); cur = [y]
        best = max(best, cur, key=len)
        t0, t1 = best[0] + skip, best[-1]
        sel = [t for t in ts if t0 <= t <= t1]
        out.append((target, mean(s[t]['power'] for t in sel), mean(s[t]['hr'] for t in sel if s[t]['hr']), len(sel)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a'); ap.add_argument('b')
    ap.add_argument('--steps', help='ERG targets in watts, comma separated (e.g. 120,160,200,240)')
    ap.add_argument('--skip', type=int, default=60, help='seconds to drop at the start of each block (HR settling)')
    o = ap.parse_args()
    a, b = series(o.a), series(o.b)
    summary('A ' + o.a, a); summary('B ' + o.b, b)
    if same_time(a, b):
        return
    if not o.steps:
        print('\nThe files do not overlap in time. For two separate rides use the same ERG workout and --steps.')
        return
    steps = [int(x) for x in o.steps.split(',')]
    print(f'\nERG blocks (first {o.skip} s of each left out):')
    print('  target |   A power   A HR  |   B power   B HR  | HR diff')
    for (t, pa, ha, na), (_, pb, hb, nb) in zip(blocks(a, steps, o.skip), blocks(b, steps, o.skip)):
        f = lambda p, h, n: f'{p:6.0f} W {h:5.0f} ({n:4d}s)' if n else '     — not found  '
        dh = f'{ha - hb:+5.1f}' if na and nb else '   —'
        print(f'  {t:4d} W | {f(pa, ha, na)} | {f(pb, hb, nb)} | {dh}')


if __name__ == '__main__':
    main()
