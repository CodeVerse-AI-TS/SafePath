import os
import math
import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ==============================================================================
# SAFEPATH — CINEMATIC PRODUCT LAUNCH FILM GENERATOR (1080p, 76s, Full Soundtrack)
# ==============================================================================

WIDTH = 1920
HEIGHT = 1080
FPS = 30
TOTAL_SECONDS = 76
TOTAL_FRAMES = FPS * TOTAL_SECONDS  # 2,280 frames
OUTPUT_MP4 = r"C:\Users\Prajwal B\.gemini\antigravity\scratch\SafePath_final2\AI-Assistant-Without-Nova\SafePath_Cinematic_Launch_Film.mp4"
ARTIFACT_MP4 = r"C:\Users\Prajwal B\.gemini\antigravity\brain\9fcfbf16-ffd7-468d-b307-4f27908e5b02\SafePath_Cinematic_Launch_Film.mp4"

# Color Palette — Emerald & Deep Charcoal
C_CHARCOAL_DEEP = (9, 11, 14)
C_CHARCOAL_MID  = (16, 19, 25)
C_CHARCOAL_CARD = (25, 29, 38)
C_CHARCOAL_LIGHT = (38, 43, 56)
C_LINE_SUBTLE   = (52, 58, 74)

C_EMERALD_BRIGHT = (74, 222, 128)
C_EMERALD_CORE   = (34, 197, 94)
C_EMERALD_DEEP   = (21, 128, 61)
C_EMERALD_GLOW   = (16, 185, 129)

C_AMBER_SOFT     = (245, 158, 11)
C_AMBER_WARM     = (217, 119, 6)
C_STEEL_BLUE     = (148, 163, 184)
C_WHITE          = (255, 255, 255)
C_OFFWHITE       = (241, 245, 249)
C_MUTED          = (156, 163, 175)

# Fonts
font_dir = r"C:\Windows\Fonts"
def load_font(name, size):
    try:
        return ImageFont.truetype(os.path.join(font_dir, name), size)
    except:
        return ImageFont.load_default()

font_cinema_large = load_font("segoeuib.ttf", 64)
font_cinema_title = load_font("segoeuib.ttf", 46)
font_cinema_h2    = load_font("segoeuib.ttf", 34)
font_cinema_sub   = load_font("segoeui.ttf", 26)
font_cinema_tag   = load_font("segoeui.ttf", 22)
font_tag          = font_cinema_tag
font_cinema_bold  = load_font("segoeuib.ttf", 22)
font_mono         = load_font("consola.ttf", 20)

