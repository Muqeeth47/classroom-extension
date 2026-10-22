import struct, zlib, sys, os
# Logo: black rounded square with a white mono "i." built from three squares on a 32-unit grid.
MARK = [(10, 7, 4, 4), (10, 13, 4, 11), (18, 20, 4, 4)]  # i-dot, i-stem, full stop
def in_rect(u, v, r): return r[0] <= u < r[0] + r[2] and r[1] <= v < r[1] + r[3]
def in_round(u, v, rad):
    if rad == 0: return 0 <= u < 32 and 0 <= v < 32
    cx = min(max(u, rad), 32 - rad); cy = min(max(v, rad), 32 - rad)
    return 0 <= u < 32 and 0 <= v < 32 and (u - cx) ** 2 + (v - cy) ** 2 <= rad * rad
def png(size, rad):
    S = 8  # supersampling for smooth edges
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            a = w = 0
            for sy in range(S):
                for sx in range(S):
                    u = (px + (sx + .5) / S) * 32 / size; v = (py + (sy + .5) / S) * 32 / size
                    if in_round(u, v, rad):
                        a += 1
                        if any(in_rect(u, v, r) for r in MARK): w += 1
            n = S * S
            row += bytes([round(255 * w / a) if a else 0] * 3 + [round(255 * a / n)])
        rows.append(bytes(row))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
ext_dir, site_dir = sys.argv[1], sys.argv[2]
for s in (16, 48, 128): open(os.path.join(ext_dir, f'icon{s}.png'), 'wb').write(png(s, 6))
open(os.path.join(site_dir, 'favicon-32.png'), 'wb').write(png(32, 6))
open(os.path.join(site_dir, 'apple-touch-icon.png'), 'wb').write(png(180, 0))  # iOS rounds the corners itself
open(os.path.join(site_dir, 'icon.svg'), 'w').write(
 '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#000"/>'
 '<g fill="#fff"><rect x="10" y="7" width="4" height="4"/><rect x="10" y="13" width="4" height="11"/><rect x="18" y="20" width="4" height="4"/></g></svg>\n')
print('ok')
