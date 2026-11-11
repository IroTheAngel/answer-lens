# Answer Lens

Snap a question on any web page and get the answer with the steps. Also has an AI chat and flashcards.
No account, no daily limit: it uses Chrome's built-in AI (Gemini Nano), which runs on your own PC.

## Install

1. Download this project (**Code → Download ZIP**) and unzip it somewhere you'll keep it, like Documents. Chrome runs the extension from that folder, so don't delete it.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it).
4. Pin Answer Lens from the puzzle-piece menu and click it. The side panel opens. The first time, press **Set up the AI**: Chrome downloads its free AI model once (a few GB).

To update: replace the folder with the new download, then press the reload arrow on the Answer Lens card in `chrome://extensions`.

**Needs:** Chrome 138 or newer on Windows, Mac or Linux, about 22 GB of free disk space, and either a graphics card with more than 4 GB of memory or 16 GB of RAM.

## Snapping

| Do this | What happens |
|---|---|
| Click the round button | Snaps the whole screen and finds the question (Smart Scan) |
| Shift + click | Drag a box around just the question |
| Alt + click | Adds a snap to a multi-snap (up to 3). Click normally to send them together |
| Alt + Shift + click | Adds a box to a multi-snap |
| Ctrl + click | A full, detailed answer |
| Alt + Shift + X | Snap the screen (shortcut) |
| Alt + Shift + S | Select an area (shortcut) |
| Right-click selected text or a picture | "Ask Answer Lens about…" |
| Esc | Cancel selecting |
| Drag the button | Move it |

The answer pops up with a copy button, an explain button and the steps.

## Side panel

- **Answers**: every answer you've snapped, with search, copy, explain, "ask in chat" and delete.
- **Chat**: full AI chat. Saved chats grouped by date, search, new chat, delete (Shift + click skips the question). You can add up to 10 pictures (button, paste or drop), turn on "Think harder", edit and resend your messages, and copy any message or code block. Maths is shown properly.
- **Study**: flashcard sets. The AI makes them from a topic, or you can make them from your snapped answers. Flip with a click or Space, move with ← →, shuffle, reset, edit/add/remove cards, delete sets.
- **Settings**: on/off, Smart Scan, Shift + click area select, the button on pages, answer display time, popup position (3×3 grid or next to the snap), explain the last question, open chat, shortcuts, clear history, reset all settings.
- **Maths and embedded pages**: it reads maths drawn by KaTeX, MathJax (2, 3 and 4) and MathML, and questions inside embedded frames (common on school sites). Each answer card has **What it read**, so you can see exactly what it got from the page.
- **Hebrew** (Settings → Language): Hebrew questions are translated into English for the AI with Chrome's built-in translator, and the answer comes back in Hebrew, shown right to left. When the answer is one of the choices on the page, you see that choice exactly as the page wrote it. Press **Set up Hebrew** once (a small download). "Answer language" can be Auto, English or Hebrew.
- **Subtle mode** (Settings → Appearance): the button gets small and faded until you hover over it, and answers show as one small line that doesn't cover the page. Click the line to see the steps. With Subtle mode on, you can also turn on **Invisible button**: the button can't be seen, but clicking its spot still snaps. You can also turn off "Show answers on the page" so answers only appear in the panel.

## Good to know

- The side panel is where the AI runs, so it has to be open. The button and the shortcuts open it for you.
- The on-device AI is small. It's fast and free, but it can be wrong, especially on hard maths. It thinks in English; Hebrew goes through the translator, so a strange translation can make an answer wrong.
- Everything (history, chats, flashcards) is saved only on this PC.
- If the panel says the AI isn't available, open `chrome://on-device-internals` to see why.
