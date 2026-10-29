# control/

Written by the website's Admin page (and readable by hand):

| File | Read by | Meaning |
|---|---|---|
| `rig.json` | lab agent (every cycle, ~20 s) | `{"accepting": true/false, "note": "...", "updated": "..."}`: allow or pause web jobs; the note is shown to visitors while paused. Created on the first pause/resume from the Admin page. |
| `blocked.json` | request checker (GitHub Action) and lab agent | `{"users": ["name", ...]}`: GitHub accounts whose requests are closed automatically and skipped by the rig. |