# ==============================================================================
# AUDIO GENERATOR — ORIGINAL CINEMATIC SCORE (Stereo, 44.1kHz, 76 Seconds)
# ==============================================================================
def generate_soundtrack():
    sample_rate = 44100
    total_samples = int(TOTAL_SECONDS * sample_rate)
    t = np.linspace(0, TOTAL_SECONDS, total_samples, endpoint=False)
    
    left = np.zeros(total_samples, dtype=np.float32)
    right = np.zeros(total_samples, dtype=np.float32)
    
    # Bass Progressions: Dm (0-16s) -> Bb (16-34s) -> F (34-51s) -> C (51-59s) -> Dmaj (59-68s) -> D (68-76s)
    bass_chords = [
        (0.0, 16.0, 36.71, 0.28),
        (16.0, 34.0, 29.14, 0.32),
        (34.0, 51.0, 43.65, 0.35),
        (51.0, 59.0, 32.70, 0.38),
        (59.0, 68.0, 36.71, 0.42),
        (68.0, 76.0, 36.71, 0.30)
    ]
    for st, en, freq, vol in bass_chords:
        mask = (t >= st) & (t < en)
        tt = t[mask]
        fade_in = np.clip((tt - st) / 1.5, 0, 1)
        fade_out = np.clip((en - tt) / 1.5, 0, 1)
        env = fade_in * fade_out * vol
        wave = np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(4 * np.pi * freq * tt)
        left[mask] += wave * env
        right[mask] += wave * env

    # Ambient Lush Pads
    pad_progressions = [
        (0.0, 16.0, [146.83, 174.61, 220.00, 261.63], 0.18),    # Dm7
        (16.0, 34.0, [116.54, 174.61, 233.08, 293.66], 0.20),   # Bbmaj7
        (34.0, 51.0, [130.81, 174.61, 220.00, 261.63], 0.22),   # Fmaj
        (51.0, 59.0, [130.81, 164.81, 196.00, 246.94], 0.24),   # C/E
        (59.0, 68.0, [146.83, 185.00, 220.00, 293.66], 0.28),   # Dmaj (Bright uplifting resolution)
        (68.0, 76.0, [146.83, 185.00, 220.00, 293.66, 440.0], 0.25)
    ]
    for st, en, freqs, vol in pad_progressions:
        mask = (t >= st) & (t < en)
        tt = t[mask]
        env = np.clip((tt - st) / 2.0, 0, 1) * np.clip((en - tt) / 2.0, 0, 1) * vol
        for i, f in enumerate(freqs):
            detune = 0.5 * (1 if i % 2 == 0 else -1)
            left[mask] += np.sin(2 * np.pi * (f - detune) * tt) * env * (0.8 / len(freqs))
            right[mask] += np.sin(2 * np.pi * (f + detune) * tt) * env * (0.8 / len(freqs))

    # Cinematic Pulse (Heartbeat / Rhythmic Pacing)
    for pt in np.arange(16.0, 67.5, 0.75):
        mask = (t >= pt) & (t < pt + 0.35)
        ptt = t[mask] - pt
        env = np.exp(-ptt * 14.0) * 0.22
        freq = 95.0 - 55.0 * (ptt / 0.35)
        pulse = np.sin(2 * np.pi * freq * ptt)
        left[mask] += pulse * env
        right[mask] += pulse * env

    # Crystalline Motif & Sound Design Accents
    chimes = [
        (8.5, 587.33, 1.8), (11.0, 659.25, 2.0), (13.5, 739.99, 2.5),
        (20.0, 587.33, 1.5), (22.5, 523.25, 1.5), (25.0, 440.00, 2.2),
        (37.0, 440.00, 1.5), (39.5, 523.25, 1.5), (42.0, 659.25, 2.5),
        (53.0, 880.00, 3.0), # Hardware button click shimmer
        (60.0, 587.33, 1.2), (62.0, 739.99, 1.2), (64.0, 880.00, 1.8), (66.0, 1174.66, 3.5),
        (69.0, 587.33, 2.0), (71.0, 739.99, 2.0), (73.0, 880.00, 4.0)
    ]
    for nt, nf, nd in chimes:
        mask = (t >= nt) & (t < nt + nd)
        ntt = t[mask] - nt
        env = np.exp(-ntt * 3.0) * 0.18
        note = np.sin(2 * np.pi * nf * ntt) + 0.32 * np.sin(4 * np.pi * nf * ntt)
        left[mask] += note * env * 0.8
        right[mask] += note * env * 0.95

    # Master Fade & Envelope
    master_env = np.clip(t / 2.0, 0, 1) * np.clip((TOTAL_SECONDS - t) / 3.0, 0, 1)
    left = np.clip(left * master_env, -0.92, 0.92)
    right = np.clip(right * master_env, -0.92, 0.92)
    
    return np.vstack([left, right]).astype(np.float32)

# ==============================================================================
# SCENE RENDERERS (Exact Match to Prompt Storyboard)
# ==============================================================================

def draw_cinematic_bars(draw):
    # 2.35:1 scope matte for ultra-cinematic widescreen feel
    bar_h = 70
    draw.rectangle([0, 0, WIDTH, bar_h], fill=(0, 0, 0))
    draw.rectangle([0, HEIGHT - bar_h, WIDTH, HEIGHT], fill=(0, 0, 0))

def draw_subtle_grid(draw, offset_x=0, offset_y=0):
    grid_size = 90
    for x in range(offset_x % grid_size, WIDTH, grid_size):
        draw.line([x, 70, x, HEIGHT - 70], fill=(22, 26, 34), width=1)
    for y in range(offset_y % grid_size + 70, HEIGHT - 70, grid_size):
        draw.line([0, y, WIDTH, y], fill=(22, 26, 34), width=1)

def draw_centered_caption(draw, text, y, font=font_cinema_sub, color=C_OFFWHITE, glow=True):
    tw = draw.textlength(text, font=font)
    x = (WIDTH - tw) // 2
    if glow:
        draw.text((x+1, y+1), text, fill=(10, 20, 15), font=font)
    draw.text((x, y), text, fill=color, font=font)

