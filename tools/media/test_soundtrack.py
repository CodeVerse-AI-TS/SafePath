import numpy as np

def generate_soundtrack(duration_sec=76.0, sample_rate=44100):
    total_samples = int(duration_sec * sample_rate)
    t = np.linspace(0, duration_sec, total_samples, endpoint=False)
    
    left = np.zeros(total_samples, dtype=np.float32)
    right = np.zeros(total_samples, dtype=np.float32)
    
    # 1. Warm Sub-Bass drone (D1 = 36.7Hz -> Bb0 = 29.1Hz -> F1 = 43.65Hz -> G1/D1)
    # Chord changes at: 0s (D), 16s (Bb), 34s (F), 51s (C), 59s (D maj uplift), 68s (D final)
    freq_map = [
        (0.0, 16.0, 36.71, 0.25),
        (16.0, 34.0, 29.14, 0.30),
        (34.0, 51.0, 43.65, 0.32),
        (51.0, 59.0, 32.70, 0.35),
        (59.0, 68.0, 36.71, 0.40),
        (68.0, 76.0, 36.71, 0.25)
    ]
    for start, end, freq, vol in freq_map:
        mask = (t >= start) & (t < end)
        tt = t[mask]
        fade_in = np.clip((tt - start) / 1.5, 0, 1)
        fade_out = np.clip((end - tt) / 1.5, 0, 1)
        envelope = fade_in * fade_out * vol
        bass_wave = np.sin(2 * np.pi * freq * tt) + 0.3 * np.sin(4 * np.pi * freq * tt)
        left[mask] += bass_wave * envelope
        right[mask] += bass_wave * envelope
        
    # 2. Atmospheric Ambient Synth Pad (harmonics with chorus/stereo spread)
    pad_chords = [
        # (start, end, [freqs], vol)
        (0.0, 16.0, [146.83, 174.61, 220.00, 261.63], 0.15),   # Dm7
        (16.0, 34.0, [116.54, 174.61, 233.08, 293.66], 0.18),  # Bbmaj7
        (34.0, 51.0, [130.81, 174.61, 220.00, 261.63], 0.20),  # Fmaj
        (51.0, 59.0, [130.81, 164.81, 196.00, 246.94], 0.22),  # Cmaj/E
        (59.0, 68.0, [146.83, 185.00, 220.00, 293.66], 0.25),  # Dmaj (uplifting key change!)
        (68.0, 76.0, [146.83, 185.00, 220.00, 293.66, 440.0], 0.22) # Dmaj resolution
    ]
    for start, end, freqs, vol in pad_chords:
        mask = (t >= start) & (t < end)
        tt = t[mask]
        env = np.clip((tt - start) / 2.0, 0, 1) * np.clip((end - tt) / 2.0, 0, 1) * vol
        for i, f in enumerate(freqs):
            # Detuned oscillators for lush analog chorus
            detune = 0.4 * (i % 2 * 2 - 1)
            wave_l = np.sin(2 * np.pi * (f - detune) * tt)
            wave_r = np.sin(2 * np.pi * (f + detune) * tt)
            left[mask] += wave_l * env * (0.8 / len(freqs))
            right[mask] += wave_r * env * (0.8 / len(freqs))

    # 3. Cinematic Pulse / Heartbeat (80 BPM = 0.75s per beat) from t=16s to 68s
    pulse_times = np.arange(16.0, 67.0, 0.75)
    for pt in pulse_times:
        pulse_mask = (t >= pt) & (t < pt + 0.35)
        ptt = t[pulse_mask] - pt
        pulse_env = np.exp(-ptt * 12.0) * 0.18
        # Deep kick / pulse thud (sweep from 90Hz to 40Hz)
        freq_sweep = 90.0 - 50.0 * (ptt / 0.35)
        pulse_wave = np.sin(2 * np.pi * freq_sweep * ptt)
        left[pulse_mask] += pulse_wave * pulse_env
        right[pulse_mask] += pulse_wave * pulse_env

    # 4. Melodic Arp Chimes (Scene 2, 3, 5, 7, 8, 9)
    motif_notes = [
        # (time, freq, duration)
        (9.0, 440.0, 1.2), (10.5, 523.25, 1.2), (12.0, 587.33, 1.5), (13.5, 659.25, 2.0),
        (20.0, 587.33, 1.2), (21.5, 523.25, 1.2), (23.0, 440.0, 2.0),
        (36.0, 440.0, 1.2), (38.0, 523.25, 1.2), (40.0, 659.25, 2.0),
        (52.5, 739.99, 0.8), (53.5, 880.0, 2.5), # Panic button press shimmer!
        (60.0, 587.33, 1.0), (61.5, 739.99, 1.0), (63.0, 880.0, 1.5), (65.0, 1174.66, 3.0),
        (69.0, 587.33, 1.5), (71.0, 739.99, 1.5), (73.0, 880.0, 3.0) # Final crystal chord
    ]
    for nt, nf, nd in motif_notes:
        mask = (t >= nt) & (t < nt + nd)
        ntt = t[mask] - nt
        bell_env = np.exp(-ntt * 2.8) * 0.16
        # Sine with delicate second harmonic
        bell = np.sin(2 * np.pi * nf * ntt) + 0.3 * np.sin(4 * np.pi * nf * ntt)
        left[mask] += bell * bell_env * 0.7
        right[mask] += bell * bell_env * 0.9

    # Master limiter & fade in / fade out
    master_fade = np.clip(t / 2.0, 0, 1) * np.clip((76.0 - t) / 3.0, 0, 1)
    left = np.clip(left * master_fade, -0.95, 0.95)
    right = np.clip(right * master_fade, -0.95, 0.95)
    
    stereo = np.vstack([left, right]).astype(np.float32)
    return stereo

if __name__ == "__main__":
    stereo = generate_soundtrack()
    print("Soundtrack shape:", stereo.shape, "Dtype:", stereo.dtype)
