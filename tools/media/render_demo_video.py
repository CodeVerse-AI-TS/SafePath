import os
import math
import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Video Specs
WIDTH = 1920
HEIGHT = 1080
FPS = 30
TOTAL_FRAMES = 1350  # 45 seconds at 30 fps
OUTPUT_FILE = r"C:\Users\Prajwal B\.gemini\antigravity\scratch\SafePath_final2\AI-Assistant-Without-Nova\safepath_product_demo.mp4"

# Color Palette (SafePath Brand Tokens)
COLOR_BG_DARK = (16, 17, 20)
COLOR_PANEL = (26, 28, 34)
COLOR_PANEL_LIGHT = (38, 41, 50)
COLOR_LINE = (55, 60, 72)
COLOR_TEXT_PRIMARY = (244, 245, 247)
COLOR_TEXT_MUTED = (148, 163, 184)
COLOR_EMERALD = (74, 222, 128)
COLOR_EMERALD_DARK = (85, 124, 104)
COLOR_AMBER = (251, 191, 36)
COLOR_DANGER = (248, 113, 113)
COLOR_INFO = (96, 165, 250)
COLOR_ACCENT = (168, 85, 247)

# Fonts
font_dir = r"C:\Windows\Fonts"
def get_font(name, size):
    path = os.path.join(font_dir, name)
    try:
        return ImageFont.truetype(path, size)
    except:
        return ImageFont.load_default()

font_hero = get_font("segoeuib.ttf", 72)
font_title = get_font("segoeuib.ttf", 52)
font_h2 = get_font("segoeuib.ttf", 38)
font_body = get_font("segoeui.ttf", 26)
font_body_bold = get_font("segoeuib.ttf", 26)
font_mono = get_font("consola.ttf", 22)
font_small = get_font("segoeui.ttf", 20)

def draw_header_bar(draw, frame_idx, current_tab="OVERVIEW"):
    # Top navigation bar
    draw.rectangle([0, 0, WIDTH, 80], fill=(22, 24, 30))
    draw.line([0, 80, WIDTH, 80], fill=COLOR_LINE, width=2)
    
    # Brand mark
    draw.rounded_rectangle([40, 18, 84, 62], radius=10, fill=COLOR_EMERALD_DARK)
    draw.text((48, 24), "SP", fill=COLOR_TEXT_PRIMARY, font=font_body_bold)
    
    draw.text((96, 19), "SafePath", fill=COLOR_TEXT_PRIMARY, font=font_body_bold)
    draw.text((98, 48), "MYSURU", fill=COLOR_TEXT_MUTED, font=font_mono)
    
    # Active indicator pills
    pills = ["OVERVIEW", "SAFE ROUTES", "REPORTS", "LIVE DESK", "DASHBOARD"]
    start_x = 360
    for pill in pills:
        is_active = (pill == current_tab)
        bg = (40, 65, 55) if is_active else (28, 30, 36)
        fg = COLOR_EMERALD if is_active else COLOR_TEXT_MUTED
        border = COLOR_EMERALD if is_active else COLOR_LINE
        
        tw = draw.textlength(pill, font=font_small)
        draw.rounded_rectangle([start_x, 22, start_x + tw + 28, 58], radius=8, fill=bg, outline=border, width=1)
        draw.text((start_x + 14, 28), pill, fill=fg, font=font_small)
        start_x += int(tw + 44)
        
    # Right status chip
    draw.rounded_rectangle([WIDTH - 300, 24, WIDTH - 40, 56], radius=16, fill=(35, 38, 46), outline=COLOR_LINE)
    draw.ellipse([WIDTH - 285, 36, WIDTH - 275, 46], fill=COLOR_EMERALD)
    draw.text((WIDTH - 265, 29), "LIVE MYSURU ENGINE", fill=COLOR_TEXT_PRIMARY, font=font_small)