# ------------------------------------------------------------------------------
# SCENE 1 — THE PROBLEM | 0–8s (Frames 0–240)
# ------------------------------------------------------------------------------
def render_scene_1(draw, f):
    t_sec = f / 30.0
    cam_zoom = 1.0 + (t_sec / 8.0) * 0.08
    
    # Aerial city grid simulation (Dusk to night transition)
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_DEEP)
    draw_subtle_grid(draw, int(t_sec * 8), int(t_sec * 4))
    
    # Road network arterial lines
    roads = [
        ([150, 180, 1770, 280], 18, (28, 33, 44)),
        ([220, 540, 1700, 520], 24, (34, 40, 54)),
        ([180, 880, 1740, 840], 20, (30, 36, 48)),
        ([450, 90, 520, 990], 22, (32, 38, 50)),
        ([960, 90, 940, 990], 26, (36, 42, 56)),
        ([1420, 90, 1380, 990], 20, (30, 36, 48)),
    ]
    for pts, w, col in roads:
        draw.line(pts, fill=col, width=int(w * cam_zoom))

    # Moving headlights & taillights (Golden white & Ruby red light streaks)
    num_cars = 40
    for i in range(num_cars):
        prog = ((t_sec * 0.35 + i * 0.12) % 1.0)
        # Horizontal arterial traffic
        cx = int(220 + prog * 1480)
        cy = int(530 + math.sin(i * 1.5) * 8)
        color = (255, 235, 170) if (i % 2 == 0) else (239, 68, 68)
        draw.ellipse([cx - 4, cy - 3, cx + 18, cy + 3], fill=color)

    # Streetlight halos (Mysuru avenues)
    for lx in range(300, 1650, 200):
        for ly in [260, 500, 820]:
            draw.ellipse([lx - 12, ly - 12, lx + 12, ly + 12], fill=(45, 55, 45))
            draw.ellipse([lx - 4, ly - 4, lx + 4, ly + 4], fill=(240, 230, 160))

    # Subtle charcoal vignette overlay
    draw.ellipse([WIDTH//2 - 950, HEIGHT//2 - 500, WIDTH//2 + 950, HEIGHT//2 + 500], outline=(15, 20, 22), width=180)

    # Clean On-Screen Text
    text_fade = min(1.0, (t_sec - 1.5) / 1.5) if t_sec > 1.5 else 0.0
    if text_fade > 0:
        c_val = int(255 * text_fade)
        draw_centered_caption(draw, "Every journey starts with a decision.", HEIGHT - 180, font=font_cinema_title, color=(c_val, c_val, c_val))

# ------------------------------------------------------------------------------
# SCENE 2 — THE IDEA | 8–16s (Frames 240–480)
# ------------------------------------------------------------------------------
def render_scene_2(draw, f):
    t_sec = (f - 240) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_MID)
    draw_subtle_grid(draw, 0, 0)
    
    # Vector digital map geometry
    draw.rounded_rectangle([260, 160, 1660, 920], radius=28, fill=C_CHARCOAL_DEEP, outline=C_LINE_SUBTLE, width=2)
    
    # Tracing elegant green route line
    trace_prog = min(1.0, t_sec / 5.5)
    points = [
        (420, 720), (580, 520), (790, 520), (960, 360),
        (1180, 360), (1350, 480), (1500, 320)
    ]
    # Draw completed segments
    max_idx = int(trace_prog * (len(points) - 1))
    for i in range(max_idx):
        draw.line([points[i], points[i+1]], fill=C_EMERALD_BRIGHT, width=8)
        draw.line([points[i], points[i+1]], fill=(16, 185, 129), width=16) # soft halo
        
    # Draw partial segment
    if max_idx < len(points) - 1:
        rem = (trace_prog * (len(points) - 1)) - max_idx
        p1 = points[max_idx]
        p2 = points[max_idx + 1]
        cur_pt = (int(p1[0] + (p2[0] - p1[0]) * rem), int(p1[1] + (p2[1] - p1[1]) * rem))
        draw.line([p1, cur_pt], fill=C_EMERALD_BRIGHT, width=8)

    # Origin & Destination markers
    draw.ellipse([405, 705, 435, 735], fill=C_EMERALD_BRIGHT, outline=C_WHITE, width=3)
    if trace_prog > 0.85:
        draw.ellipse([1485, 305, 1515, 335], fill=C_WHITE, outline=C_EMERALD_BRIGHT, width=4)

    # Central Brand Reveal
    reveal_alpha = min(1.0, max(0.0, (t_sec - 2.5) / 1.5))
    if reveal_alpha > 0:
        c_em = tuple(int(v * reveal_alpha) for v in C_EMERALD_BRIGHT)
        c_wt = tuple(int(v * reveal_alpha) for v in C_WHITE)
        c_mt = tuple(int(v * reveal_alpha) for v in C_MUTED)
        
        # Brand box with emerald halo
        draw.rounded_rectangle([WIDTH//2 - 260, 240, WIDTH//2 + 260, 440], radius=20, fill=(12, 16, 20), outline=c_em, width=2)
        draw_centered_caption(draw, "SafePath", 270, font=font_cinema_large, color=c_wt)
        draw_centered_caption(draw, "Safety-focused navigation.", 365, font=font_cinema_sub, color=c_em)

# ------------------------------------------------------------------------------
# SCENE 3 — INTERACTIVE MAP | 16–25s (Frames 480–750)
# ------------------------------------------------------------------------------
def render_scene_3(draw, f):
    t_sec = (f - 480) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_MID)
    
    # Realistic Laptop / Tablet Frame
    lx1, ly1, lx2, ly2 = 240, 130, 1680, 950
    draw.rounded_rectangle([lx1, ly1, lx2, ly2], radius=24, fill=(18, 22, 28), outline=(65, 72, 88), width=3)
    
    # Internal Browser Topbar
    draw.rectangle([lx1, ly1, lx2, ly1 + 65], fill=(28, 33, 44))
    draw.ellipse([lx1 + 25, ly1 + 26, lx1 + 39, ly1 + 40], fill=(239, 68, 68))
    draw.ellipse([lx1 + 50, ly1 + 26, lx1 + 64, ly1 + 40], fill=(245, 158, 11))
    draw.ellipse([lx1 + 75, ly1 + 26, lx1 + 89, ly1 + 40], fill=(34, 197, 94))
    
    # URL address bar
    draw.rounded_rectangle([lx1 + 130, ly1 + 16, lx2 - 130, ly1 + 50], radius=10, fill=(20, 24, 32))
    draw.text((lx1 + 160, ly1 + 22), "https://safepath-mysuru.onrender.com", fill=C_MUTED, font=font_mono)
    
    # Map Canvas Inside Device
    mx1, my1, mx2, my2 = lx1 + 20, ly1 + 85, lx2 - 20, ly2 - 20
    draw.rectangle([mx1, my1, mx2, my2], fill=(12, 14, 18))
    
    # Mysore City Vector Road Network
    draw.line([mx1 + 80, my1 + 260, mx2 - 80, my1 + 290], fill=(36, 42, 54), width=16)
    draw.line([mx1 + 120, my1 + 520, mx2 - 120, my1 + 480], fill=(36, 42, 54), width=20)
    draw.line([mx1 + 420, my1 + 40, mx1 + 460, my2 - 40], fill=(36, 42, 54), width=18)
    draw.line([mx1 + 920, my1 + 40, mx1 + 890, my2 - 40], fill=(42, 48, 62), width=24) # Main Raja Marga
    draw.line([mx1 + 1300, my1 + 40, mx1 + 1260, my2 - 40], fill=(36, 42, 54), width=18)
    
    # Green Route along streets
    route_pts = [
        (mx1 + 320, my1 + 520), (mx1 + 460, my1 + 520),
        (mx1 + 890, my1 + 490), (mx1 + 900, my1 + 280),
        (mx1 + 1150, my1 + 285)
    ]
    for i in range(len(route_pts) - 1):
        draw.line([route_pts[i], route_pts[i+1]], fill=C_EMERALD_BRIGHT, width=8)

    # Origin & Destination Pins
    draw.rounded_rectangle([mx1 + 290, my1 + 495, mx1 + 350, my1 + 545], radius=10, fill=C_EMERALD_CORE)
    draw.text((mx1 + 308, my1 + 508), "A", fill=C_WHITE, font=font_cinema_bold)
    
    draw.rounded_rectangle([mx1 + 1120, my1 + 260, mx1 + 1180, my1 + 310], radius=10, fill=C_WHITE)
    draw.text((mx1 + 1140, my1 + 273), "B", fill=C_CHARCOAL_DEEP, font=font_cinema_bold)

    # Subtle incident markers on side streets
    draw.ellipse([mx1 + 650, my1 + 360, mx1 + 668, my1 + 378], fill=C_AMBER_SOFT)
    draw.ellipse([mx1 + 1050, my1 + 420, mx1 + 1068, my1 + 438], fill=C_AMBER_SOFT)
    
    # Search / Route Planner Overlay Box
    draw.rounded_rectangle([mx1 + 40, my1 + 40, mx1 + 380, my1 + 190], radius=14, fill=(24, 28, 36), outline=C_LINE_SUBTLE, width=2)
    draw.text((mx1 + 60, my1 + 60), "From: Mysore Palace", fill=C_WHITE, font=font_cinema_bold)
    draw.text((mx1 + 60, my1 + 105), "To: Saraswathipuram", fill=C_WHITE, font=font_cinema_bold)
    draw.text((mx1 + 60, my1 + 148), "Mode: Walking (Default)", fill=C_EMERALD_BRIGHT, font=font_mono)

    # On-Screen Caption
    draw_centered_caption(draw, "See the route. Understand the surroundings.", HEIGHT - 180, font=font_cinema_title, color=C_OFFWHITE)

# ------------------------------------------------------------------------------
# SCENE 4 — HOTSPOT AWARENESS | 25–34s (Frames 750–1020)
# ------------------------------------------------------------------------------
def render_scene_4(draw, f):
    t_sec = (f - 750) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_DEEP)
    
    # Close-up camera tracking over the map
    cx, cy = WIDTH // 2, HEIGHT // 2
    
    # Layer 1: Street Network
    draw.line([100, cy - 80, WIDTH - 100, cy - 60], fill=(40, 46, 58), width=24)
    draw.line([100, cy + 180, WIDTH - 100, cy + 160], fill=(40, 46, 58), width=20)
    draw.line([480, 100, 480, HEIGHT - 100], fill=(36, 42, 54), width=18)
    draw.line([980, 100, 980, HEIGHT - 100], fill=(48, 56, 72), width=32) # Spine
    draw.line([1480, 100, 1480, HEIGHT - 100], fill=(36, 42, 54), width=18)

    # Layer 2: Incident Markers (appear after 1.5s)
    if t_sec > 1.5:
        incidents = [(620, cy + 50), (1220, cy - 160), (1350, cy + 90)]
        for ix, iy in incidents:
            draw.ellipse([ix - 10, iy - 10, ix + 10, iy + 10], fill=C_AMBER_SOFT, outline=C_WHITE, width=2)
            draw.text((ix + 18, iy - 8), "Reported Lighting Gap", fill=C_MUTED, font=font_mono)

    # Layer 3: Tasteful Green-to-Amber Heatmap Overlay (appears after 3.0s)
    if t_sec > 3.0:
        hm_alpha = min(1.0, (t_sec - 3.0) / 2.0)
        # Soft concentric rings indicating recorded incident concentrations
        for r in range(120, 20, -20):
            draw.ellipse([620 - r, cy + 50 - r, 620 + r, cy + 50 + r], outline=(int(180 * hm_alpha), int(120 * hm_alpha), 40), width=4)
        for r in range(90, 20, -20):
            draw.ellipse([1220 - r, cy - 160 - r, 1220 + r, cy - 160 + r], outline=(int(180 * hm_alpha), int(130 * hm_alpha), 40), width=3)

    # Layer 4: Route Overlay
    draw.line([(240, cy + 170), (980, cy + 165), (980, cy - 70), (1650, cy - 65)], fill=C_EMERALD_BRIGHT, width=10)
    draw.ellipse([225, cy + 155, 255, cy + 185], fill=C_EMERALD_CORE)
    draw.ellipse([1635, cy - 80, 1665, cy - 50], fill=C_WHITE)

    # Legend Card Top-Right
    draw.rounded_rectangle([WIDTH - 480, 120, WIDTH - 100, 280], radius=16, fill=(20, 24, 32), outline=C_LINE_SUBTLE, width=2)
    draw.text((WIDTH - 450, 145), "DATA INTEGRATION LAYERS", fill=C_WHITE, font=font_cinema_bold)
    draw.ellipse([WIDTH - 450, 190, WIDTH - 435, 205], fill=C_EMERALD_BRIGHT)
    draw.text((WIDTH - 420, 187), "Recommended Safe Path", fill=C_OFFWHITE, font=font_tag)
    draw.ellipse([WIDTH - 450, 230, WIDTH - 435, 245], fill=C_AMBER_SOFT)
    draw.text((WIDTH - 420, 227), "Recorded Incident Clusters", fill=C_OFFWHITE, font=font_tag)

    # On-Screen Caption
    draw_centered_caption(draw, "Understand reported incident patterns.", HEIGHT - 180, font=font_cinema_title, color=C_OFFWHITE)

# ------------------------------------------------------------------------------
# SCENE 5 — ROUTE COMPARISON | 34–43s (Frames 1020–1290)
# ------------------------------------------------------------------------------
def render_scene_5(draw, f):
    t_sec = (f - 1020) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_MID)
    
    # Origin & Destination
    p_orig = (280, 520)
    p_dest = (1640, 520)
    
    # Route A (Emerald Green - Main Arterial Path)
    pts_a = [p_orig, (520, 320), (960, 320), (1400, 320), p_dest]
    for i in range(len(pts_a) - 1):
        draw.line([pts_a[i], pts_a[i+1]], fill=C_EMERALD_BRIGHT, width=10)
        
    # Route B (Neutral Contrasting Steel-Blue - Direct / Alley Cut)
    pts_b = [p_orig, (620, 720), (1050, 720), (1350, 680), p_dest]
    for i in range(len(pts_b) - 1):
        draw.line([pts_b[i], pts_b[i+1]], fill=C_STEEL_BLUE, width=8)

    # Endpoint nodes
    draw.ellipse([p_orig[0]-16, p_orig[1]-16, p_orig[0]+16, p_orig[1]+16], fill=C_WHITE, outline=C_EMERALD_CORE, width=4)
    draw.text((p_orig[0]-6, p_orig[1]-10), "A", fill=C_CHARCOAL_DEEP, font=font_cinema_bold)
    
    draw.ellipse([p_dest[0]-16, p_dest[1]-16, p_dest[0]+16, p_dest[1]+16], fill=C_WHITE, outline=C_STEEL_BLUE, width=4)
    draw.text((p_dest[0]-6, p_dest[1]-10), "B", fill=C_CHARCOAL_DEEP, font=font_cinema_bold)

    # Route A Card (Top Center)
    draw.rounded_rectangle([720, 160, 1200, 270], radius=16, fill=(18, 32, 25), outline=C_EMERALD_BRIGHT, width=2)
    draw.text((750, 185), "ROUTE A", fill=C_EMERALD_BRIGHT, font=font_cinema_h2)
    draw.text((750, 225), "Arterial avenues · Active lighting · Public presence", fill=C_OFFWHITE, font=font_tag)

    # Route B Card (Bottom Center)
    draw.rounded_rectangle([720, 760, 1200, 870], radius=16, fill=(24, 28, 36), outline=C_STEEL_BLUE, width=2)
    draw.text((750, 785), "ROUTE B", fill=C_STEEL_BLUE, font=font_cinema_h2)
    draw.text((750, 825), "Shortest path · Quiet residential stretches", fill=C_MUTED, font=font_tag)

    # On-Screen Caption
    draw_centered_caption(draw, "Compare options. Choose with awareness.", HEIGHT - 160, font=font_cinema_title, color=C_OFFWHITE)

