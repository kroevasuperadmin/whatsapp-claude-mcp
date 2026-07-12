#!/usr/bin/env python3
"""Turn any WhatsApp attachment into something Claude can consume.
  image/pdf/doc -> pass the path through (Claude Reads it)
  video         -> extract evenly-spaced frames (ffmpeg) -> print frame paths
  audio/voice   -> transcribe via AssemblyAI -> print the transcript

Usage: python process_media.py <downloaded_file_path>

Requires:
  pip install requests
  ffmpeg on PATH (for video/audio)
  ASSEMBLYAI_API_KEY env var (free at assemblyai.com)
"""
import sys, os, subprocess, re, time, requests

API_KEY = os.environ.get("ASSEMBLYAI_API_KEY", "")

IMAGE = {"jpg","jpeg","png","webp","gif","bmp"}
VIDEO = {"mp4","mkv","mov","webm","3gp","3gpp","avi","m4v"}
AUDIO = {"ogg","opus","oga","mp3","m4a","wav","aac","amr"}
DOC   = {"pdf","docx","doc","xlsx","pptx","csv","txt","md"}

def ext(p): return os.path.splitext(p)[1].lower().lstrip(".")

def duration(path):
    r = subprocess.run(["ffmpeg","-i",path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.?\d*)", r.stderr)
    if m:
        h,mi,s = m.groups(); return int(h)*3600+int(mi)*60+float(s)
    return 0.0

def do_video(path):
    outdir = path + "_frames"
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        try: os.remove(os.path.join(outdir,f))
        except OSError: pass
    dur = duration(path)
    maxf = 12
    fps = "1"
    if dur and dur > 0:
        rate = min(maxf/dur, 5.0); rate = max(rate, 0.05)
        fps = f"{rate:.4f}"
    subprocess.run(["ffmpeg","-y","-i",path,"-vf",f"fps={fps},scale=640:-1",
                    "-frames:v",str(maxf), os.path.join(outdir,"f%03d.jpg")],
                   capture_output=True)
    fs = sorted(os.path.join(outdir,f) for f in os.listdir(outdir) if f.endswith(".jpg"))
    print(f"VIDEO ({dur:.0f}s) -> {len(fs)} frames (Read these):")
    for f in fs: print(f)

def do_audio(path):
    if not API_KEY:
        print("ERROR: ASSEMBLYAI_API_KEY env var not set. Get a free key at assemblyai.com")
        sys.exit(1)
    h = {"authorization": API_KEY}
    with open(path,"rb") as f:
        up = requests.post("https://api.assemblyai.com/v2/upload", headers=h, data=f).json()["upload_url"]
    tid = requests.post("https://api.assemblyai.com/v2/transcript",
                        headers={**h,"content-type":"application/json"},
                        json={"audio_url":up,"speech_models":["universal-2"]}).json()["id"]
    for _ in range(200):
        d = requests.get(f"https://api.assemblyai.com/v2/transcript/{tid}", headers=h).json()
        if d["status"]=="completed":
            print("AUDIO TRANSCRIPT:\n" + (d.get("text") or "(no speech detected)")); return
        if d["status"]=="error":
            print("AUDIO ERROR: " + str(d.get("error"))); return
        time.sleep(3)
    print("AUDIO ERROR: timed out")

def main():
    if len(sys.argv) < 2:
        print("usage: process_media.py <file>"); sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print("FILE NOT FOUND: " + path); sys.exit(1)
    e = ext(path)
    if e in IMAGE: print("IMAGE (Read this): " + path)
    elif e in VIDEO: do_video(path)
    elif e in AUDIO: do_audio(path)
    elif e in DOC: print("DOC (Read this): " + path)
    else: print(f"UNKNOWN type .{e} (try Read): " + path)

if __name__ == "__main__":
    main()
