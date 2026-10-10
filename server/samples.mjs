// Makes a short sample of each voice for the app's "Hear it" button.
// Runs when the site is built; samples already made are kept.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadVoice, trimSilence, encodeMp3, toInt16 } from "./voice.mjs";
import { VOICES } from "../src/voices.js";

const TEXT = "The rain had stopped by the time she reached the station. She sat down on the bench, and listened to the quiet hum of the rails.";
const dir = "public/samples";
mkdirSync(dir, { recursive: true });
const missing = VOICES.filter((v) => !existsSync(`${dir}/${v.id}.mp3`));
if (missing.length) {
  const speak = await loadVoice();
  for (const v of missing) {
    writeFileSync(`${dir}/${v.id}.mp3`, encodeMp3([toInt16(trimSilence(await speak(TEXT, v.id)))], 64));
    console.log(`sample: ${v.id}`);
  }
}
