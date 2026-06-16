"""从 source.png 生成全套应用图标"""
import io
import struct
from PIL import Image
from PIL.Image import Resampling

LANCZOS = Resampling.LANCZOS

SOURCE = "src-tauri/icons/source.png"
OUT = "src-tauri/icons"

img = Image.open(SOURCE).convert("RGBA")
assert img.size[0] >= 256 and img.size[1] >= 256, f"source.png should be at least 256x256, got {img.size}"

# ── Step 1: PNG ────────────────────────────────────────────────
png_sizes = {
    "32x32.png":   (32, 32),
    "64x64.png":   (64, 64),
    "128x128.png": (128, 128),
    "256x256.png": (256, 256),
}
for name, (w, h) in png_sizes.items():
    resized = img.resize((w, h), LANCZOS)
    path = f"{OUT}/{name}"
    resized.save(path, "PNG")
    print(f"  [OK] {path}  ({w}x{h})")

# ── Step 2: icon.ico (multi-resolution) ───────────────────────
ico_sizes = [16, 32, 48, 64, 128, 256]
images_ico = [img.resize((s, s), LANCZOS) for s in ico_sizes]

# Build ICO directory + image data
ico_dir = b""
ico_data = b""
total_offset = 6 + len(ico_sizes) * 16  # header + directory entries

for i, (s, im) in enumerate(zip(ico_sizes, images_ico)):
    # BMP data: BITMAPINFOHEADER(40) + BGRA pixels
    w, h = im.size
    bmp_header = struct.pack(
        "<IiiHHIIiiII",
        40,           # biSize
        w,            # biWidth
        h * 2,        # biHeight (doubled for ICO)
        1,            # biPlanes
        32,           # biBitCount
        0,            # biCompression
        0,            # biSizeImage
        0, 0, 0, 0,   # biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant
    )
    # BGRA pixel data (bottom-up)
    pixels = []
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = im.getpixel((x, y))
            pixels.extend([b, g, r, a])
    pixel_data = bytes(pixels)

    # AND mask (1 bit per pixel, 32-bit aligned)
    mask_row_size = ((w + 31) // 32) * 4
    and_mask = b"\x00" * (mask_row_size * h)

    entry_data = bmp_header + pixel_data + and_mask
    entry_size = len(entry_data)

    # ICO directory entry
    ico_dir += struct.pack(
        "<BBBBHHII",
        s if s < 256 else 0,  # width (0 = 256)
        s if s < 256 else 0,  # height
        0,                     # color palette
        0,                     # reserved
        1,                     # color planes
        32,                    # bits per pixel
        entry_size,
        total_offset,
    )

    ico_data += entry_data
    total_offset += entry_size

ico_bytes = struct.pack("<HHH", 0, 1, len(ico_sizes)) + ico_dir + ico_data
with open(f"{OUT}/icon.ico", "wb") as f:
    f.write(ico_bytes)
ico_count = len(ico_sizes)
print(f"  [OK] {OUT}/icon.ico  ({ico_count} images: {', '.join(str(s) for s in ico_sizes)})")

# ── Step 3: icon.icns (macOS) ───────────────────────────────────
# ICNS container with icon types: ic07(128), ic08(256), ic09(512)
icns_types = {
    b"ic07": (128, 128),
    b"ic08": (256, 256),
    b"ic09": (512, 512),
}
icns_entries = b""
for icon_type, (w, h) in icns_types.items():
    resized = img.resize((w, h), LANCZOS)
    # Save as PNG bytes for ICNS embedding
    buf = io.BytesIO()
    resized.save(buf, "PNG")
    png_data = buf.getvalue()

    entry_size = len(icon_type) + 4 + len(png_data)
    icns_entries += icon_type + struct.pack(">I", entry_size) + png_data

icns_data = b"icns" + struct.pack(">I", 8 + len(icns_entries)) + icns_entries
with open(f"{OUT}/icon.icns", "wb") as f:
    f.write(icns_data)
print(f"  [OK] {OUT}/icon.icns  (3 images: ic07/128, ic08/256, ic09/512)")

print("\nAll icons generated successfully")
