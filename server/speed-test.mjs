// Measures how fast Kokoro runs on this machine (used to tune the setup).
import { loadVoice, encodeMp3, toInt16, trimSilence, SAMPLE_RATE } from "./voice.mjs";
import os from "node:os";

const text = [
  "The rain had stopped by the time she reached the station, and the platform was nearly empty.",
  "A single lamp flickered above the timetable, which still promised a train that would never come.",
  "She sat down on the bench, set her bag beside her, and listened to the quiet hum of the rails.",
  "Somewhere far away, a dog barked twice and then fell silent.",
  "It was the kind of night that made you wonder whether the whole town had simply gone to sleep without you.",
];
console.log(`cpus: ${os.cpus().length} × ${os.cpus()[0].model}`);
for (const dtype of (process.argv[2] || "fp32,q8").split(",")) {
  let t = performance.now();
  const speak = await loadVoice({ dtype });
  console.log(`[${dtype}] load ${((performance.now() - t) / 1000).toFixed(1)} s`);
  await speak("Warm up.", "af_heart");
  t = performance.now();
  let samples = 0;
  const parts = [];
  for (const s of text) {
    const a = trimSilence(await speak(s, "af_heart"));
    samples += a.length;
    parts.push(toInt16(a));
  }
  const secs = (performance.now() - t) / 1000;
  const audio = samples / SAMPLE_RATE;
  const te = performance.now();
  const mp3 = encodeMp3(parts);
  console.log(`[${dtype}] ${audio.toFixed(1)} s of speech in ${secs.toFixed(1)} s → ${(audio / secs).toFixed(2)}× real time; mp3 ${mp3.length} bytes in ${((performance.now() - te) / 1000).toFixed(2)} s`);
}
