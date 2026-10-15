#!/usr/bin/env python3
"""Synthesizes a restrained promo soundtrack with numpy only: a warm pad, sparse soft plucks and
quiet UI sounds cued to the on-screen timeline in scene.html. Writes out/audio_raw.wav (16-bit
stereo, 48 kHz); loudness-normalize it with ffmpeg afterwards. Usage: python3 audio.py"""
import numpy as np
import wave
import os

SR = 48000
DUR = 29.5
N = int(SR * DUR)
rng = np.random.default_rng(7)
t_full = np.arange(N) / SR


def buf():
    return np.zeros((N, 2), dtype=np.float64)


def put(dst, x, at, pan=0.0, gain=1.0):
    """Mix mono x into stereo dst starting at `at` seconds; pan -1..1 (equal power)."""
    i = int(at * SR)
    if i >= N or i + len(x) <= 0:
        return
    a = max(0, -i)
    n = min(len(x) - a, N - max(i, 0))
    ang = (pan + 1) * np.pi / 4
    seg = x[a:a + n] * gain
    dst[max(i, 0):max(i, 0) + n, 0] += seg * np.cos(ang)
    dst[max(i, 0):max(i, 0) + n, 1] += seg * np.sin(ang)


def env(n, a, r, curve=2.0):
    """Attack/release envelope over n samples (a, r in seconds)."""
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    if na > 0:
        e[:na] = np.linspace(0, 1, na) ** curve
    if nr > 0:
        e[-nr:] *= np.linspace(1, 0, nr) ** curve
    return e


def expdec(n, tau):
    return np.exp(-np.arange(n) / (tau * SR))


def tone(freq, d, harm=(1.0,), phase=0.0):
    t = np.arange(int(d * SR)) / SR
    f = np.asarray(freq) if np.ndim(freq) else freq
    ph = 2 * np.pi * np.cumsum(f * np.ones_like(t)) / SR if np.ndim(freq) else 2 * np.pi * f * t
    return sum(h * np.sin((k + 1) * ph + phase) for k, h in enumerate(harm))