def draw_bottom_progress(draw, frame_idx):
    # Bottom progress bar for demo video
    pct = frame_idx / float(TOTAL_FRAMES)
    draw.line([0, HEIGHT - 8, WIDTH, HEIGHT - 8], fill=(30, 32, 40), width=8)
    draw.line([0, HEIGHT - 8, int(WIDTH * pct), HEIGHT - 8], fill=COLOR_EMERALD, width=8)
    
    # Time code
    secs = frame_idx // 30
    draw.text((WIDTH - 120, HEIGHT - 40), f"00:{secs:02d} / 00:45", fill=COLOR_TEXT_MUTED, font=font_mono)

def render_scene_1(draw, f):
    # Intro / Hero Hook (0 - 180 frames)
    # Background subtle radial glow
    cx, cy = WIDTH // 2, HEIGHT // 2
    
    alpha = min(1.0, f / 30.0)
    
    # Center Brand Shield
    box_w, box_h = 160, 160
    draw.rounded_rectangle([cx - box_w//2, cy - 240, cx + box_w//2, cy - 80], radius=32, fill=(28, 48, 40), outline=COLOR_EMERALD, width=4)
    draw.text((cx - 48, cy - 200), "SP", fill=COLOR_TEXT_PRIMARY, font=font_hero)
    
    # Big Title
    title = "SafePath"
    tw = draw.textlength(title, font=font_hero)
    draw.text((cx - tw // 2, cy - 40), title, fill=COLOR_TEXT_PRIMARY, font=font_hero)
    
    tag = "Move Freely. Feel Safer."
    tw_tag = draw.textlength(tag, font=font_title)
    draw.text((cx - tw_tag // 2, cy + 50), tag, fill=COLOR_EMERALD, font=font_title)
    
    desc = "Community-Driven Walking Safety Engine · Mysuru, India"
    tw_desc = draw.textlength(desc, font=font_body)
    draw.text((cx - tw_desc // 2, cy + 130), desc, fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Key badges below
    badges = ["✦ 100% Free & Open Source", "✦ Works Without Sign-In", "✦ Privacy-Preserving GPS", "✦ Instant SOS Alert"]
    total_w = sum(draw.textlength(b, font=font_small) + 36 for b in badges)
    bx = (WIDTH - total_w) // 2
    for b in badges:
        bw = draw.textlength(b, font=font_small) + 36
        draw.rounded_rectangle([bx, cy + 220, bx + bw, cy + 265], radius=14, fill=(24, 28, 36), outline=COLOR_LINE, width=1)
        draw.text((bx + 18, cy + 232), b, fill=COLOR_TEXT_PRIMARY, font=font_small)
        bx += bw + 16

def render_scene_2(draw, f):
    # Scene 2: The Problem vs SafePath (180 - 360 frames)
    draw_header_bar(draw, f, "OVERVIEW")
    
    draw.text((100, 120), "THE PROBLEM WITH STANDARD MAPS", fill=COLOR_AMBER, font=font_title)
    draw.text((100, 185), "Traditional navigation is designed for cars and speed, ignoring walking safety.", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Card 1: Standard Nav
    c1_x1, c1_y1, c1_x2, c1_y2 = 100, 260, 900, 880
    draw.rounded_rectangle([c1_x1, c1_y1, c1_x2, c1_y2], radius=24, fill=(24, 26, 32), outline=(100, 40, 40), width=2)
    draw.rounded_rectangle([c1_x1 + 30, c1_y1 + 30, c1_x1 + 240, c1_y1 + 80], radius=10, fill=(60, 20, 20))
    draw.text((c1_x1 + 45, c1_y1 + 42), "Standard Maps", fill=COLOR_DANGER, font=font_h2)
    
    points_1 = [
        "❌ Optimizes purely for the shortest distance",
        "❌ Directs walkers through dark alleys & empty stretches",
        "❌ Blind to street lighting and crowd presence",
        "❌ No live harassment or incident signal awareness",
        "❌ Cluttered interface during high-stress moments"
    ]
    py = c1_y1 + 130
    for p in points_1:
        draw.text((c1_x1 + 40, py), p, fill=COLOR_TEXT_PRIMARY, font=font_body)
        py += 80

    # Card 2: SafePath
    c2_x1, c2_y1, c2_x2, c2_y2 = 1020, 260, 1820, 880
    draw.rounded_rectangle([c2_x1, c2_y1, c2_x2, c2_y2], radius=24, fill=(20, 32, 28), outline=COLOR_EMERALD, width=2)
    draw.rounded_rectangle([c2_x1 + 30, c2_y1 + 30, c2_x1 + 260, c2_y1 + 80], radius=10, fill=(30, 60, 45))
    draw.text((c2_x1 + 45, c2_y1 + 42), "SafePath Solution", fill=COLOR_EMERALD, font=font_h2)
    
    points_2 = [
        "✓ Multi-criteria route optimizer (Safety vs Speed)",
        "✓ Evaluates street lamp density & open shopfronts",
        "✓ Real-time community incident clustering (DBSCAN)",
        "✓ 3 distinct route options tailored for walkers",
        "✓ 1-press emergency SOS to contacts + 112"
    ]
    py = c2_y1 + 130
    for p in points_2:
        draw.text((c2_x1 + 40, py), p, fill=COLOR_TEXT_PRIMARY, font=font_body)
        py += 80

def render_scene_3(draw, f):
    # Scene 3: Intelligent 3-Route Comparison (360 - 570 frames)
    draw_header_bar(draw, f, "SAFE ROUTES")
    
    draw.text((100, 115), "INTELLIGENT 3-ROUTE ENGINE", fill=COLOR_EMERALD, font=font_title)
    draw.text((100, 180), "SafePath calculates three distinct paths between any two locations in Mysuru.", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # 3 Route Cards Side-by-Side
    routes = [
        {
            "role": "SAFEST ROUTE",
            "badge": "RECOMMENDED",
            "color": COLOR_EMERALD,
            "bg": (20, 36, 28),
            "score": "88",
            "score_label": "High Safety Score",
            "time": "24 min",
            "dist": "1.8 km",
            "features": ["Well-lit arterial avenues", "Active commercial shops", "Zero recent risk reports", "Higher foot traffic"]
        },
        {
            "role": "BALANCED ROUTE",
            "badge": "BALANCED",
            "color": COLOR_AMBER,
            "bg": (36, 32, 20),
            "score": "73",
            "score_label": "Moderate Safety",
            "time": "20 min",
            "dist": "1.5 km",
            "features": ["Optimal mix of safety & time", "Minor quiet residential paths", "Adequate lighting", "Saves 4 minutes walk"]
        },
        {
            "role": "FASTEST ROUTE",
            "badge": "SHORTEST",
            "color": COLOR_INFO,
            "bg": (20, 28, 40),
            "score": "51",
            "score_label": "Caution Advised",
            "time": "16 min",
            "dist": "1.2 km",
            "features": ["Shortest straight-line cut", "Dark stretches reported", "Low footfall after 9 PM", "Use only during daytime"]
        }
    ]
    
    cw = 540
    start_x = 100
    for i, r in enumerate(routes):
        rx = start_x + i * 590
        ry = 260
        
        # Animate selection pulse
        is_safest = (i == 0)
        border_w = 3 if is_safest else 1
        draw.rounded_rectangle([rx, ry, rx + cw, ry + 620], radius=22, fill=r["bg"], outline=r["color"], width=border_w)
        
        # Route title & badge
        draw.text((rx + 30, ry + 30), r["role"], fill=r["color"], font=font_h2)
        draw.rounded_rectangle([rx + cw - 170, ry + 30, rx + cw - 30, ry + 68], radius=8, fill=(40, 44, 52))
        draw.text((rx + cw - 155, ry + 38), r["badge"], fill=COLOR_TEXT_PRIMARY, font=font_small)
        
        # Big Score
        draw.text((rx + 30, ry + 95), "SAFETY SCORE", fill=COLOR_TEXT_MUTED, font=font_mono)
        draw.text((rx + 30, ry + 125), r["score"], fill=r["color"], font=font_hero)
        draw.text((rx + 130, ry + 160), "/100", fill=COLOR_TEXT_MUTED, font=font_h2)
        draw.text((rx + 30, ry + 220), r["score_label"], fill=r["color"], font=font_body_bold)
        
        # Stats row
        draw.line([rx + 30, ry + 265, rx + cw - 30, ry + 265], fill=COLOR_LINE, width=1)
        draw.text((rx + 30, ry + 285), f"⏱ Walking Time: {r['time']}", fill=COLOR_TEXT_PRIMARY, font=font_body)
        draw.text((rx + 30, ry + 325), f"📏 Total Distance: {r['dist']}", fill=COLOR_TEXT_PRIMARY, font=font_body)
        draw.line([rx + 30, ry + 375, rx + cw - 30, ry + 375], fill=COLOR_LINE, width=1)
        
        # Bullet features
        fy = ry + 400
        for feat in r["features"]:
            draw.text((rx + 30, fy), f"• {feat}", fill=COLOR_TEXT_PRIMARY, font=font_small)
            fy += 45

    # Slider bar at bottom
    draw.rounded_rectangle([100, 910, 1820, 960], radius=14, fill=(24, 28, 36), outline=COLOR_LINE)
    draw.text((140, 922), "SAFETY VS SPEED SLIDER:", fill=COLOR_TEXT_MUTED, font=font_mono)
    draw.text((450, 922), "Fastest ━━━━━━━━━━━━ Balanced ━━━━━━━━━━━━ Safest (λ = 1.5)", fill=COLOR_EMERALD, font=font_mono)

def render_scene_4(draw, f):
    # Scene 4: Live Map, Hotspots, Reports (570 - 780 frames)
    draw_header_bar(draw, f, "DASHBOARD")
    
    draw.text((100, 115), "COMMUNITY SIGNALS & DATA TRANSPARENCY", fill=COLOR_AMBER, font=font_title)
    draw.text((100, 180), "Live database updates cluster reported safety concerns without storing private user trails.", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Left Map Graphic Box
    mx1, my1, mx2, my2 = 100, 250, 1050, 900
    draw.rounded_rectangle([mx1, my1, mx2, my2], radius=22, fill=(20, 22, 26), outline=COLOR_LINE, width=2)
    
    # Map roads graphic
    draw.line([mx1 + 50, my1 + 200, mx2 - 50, my1 + 250], fill=(45, 50, 60), width=12)
    draw.line([mx1 + 150, my1 + 50, mx1 + 250, my2 - 50], fill=(45, 50, 60), width=16)
    draw.line([mx1 + 350, my1 + 80, mx1 + 450, my2 - 80], fill=(45, 50, 60), width=10)
    draw.line([mx1 + 650, my1 + 50, mx1 + 600, my2 - 50], fill=(45, 50, 60), width=14)
    draw.line([mx1 + 80, my1 + 480, mx2 - 80, my1 + 440], fill=(45, 50, 60), width=14)
    
    # Safest Route Line (Emerald)
    draw.line([mx1 + 150, my1 + 500, mx1 + 250, my1 + 240, mx1 + 620, my1 + 245, mx1 + 610, my1 + 120], fill=COLOR_EMERALD, width=8)
    
    # Pulsing Hotspots on map
    phase = (f % 60) / 60.0
    pulse_r = int(24 + 18 * math.sin(phase * math.pi))
    
    # Hotspot 1 (Red)
    draw.ellipse([mx1 + 420 - pulse_r, my1 + 380 - pulse_r, mx1 + 420 + pulse_r, my1 + 380 + pulse_r], outline=COLOR_DANGER, width=3)
    draw.ellipse([mx1 + 412, my1 + 372, mx1 + 428, my1 + 388], fill=COLOR_DANGER)
    draw.text((mx1 + 435, my1 + 368), "Hotspot #1: Dark Stretch", fill=COLOR_DANGER, font=font_mono)
    
    # Hotspot 2 (Amber)
    draw.ellipse([mx1 + 720 - 15, my1 + 220 - 15, mx1 + 720 + 15, my1 + 220 + 15], outline=COLOR_AMBER, width=2)
    draw.ellipse([mx1 + 715, my1 + 215, mx1 + 725, my1 + 225], fill=COLOR_AMBER)
    draw.text((mx1 + 735, my1 + 210), "Hotspot #2: Low Footfall", fill=COLOR_AMBER, font=font_mono)
    
    # Start / End Markers
    draw.rounded_rectangle([mx1 + 130, my1 + 480, mx1 + 170, my1 + 520], radius=8, fill=COLOR_EMERALD)
    draw.text((mx1 + 142, my1 + 488), "A", fill=(16,17,20), font=font_body_bold)
    
    draw.rounded_rectangle([mx1 + 590, my1 + 100, mx1 + 630, my1 + 140], radius=8, fill=COLOR_INFO)
    draw.text((mx1 + 602, my1 + 108), "B", fill=(16,17,20), font=font_body_bold)
    
    # Right Side Detail Panels
    dx1, dy1, dx2, dy2 = 1100, 250, 1820, 900
    draw.rounded_rectangle([dx1, dy1, dx2, dy2], radius=22, fill=(24, 28, 36), outline=COLOR_LINE, width=2)
    
    draw.text((dx1 + 40, dy1 + 40), "DATA SCIENCE PIPELINE", fill=COLOR_TEXT_PRIMARY, font=font_h2)
    
    steps = [
        ("1. DBSCAN Spatial Clustering", "Groups reported incidents within 110m radius without storing pinpoint personal locations."),
        ("2. Multi-Signal Fusion", "Aggregates street lamp density, commercial operating hours, and user hazard reports."),
        ("3. Dijkstra Penalized Routing", "Computes the Pareto-optimal path balancing transit minutes against safety penalty."),
        ("4. Honest Disclaimers", "Scores are transparent comparative estimates, never false guarantees of safety.")
    ]
    sy = dy1 + 120
    for title, desc in steps:
        draw.text((dx1 + 40, sy), title, fill=COLOR_EMERALD, font=font_body_bold)
        draw.text((dx1 + 40, sy + 38), desc, fill=COLOR_TEXT_MUTED, font=font_small)
        sy += 115

def render_scene_5(draw, f):
    # Scene 5: Emergency Alert & One-Touch SOS (780 - 990 frames)
    draw_header_bar(draw, f, "LIVE DESK")
    
    draw.text((100, 115), "1-TOUCH EMERGENCY ALERT SYSTEM", fill=COLOR_DANGER, font=font_title)
    draw.text((100, 180), "In high-stress situations, there's no time for menus. Hold for 2 seconds to alert.", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Left SOS Button Display
    bx1, by1, bx2, by2 = 100, 250, 850, 900
    draw.rounded_rectangle([bx1, by1, bx2, by2], radius=24, fill=(28, 20, 22), outline=(120, 40, 40), width=2)
    
    btn_cx, btn_cy = (bx1 + bx2) // 2, (by1 + by2) // 2 - 30
    btn_r = 140
    
    # Progress ring
    ring_pct = min(1.0, ((f - 780) % 90) / 60.0)
    draw.ellipse([btn_cx - btn_r - 20, btn_cy - btn_r - 20, btn_cx + btn_r + 20, btn_cy + btn_r + 20], outline=(60, 25, 25), width=10)
    
    # Pulsing Emergency Core
    draw.ellipse([btn_cx - btn_r, btn_cy - btn_r, btn_cx + btn_r, btn_cy + btn_r], fill=COLOR_DANGER)
    draw.text((btn_cx - 55, btn_cy - 45), "SOS", fill=(255, 255, 255), font=font_hero)
    draw.text((btn_cx - 85, btn_cy + 45), "HOLD 2 SECONDS", fill=(255, 230, 230), font=font_mono)
    
    draw.text((btn_cx - 160, by2 - 90), "Area-level GPS broadcast sent to circle", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Right Actions Grid
    rx1, ry1, rx2, ry2 = 900, 250, 1820, 900
    draw.rounded_rectangle([rx1, ry1, rx2, ry2], radius=24, fill=(24, 28, 36), outline=COLOR_LINE, width=2)
    
    draw.text((rx1 + 40, ry1 + 40), "WHAT HAPPENS INSTANTLY:", fill=COLOR_TEXT_PRIMARY, font=font_h2)
    
    actions = [
        ("📞 Direct 112 Emergency Dial", "Opens the official police/emergency dialer with zero delay. Available to all users, signed-in or guests.", COLOR_DANGER),
        ("💬 Bulk SMS to All Contacts", "Sends your current area coordinates and distress note to up to 5 trusted emergency contacts simultaneously.", COLOR_AMBER),
        ("🟢 WhatsApp 1-Tap Broadcast", "Pre-populates a WhatsApp distress message with coordinates ready to send in one tap.", COLOR_EMERALD),
        ("🛡️ Zero Navigation Blocking", "Emergency buttons stay accessible during navigation without closing or resetting the map.", COLOR_INFO)
    ]
    ay = ry1 + 120
    for title, desc, col in actions:
        draw.rounded_rectangle([rx1 + 30, ay, rx2 - 30, ay + 95], radius=14, fill=(30, 34, 44), outline=col, width=1)
        draw.text((rx1 + 50, ay + 16), title, fill=col, font=font_body_bold)
        draw.text((rx1 + 50, ay + 52), desc, fill=COLOR_TEXT_MUTED, font=font_small)
        ay += 115

def render_scene_6(draw, f):
    # Scene 6: Theme Toggle & Guest Accessibility (990 - 1170 frames)
    draw_header_bar(draw, f, "OVERVIEW")
    
    draw.text((100, 115), "DESIGNED FOR COMFORT & PRIVACY", fill=COLOR_INFO, font=font_title)
    draw.text((100, 180), "Built with modern Web standards, responsive layout, and instant theme switching.", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Split screen preview: Dark mode vs Light mode
    # Left: Dark Mode Card
    lx1, ly1, lx2, ly2 = 100, 260, 930, 880
    draw.rounded_rectangle([lx1, ly1, lx2, ly2], radius=24, fill=(16, 17, 20), outline=COLOR_EMERALD, width=2)
    draw.text((lx1 + 40, ly1 + 40), "🌙 Dark Theme (Default)", fill=COLOR_TEXT_PRIMARY, font=font_h2)
    draw.text((lx1 + 40, ly1 + 95), "Optimized for night walking — prevents screen glare and preserves night vision.", fill=COLOR_TEXT_MUTED, font=font_body)
    
    # Mini card mock inside
    draw.rounded_rectangle([lx1 + 40, ly1 + 170, lx2 - 40, ly1 + 480], radius=16, fill=(28, 30, 38), outline=COLOR_LINE)
    draw.text((lx1 + 70, ly1 + 200), "Route: Mysore Palace ➔ Saraswathipuram", fill=COLOR_TEXT_PRIMARY, font=font_body_bold)
    draw.text((lx1 + 70, ly1 + 250), "SafePath Score: 85/100 · 18 min", fill=COLOR_EMERALD, font=font_body)
    draw.text((lx1 + 70, ly1 + 300), "Status: 4 street lights active ahead", fill=COLOR_TEXT_MUTED, font=font_small)
    draw.rounded_rectangle([lx1 + 70, ly1 + 370, lx1 + 290, ly1 + 430], radius=10, fill=COLOR_EMERALD_DARK)
    draw.text((lx1 + 95, ly1 + 386), "START ROUTE", fill=COLOR_TEXT_PRIMARY, font=font_body_bold)
    
    # Right: Light Mode Card
    rx1, ry1, rx2, ry2 = 980, 260, 1820, 880
    draw.rounded_rectangle([rx1, ry1, rx2, ry2], radius=24, fill=(244, 245, 247), outline=COLOR_LINE, width=2)
    draw.text((rx1 + 40, ry1 + 40), "☀️ Light Theme (Daylight)", fill=(20, 30, 25), font=font_h2)
    draw.text((rx1 + 40, ry1 + 95), "Crisp contrast for bright Mysuru sunshine and daytime commuting.", fill=(100, 110, 115), font=font_body)
    
    draw.rounded_rectangle([rx1 + 40, ry1 + 170, rx2 - 40, ry1 + 480], radius=16, fill=(255, 253, 248), outline=(220, 217, 206))
    draw.text((rx1 + 70, ry1 + 200), "Route: Mysore Palace ➔ Saraswathipuram", fill=(30, 45, 43), font=font_body_bold)
    draw.text((rx1 + 70, ry1 + 250), "SafePath Score: 85/100 · 18 min", fill=(85, 124, 104), font=font_body)
    draw.text((rx1 + 70, ry1 + 300), "Status: 4 street lights active ahead", fill=(105, 117, 112), font=font_small)
    draw.rounded_rectangle([rx1 + 70, ry1 + 370, rx1 + 290, ry1 + 430], radius=10, fill=(85, 124, 104))
    draw.text((rx1 + 95, ry1 + 386), "START ROUTE", fill=(255, 255, 255), font=font_body_bold)

def render_scene_7(draw, f):
    # Scene 7: Outro & GitHub Call to Action (1170 - 1350 frames)
    cx, cy = WIDTH // 2, HEIGHT // 2
    
    # Logo
    draw.rounded_rectangle([cx - 80, cy - 250, cx + 80, cy - 90], radius=32, fill=(28, 48, 40), outline=COLOR_EMERALD, width=4)
    draw.text((cx - 48, cy - 210), "SP", fill=COLOR_TEXT_PRIMARY, font=font_hero)
    
    title = "SafePath · Mysuru"
    tw = draw.textlength(title, font=font_hero)
    draw.text((cx - tw // 2, cy - 40), title, fill=COLOR_TEXT_PRIMARY, font=font_hero)
    
    subtitle = "Move Freely. Feel Safer."
    tw_sub = draw.textlength(subtitle, font=font_title)
    draw.text((cx - tw_sub // 2, cy + 50), subtitle, fill=COLOR_EMERALD, font=font_title)
    
    # Summary box
    draw.rounded_rectangle([cx - 450, cy + 140, cx + 450, cy + 280], radius=20, fill=(24, 28, 36), outline=COLOR_LINE, width=2)
    t1 = "GitHub: github.com/CodeVerse-AI-TS/SafePath"
    tw_t1 = draw.textlength(t1, font=font_body_bold)
    draw.text((cx - tw_t1 // 2, cy + 175), t1, fill=COLOR_TEXT_PRIMARY, font=font_body_bold)
    
    t2 = "Free Public Web App · Live Navigation · Instant SOS"
    tw_t2 = draw.textlength(t2, font=font_small)
    draw.text((cx - tw_t2 // 2, cy + 225), t2, fill=COLOR_EMERALD, font=font_small)

def main():
    print("Initializing video container...")
    container = av.open(OUTPUT_FILE, mode='w')
    stream = container.add_stream('libx264', rate=FPS)
    stream.width = WIDTH
    stream.height = HEIGHT
    stream.pix_fmt = 'yuv420p'
    stream.options = {'crf': '18', 'preset': 'medium'}
    
    print(f"Generating {TOTAL_FRAMES} frames ({TOTAL_FRAMES // FPS}s) at {WIDTH}x{HEIGHT}...")
    
    for f in range(TOTAL_FRAMES):
        img = Image.new('RGB', (WIDTH, HEIGHT), color=COLOR_BG_DARK)
        draw = ImageDraw.Draw(img)
        
        # Route to scene renderer based on frame number
        if f < 180:
            render_scene_1(draw, f)
        elif f < 360:
            render_scene_2(draw, f)
        elif f < 570:
            render_scene_3(draw, f)
        elif f < 780:
            render_scene_4(draw, f)
        elif f < 990:
            render_scene_5(draw, f)
        elif f < 1170:
            render_scene_6(draw, f)
        else:
            render_scene_7(draw, f)
            
        draw_bottom_progress(draw, f)
        
        frame = av.VideoFrame.from_image(img)
        for packet in stream.encode(frame):
            container.mux(packet)
            
        if f % 150 == 0:
            print(f"Rendered {f}/{TOTAL_FRAMES} frames ({int(f/TOTAL_FRAMES*100)}%)...")

    # Flush encoder
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    print("Video generation complete: " + OUTPUT_FILE)

if __name__ == "__main__":
    main()