# ------------------------------------------------------------------------------
# SCENE 6 — COMMUNITY INCIDENT REPORTING | 43–51s (Frames 1290–1530)
# ------------------------------------------------------------------------------
def render_scene_6(draw, f):
    t_sec = (f - 1290) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_MID)
    
    # Smartphone mock center screen
    sx1, sy1, sx2, sy2 = 720, 120, 1200, 940
    draw.rounded_rectangle([sx1, sy1, sx2, sy2], radius=32, fill=(18, 22, 28), outline=(65, 75, 92), width=3)
    
    # Phone header
    draw.rounded_rectangle([sx1 + 40, sy1 + 40, sx2 - 40, sy1 + 80], radius=10, fill=(26, 32, 42))
    draw.text((sx1 + 60, sy1 + 48), "Report a Safety Observation", fill=C_WHITE, font=font_cinema_bold)
    
    # Form fields
    draw.text((sx1 + 45, sy1 + 115), "CATEGORY", fill=C_MUTED, font=font_mono)
    # Selected category: Low Lighting
    draw.rounded_rectangle([sx1 + 40, sy1 + 145, sx2 - 40, sy1 + 205], radius=12, fill=(25, 45, 35), outline=C_EMERALD_BRIGHT, width=2)
    draw.text((sx1 + 60, sy1 + 165), "💡 Street Lighting Deficiency", fill=C_EMERALD_BRIGHT, font=font_cinema_bold)

    # Location picker field
    draw.text((sx1 + 45, sy1 + 235), "LOCATION SELECTION", fill=C_MUTED, font=font_mono)
    draw.rounded_rectangle([sx1 + 40, sy1 + 265, sx2 - 40, sy1 + 325], radius=12, fill=(24, 28, 38), outline=C_LINE_SUBTLE, width=1)
    draw.text((sx1 + 60, sy1 + 285), "📍 D. Devaraj Urs Road (110m approx)", fill=C_OFFWHITE, font=font_tag)

    # Context note field
    draw.text((sx1 + 45, sy1 + 355), "DETAILS (OPTIONAL)", fill=C_MUTED, font=font_mono)
    draw.rounded_rectangle([sx1 + 40, sy1 + 385, sx2 - 40, sy1 + 520], radius=12, fill=(24, 28, 38), outline=C_LINE_SUBTLE, width=1)
    draw.text((sx1 + 60, sy1 + 405), "Two municipal streetlights unlit", fill=C_OFFWHITE, font=font_tag)
    draw.text((sx1 + 60, sy1 + 435), "near bus shelter corner.", fill=C_OFFWHITE, font=font_tag)

    # Submit Button (with tap animation at t=4.5s)
    btn_bg = C_EMERALD_CORE if t_sec < 4.5 else (18, 90, 48)
    draw.rounded_rectangle([sx1 + 40, sy1 + 560, sx2 - 40, sy1 + 630], radius=14, fill=btn_bg)
    draw.text((sx1 + 140, sy1 + 580), "SUBMIT OBSERVATION", fill=C_WHITE, font=font_cinema_bold)

    # Radiating submission confirmation on map
    if t_sec > 4.5:
        pulse_r = int((t_sec - 4.5) * 60)
        draw.ellipse([WIDTH//2 - pulse_r, HEIGHT//2 + 240 - pulse_r, WIDTH//2 + pulse_r, HEIGHT//2 + 240 + pulse_r], outline=C_EMERALD_BRIGHT, width=3)
        draw.text((sx1 + 80, sy1 + 670), "✓ Added to Community Map Layer", fill=C_EMERALD_BRIGHT, font=font_tag)

    # On-Screen Caption
    draw_centered_caption(draw, "Every report can help build awareness.", HEIGHT - 160, font=font_cinema_title, color=C_OFFWHITE)

# ------------------------------------------------------------------------------
# SCENE 7 — THE PHYSICAL PANIC BUTTON | 51–59s (Frames 1530–1770)
# ------------------------------------------------------------------------------
def render_scene_7(draw, f):
    t_sec = (f - 1530) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=(12, 14, 18))
    
    # Clean desk surface perspective
    draw.line([0, 720, WIDTH, 720], fill=(28, 32, 40), width=2)
    
    bx, by = WIDTH // 2, HEIGHT // 2 - 30
    
    # Realistic hardware chassis (Circular brushed anodized aluminum & emerald edge)
    draw.ellipse([bx - 200, by - 200, bx + 200, by + 200], fill=(20, 24, 30), outline=(50, 56, 70), width=6)
    
    # Emerald-green edge lighting ring
    draw.ellipse([bx - 170, by - 170, bx + 170, by + 170], outline=C_EMERALD_CORE, width=8)
    
    # Inner concave push button
    draw.ellipse([bx - 140, by - 140, bx + 140, by + 140], fill=(28, 33, 42), outline=(70, 78, 95), width=3)
    
    # Minimalist Icon on Button
    draw.ellipse([bx - 30, by - 30, bx + 30, by + 30], outline=C_EMERALD_BRIGHT, width=4)
    draw.line([bx, by - 16, bx, by + 16], fill=C_EMERALD_BRIGHT, width=4)

    # Press interaction at t=3.0s (sound effect synchronized)
    is_pressed = (t_sec >= 3.0)
    if is_pressed:
        pulse_r = int((t_sec - 3.0) * 140)
        for pr in range(pulse_r, max(0, pulse_r - 80), -25):
            alpha_fade = max(0, 255 - pr * 2)
            c = (int(C_EMERALD_BRIGHT[0] * alpha_fade / 255), int(C_EMERALD_BRIGHT[1] * alpha_fade / 255), int(C_EMERALD_BRIGHT[2] * alpha_fade / 255))
            draw.ellipse([bx - pr, by - pr, bx + pr, by + pr], outline=c, width=3)

    # On-Screen Caption
    draw_centered_caption(draw, "Designed with quick access to help in mind.", HEIGHT - 170, font=font_cinema_title, color=C_OFFWHITE)

# ------------------------------------------------------------------------------
# SCENE 8 — ONE CONNECTED VISION | 59–68s (Frames 1770–2040)
# ------------------------------------------------------------------------------
def render_scene_8(draw, f):
    t_sec = (f - 1770) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_MID)
    draw_subtle_grid(draw, int(t_sec * 6), int(t_sec * 3))
    
    # 4 Composed Montage Pillars interconnected by emerald lines
    cx, cy = WIDTH // 2, HEIGHT // 2 - 40
    
    # Interconnecting lines to central hub
    draw.line([380, 260, cx, cy], fill=C_EMERALD_DEEP, width=4)
    draw.line([1540, 260, cx, cy], fill=C_EMERALD_DEEP, width=4)
    draw.line([380, 680, cx, cy], fill=C_EMERALD_DEEP, width=4)
    draw.line([1540, 680, cx, cy], fill=C_EMERALD_DEEP, width=4)
    
    # Central SafePath Core Hub
    draw.ellipse([cx - 80, cy - 80, cx + 80, cy + 80], fill=C_CHARCOAL_DEEP, outline=C_EMERALD_BRIGHT, width=4)
    draw.text((cx - 32, cy - 20), "SP", fill=C_WHITE, font=font_cinema_title)

    # Pillar 1: Interactive Maps
    draw.rounded_rectangle([240, 190, 520, 330], radius=18, fill=C_CHARCOAL_CARD, outline=C_LINE_SUBTLE, width=2)
    draw.text((270, 220), "🗺️ Interactive Maps", fill=C_WHITE, font=font_cinema_bold)
    draw.text((270, 265), "Walking path geometry", fill=C_MUTED, font=font_tag)

    # Pillar 2: Hotspot Awareness
    draw.rounded_rectangle([1400, 190, 1680, 330], radius=18, fill=C_CHARCOAL_CARD, outline=C_LINE_SUBTLE, width=2)
    draw.text((1430, 220), "📊 Incident Patterns", fill=C_WHITE, font=font_cinema_bold)
    draw.text((1430, 265), "Recorded community data", fill=C_MUTED, font=font_tag)

    # Pillar 3: Route Comparison
    draw.rounded_rectangle([240, 610, 520, 750], radius=18, fill=C_CHARCOAL_CARD, outline=C_LINE_SUBTLE, width=2)
    draw.text((270, 640), "⚖️ Route Comparison", fill=C_WHITE, font=font_cinema_bold)
    draw.text((270, 685), "Balanced options on foot", fill=C_MUTED, font=font_tag)

    # Pillar 4: Physical Panic Prototype
    draw.rounded_rectangle([1400, 610, 1680, 750], radius=18, fill=C_CHARCOAL_CARD, outline=C_LINE_SUBTLE, width=2)
    draw.text((1430, 640), "🔘 Hardware Access", fill=C_WHITE, font=font_cinema_bold)
    draw.text((1430, 685), "One-press physical intent", fill=C_MUTED, font=font_tag)

    # On-Screen Caption
    draw_centered_caption(draw, "Maps. Awareness. Reporting. A connected vision.", HEIGHT - 160, font=font_cinema_title, color=C_OFFWHITE)

