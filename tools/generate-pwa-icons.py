"""Generate the app's monogram PNGs with the Python standard library only."""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'public' / 'icons'

def is_mark(x, y):
    # Geometric B, centered in the safe region for maskable icons.
    stem = .32 <= x <= .43 and .255 <= y <= .75
    upper = .40 <= x and ((x-.50)/.215)**2 + ((y-.385)/.13)**2 <= 1
    lower = .40 <= x and ((x-.51)/.225)**2 + ((y-.607)/.143)**2 <= 1
    hole1 = x >= .43 and ((x-.505)/.102)**2 + ((y-.385)/.046)**2 <= 1
    hole2 = x >= .43 and ((x-.512)/.112)**2 + ((y-.607)/.056)**2 <= 1
    return (stem or upper or lower) and not (hole1 or hole2)

def chunk(kind, data):
    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)

def make_png(size):
    rows = bytearray()
    navy, gold = (10,31,63), (198,161,91)
    for py in range(size):
        rows.append(0)
        for px in range(size):
            coverage=sum(is_mark((px+dx)/size,(py+dy)/size) for dx,dy in ((.25,.25),(.75,.25),(.25,.75),(.75,.75)))
            rows.extend(round((a*(4-coverage)+b*coverage)/4) for a,b in zip(navy,gold))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b'')

ROOT.mkdir(parents=True,exist_ok=True)
for size,name in [(192,'icon-192.png'),(512,'icon-512.png'),(180,'apple-touch-icon.png')]:
    (ROOT/name).write_bytes(make_png(size))