def fft_filter(x, lo=None, hi=None, order=2.0):
    """Smooth band-limit through the spectrum (zero phase)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    g = np.ones_like(f)
    if lo:
        g *= 1 / (1 + (lo / np.maximum(f, 1e-3)) ** (2 * order))
    if hi:
        g *= 1 / (1 + (np.maximum(f, 1e-3) / hi) ** (2 * order))
    return np.fft.irfft(X * g, len(x))


def noise(d):
    return rng.standard_normal(int(d * SR))


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def reverb_ir(d=2.6, damp=5200):
    n = int(d * SR)
    ir = rng.standard_normal((n, 2)) * np.exp(-np.arange(n)[:, None] / (0.62 * SR))
    for c in range(2):
        ir[:, c] = fft_filter(ir[:, c], hi=damp, order=1)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    return ir / np.sqrt((ir ** 2).sum() / 2)


def convolve(x, ir):
    out = np.zeros_like(x)
    L = len(x) + len(ir)
    nfft = 1 << (L - 1).bit_length()
    for c in range(2):
        out[:, c] = np.fft.irfft(np.fft.rfft(x[:, c], nfft) * np.fft.rfft(ir[:, c], nfft), nfft)[: len(x)]
    return out


# ------------------------------------------------------------------ music
BPM = 84
BEAT = 60 / BPM
BAR = BEAT * 4
# one chord per bar: Am - F - C - G (root midi, tones in semitones)
PROG = [(57, [0, 3, 7, 12]), (53, [0, 4, 7, 12]), (60, [0, 4, 7, 12]), (55, [0, 4, 7, 12])]


def music():
    pad, notes, bass = buf(), buf(), buf()
    bars = int(np.ceil(DUR / BAR)) + 1
    for b in range(bars):
        t0 = b * BAR
        root, tones = PROG[b % 4]
        # pad: detuned, low-passed, slow attack
        dpad = BAR + 1.6
        for n in [root + 12 + x for x in tones[:3]] + [root]:
            for det in (-0.06, 0.0, 0.06):
                x = tone(midi(n + det), dpad, harm=[1 / (k + 1) ** 1.4 for k in range(6)])
                x = fft_filter(x, hi=1400, order=1) * env(len(x), 1.1, 1.4)
                put(pad, x, t0 - 0.3, pan=rng.uniform(-0.4, 0.4), gain=0.05)
        if t0 >= 2.5:
            x = tone(midi(root - 12), BAR * 0.9, harm=(1.0, 0.2)) * env(int(BAR * 0.9 * SR), 0.05, 0.5)
            put(bass, x, t0, gain=0.11)
        # sparse soft plucks: three notes per bar, only from 3 s on
        if t0 >= 2.8:
            for beat, idx in ((0.0, 1), (1.5, 2), (2.5, 3)):
                n = root + 24 + tones[idx]
                put(notes, pluck(midi(n), 1.0) * 0.8, t0 + beat * BEAT, pan=0.25 if idx != 2 else -0.25, gain=0.07)
    tg = t_full[:, None]
    g_pad = 0.6 + 0.4 * np.clip((tg - 1.0) / 3, 0, 1)
    g_notes = intensity(tg, 3.0, 28.5, 1.5) * (0.5 + 0.5 * np.clip((tg - 14) / 6, 0, 1))
    g_bass = intensity(tg, 2.5, 27.0, 1.5)
    end_fade = np.clip((DUR - tg) / 2.2, 0, 1)
    return (pad * g_pad + notes * g_notes + bass * g_bass) * end_fade


def intensity(t, a, b, fade=1.0):
    return np.clip((t - a) / fade, 0, 1) * np.clip((b - t) / fade, 0, 1)


# ------------------------------------------------------------------ sound design
def swish(d=0.55):
    """Soft band-limited air sweep, low level; returns mono."""
    n = int(d * SR)
    x = fft_filter(noise(d), lo=600, hi=5200, order=2)
    tt = np.linspace(0, 1, n)
    return x * np.sin(np.pi * tt) ** 2 / (np.abs(x).max() + 1e-9)


def bell(freq, d=1.6, bright=0.6):
    t = np.arange(int(d * SR)) / SR
    parts = [(1.0, 1.0, 1.0), (2.0, 0.25 * bright, 0.5), (3.01, 0.1 * bright, 0.3)]
    return sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / (tau * d / 1.6)) for r, a, tau in parts) * np.minimum(1, t / 0.004)


def pluck(freq, d=0.8):
    n = int(d * SR)
    x = tone(freq, d, harm=(1.0, 0.4, 0.15)) * expdec(n, 0.22)
    return fft_filter(x, hi=4200, order=1) * np.minimum(1, np.arange(n) / (0.004 * SR))


def tick(freq=2800, d=0.05):
    n = int(d * SR)
    return np.sin(2 * np.pi * freq * np.arange(n) / SR) * expdec(n, 0.012)


def pop(freq0=520, freq1=820, d=0.1):
    n = int(d * SR)
    f = np.linspace(freq0, freq1, n)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * expdec(n, 0.035) * np.minimum(1, np.arange(n) / (0.003 * SR))


def sfx():
    dry, send = buf(), buf()

    # logo: one soft bell and a tiny tick under the tagline
    put(send, bell(midi(81), 3.0, 0.5), 0.55, gain=0.12)
    put(send, bell(midi(88), 3.0, 0.4), 0.62, gain=0.07)
    put(dry, tick(2400), 1.1, gain=0.06)

    # scene changes: quiet swish, panned right -> left
    for k, c in enumerate([3.1, 8.6, 14.0, 20.7, 24.0, 26.7]):
        w = swish(0.55)
        pan = np.linspace(0.5, -0.5, len(w))
        ang = (pan + 1) * np.pi / 4
        i0 = int((c - 0.15) * SR)
        dry[i0:i0 + len(w)] += np.stack([w * np.cos(ang), w * np.sin(ang)], 1) * 0.1

    # scene 2: callout
    put(dry, pop(), 7.2, gain=0.1)
    put(send, bell(midi(88), 2.0), 7.22, gain=0.1)

    # scene 3: three green badges, then the callout
    for i, n in enumerate([76, 79, 83]):
        put(dry, pluck(midi(n + 12), 0.7), 11.9 + i * 0.3, pan=0.3, gain=0.12)
        put(dry, tick(3400), 11.9 + i * 0.3, pan=0.3, gain=0.06)
    put(dry, pop(), 13.4, gain=0.1)
    put(send, bell(midi(86), 2.0), 13.42, gain=0.1)

    # scene 4: KPI rings, chart sweep, closing chime
    for i, n in enumerate([69, 72, 76, 81]):
        put(dry, pluck(midi(n + 12), 0.7), 17.3 + i * 0.22, pan=-0.4 + i * 0.27, gain=0.11)
    sweep = fft_filter(noise(0.9), lo=900, hi=3800, order=2) * np.linspace(0, 1, int(0.9 * SR)) ** 1.5
    put(dry, sweep / (np.abs(sweep).max() + 1e-9), 19.0, gain=0.05)
    for j, n in enumerate([84, 91]):
        put(send, bell(midi(n), 2.4), 19.9 + j * 0.06, gain=0.1)

    # scene 5: three cards settling
    for i, n in enumerate([69, 72, 76]):
        put(dry, pluck(midi(n + 12), 0.9), 21.0 + i * 0.2, pan=(i - 1) * 0.5, gain=0.12)
        put(send, bell(midi(n + 24), 1.8), 21.0 + i * 0.2, pan=(i - 1) * 0.5, gain=0.06)

    # scene 6: Telegram message pops
    for a, n in [(24.4, 84), (25.1, 88), (25.8, 79)]:
        put(dry, pop(620, 1000, 0.08), a, pan=-0.2, gain=0.14)
        put(send, bell(midi(n), 1.6), a + 0.04, pan=-0.2, gain=0.08)

    # outro: warm chord of bells
    for j, n in enumerate([69, 76, 81, 88]):
        put(send, bell(midi(n), 3.4, 0.5), 27.0 + j * 0.06, pan=(j - 1.5) * 0.25, gain=0.1)
    return dry, send


def main():
    ir = reverb_ir()
    m = music()
    dry, send = sfx()
    wet = convolve(send, ir)
    mus_wet = convolve(m * 0.3, ir[: int(1.6 * SR)])
    out = m * 0.9 + mus_wet * 0.5 + dry * 1.0 + wet * 1.0
    out = np.tanh(out * 0.9) / np.tanh(0.9)
    fade = np.clip(t_full / 0.05, 0, 1) * np.clip((DUR - t_full) / 1.2, 0, 1)
    out *= fade[:, None]
    peak = np.abs(out).max()
    out = out / peak * 0.89
    os.makedirs("out", exist_ok=True)
    pcm = (out * 32767).astype("<i2")
    with wave.open("out/audio_raw.wav", "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print("wrote out/audio_raw.wav", round(len(out) / SR, 2), "s, peak", round(float(peak), 3))


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    main()
