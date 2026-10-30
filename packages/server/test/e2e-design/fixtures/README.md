# Screenshot-harness fixtures

`clip.webm` (J64, the video viewer): a one-second, 320×180 VP8 clip of concentric engraved rings on the light paper
colour, drawn by the harness's own canvas code and recorded with the browser's MediaRecorder (Chromium headless
shell, `video/webm;codecs=vp8`, 200 kbit/s), then remuxed with `ffmpeg -i clip.webm -c copy` so the file carries its
duration. No third-party footage: it is ours, MIT like the rest of the repository.

Every other fixture (images, the PDF, the notebook, audio, fonts, the long log) is generated in `shots.mjs` at run time.