# ------------------------------------------------------------------------------
# SCENE 9 — BRAND FINALE | 68–76s (Frames 2040–2280)
# ------------------------------------------------------------------------------
def render_scene_9(draw, f):
    t_sec = (f - 2040) / 30.0
    draw.rectangle([0, 0, WIDTH, HEIGHT], fill=C_CHARCOAL_DEEP)
    
    cx, cy = WIDTH // 2, HEIGHT // 2
    
    # Emerald route line drawing a frame around brand name
    frame_w, frame_h = 740, 340
    fx1, fy1, fx2, fy2 = cx - frame_w//2, cy - frame_h//2 - 20, cx + frame_w//2, cy + frame_h//2 - 20
    
    # Smooth line trace animation
    trace_pct = min(1.0, t_sec / 2.5)
    total_peri = 2 * (frame_w + frame_h)
    draw_len = int(trace_pct * total_peri)
    
    draw.rounded_rectangle([fx1, fy1, fx2, fy2], radius=24, fill=(13, 16, 22), outline=C_EMERALD_CORE, width=3)

    # Brand Title
    draw_centered_caption(draw, "SafePath", cy - 100, font=font_cinema_large, color=C_WHITE, glow=True)
    
    # Tagline reveal (exact prompt wording)
    if t_sec > 1.8:
        tag_fade = min(1.0, (t_sec - 1.8) / 1.5)
        c_val = int(255 * tag_fade)
        c_green = int(C_EMERALD_BRIGHT[1] * tag_fade)
        draw_centered_caption(draw, "“Know your route. Alert in one press.”", cy + 15, font=font_cinema_h2, color=(100, c_green, 150))
        
    if t_sec > 3.2:
        draw_centered_caption(draw, "mysuru · personal safety navigation", cy + 85, font=font_mono, color=C_MUTED)

# ==============================================================================
# MAIN RENDER PIPELINE (Video + Audio Multiplexing)
# ==============================================================================
def main():
    print("="*70)
    print("SAFEPATH CINEMATIC FILM GENERATOR")
    print(f"Target Duration: {TOTAL_SECONDS}s ({TOTAL_FRAMES} frames @ {FPS}fps)")
    print(f"Output: {OUTPUT_MP4}")
    print("="*70)
    
    # 1. Synthesize Audio Track
    print("1/3 Synthesizing original cinematic electronic score...")
    soundtrack = generate_soundtrack()
    print("Audio synthesized: 76.0s stereo 44.1kHz")

    # 2. Setup Container & Streams
    container = av.open(OUTPUT_MP4, mode='w')
    
    # Video stream (H.264 high quality 1080p)
    vstream = container.add_stream('libx264', rate=FPS)
    vstream.width = WIDTH
    vstream.height = HEIGHT
    vstream.pix_fmt = 'yuv420p'
    vstream.options = {'crf': '17', 'preset': 'slow'}
    
    # Audio stream (AAC stereo)
    astream = container.add_stream('aac', rate=44100)
    astream.layout = 'stereo'

    # Encode Audio
    print("2/3 Encoding audio stream...")
    audio_frame = av.AudioFrame.from_ndarray(soundtrack, format='fltp', layout='stereo')
    audio_frame.rate = 44100
    for packet in astream.encode(audio_frame):
        container.mux(packet)
    for packet in astream.encode():
        container.mux(packet)

    # 3. Render 2,280 Video Frames
    print(f"3/3 Rendering {TOTAL_FRAMES} cinematic video frames...")
    
    for f in range(TOTAL_FRAMES):
        img = Image.new('RGB', (WIDTH, HEIGHT), color=C_CHARCOAL_DEEP)
        draw = ImageDraw.Draw(img)
        
        # Dispatch to scene
        if f < 240:
            render_scene_1(draw, f)
        elif f < 480:
            render_scene_2(draw, f)
        elif f < 750:
            render_scene_3(draw, f)
        elif f < 1020:
            render_scene_4(draw, f)
        elif f < 1290:
            render_scene_5(draw, f)
        elif f < 1530:
            render_scene_6(draw, f)
        elif f < 1770:
            render_scene_7(draw, f)
        elif f < 2040:
            render_scene_8(draw, f)
        else:
            render_scene_9(draw, f)
            
        draw_cinematic_bars(draw)
        
        frame = av.VideoFrame.from_image(img)
        for packet in vstream.encode(frame):
            container.mux(packet)
            
        if f % 150 == 0:
            pct = int(f / TOTAL_FRAMES * 100)
            print(f"Rendered {f}/{TOTAL_FRAMES} frames ({pct}% | Scene at {f//30}s)...")

    # Flush video encoder
    for packet in vstream.encode():
        container.mux(packet)
        
    container.close()
    print("="*70)
    print("CINEMATIC FILM GENERATION COMPLETE!")
    print(f"Saved: {OUTPUT_MP4}")
    
    # Copy to artifact directory
    try:
        import shutil
        shutil.copy2(OUTPUT_MP4, ARTIFACT_MP4)
        print(f"Copied to artifacts: {ARTIFACT_MP4}")
    except Exception as e:
        print("Artifact copy error:", e)

if __name__ == "__main__":
    main()
