// Reads a book and decides the mood of each chapter, for its background music.
//
// Every sentence goes through an emotion model (GoEmotions: 28 emotions, MIT
// licence). Each emotion has a place on the valence (unpleasant..pleasant)
// and arousal (calm..intense) map that music psychology uses to link feelings
// to music; a chapter's mood comes from where its sentences land on that map,
// plus which emotions dominate.

export const EMOTION_MODEL = "Cohee/distilbert-base-uncased-go-emotions-onnx";

// [valence, arousal], roughly after Russell's circumplex.
const PLACE = {
  admiration: [0.6, 0.3], amusement: [0.7, 0.5], anger: [-0.6, 0.8], annoyance: [-0.4, 0.5],
  approval: [0.4, 0.1], caring: [0.6, 0], confusion: [-0.2, 0.3], curiosity: [0.2, 0.5],
  desire: [0.4, 0.6], disappointment: [-0.5, -0.2], disapproval: [-0.4, 0.2], disgust: [-0.6, 0.4],
  embarrassment: [-0.4, 0.4], excitement: [0.7, 0.8], fear: [-0.6, 0.8], gratitude: [0.7, 0.1],
  grief: [-0.8, -0.4], joy: [0.8, 0.5], love: [0.8, 0.3], nervousness: [-0.4, 0.7],
  optimism: [0.6, 0.3], pride: [0.6, 0.5], realization: [0.1, 0.3], relief: [0.5, -0.3],
  remorse: [-0.6, -0.2], sadness: [-0.7, -0.4], surprise: [0.1, 0.7],
};

const GROUPS = {
  romantic: ["love", "caring", "desire"],
  epic: ["pride", "admiration", "excitement"],
  fear: ["fear", "nervousness"],
  sorrow: ["sadness", "grief", "remorse", "disappointment"],
  wonder: ["curiosity", "confusion", "surprise", "realization"],
  anger: ["anger", "annoyance", "disgust"],
};

// Sum of the emotions in each sentence, ignoring "neutral".
export function chapterProfile(sentenceScores) {
  const total = {};
  let v = 0;
  let a = 0;
  let weight = 0;
  for (const scores of sentenceScores) {
    for (const { label, score } of scores) {
      if (label === "neutral" || !PLACE[label]) continue;
      total[label] = (total[label] || 0) + score;
      v += PLACE[label][0] * score;
      a += PLACE[label][1] * score;
      weight += score;
    }
  }
  const n = Math.max(1, sentenceScores.length);
  return {
    valence: weight ? v / weight : 0,
    arousal: weight ? a / weight : 0,
    emotion: weight / n, // how emotional the chapter is at all (0..~1)
    groups: Object.fromEntries(Object.entries(GROUPS).map(([g, labels]) => [g, labels.reduce((s, l) => s + (total[l] || 0), 0) / (weight || 1)])),
  };
}

export function moodFromProfile({ valence, arousal, emotion, groups }) {
  if (emotion < 0.12) return "reflective"; // mostly matter-of-fact text
  if (groups.wonder > 0.45 && Math.abs(valence) < 0.25) return "mysterious";
  if (valence > 0.15) {
    if (groups.romantic > 0.35) return "romantic";
    if (groups.epic > 0.4 && arousal > 0.35) return "epic";
    return arousal > 0.4 ? "joyful" : "calm";
  }
  if (valence < -0.15) {
    if (groups.fear + groups.anger > groups.sorrow) {
      // Fear alone is suspense; fear with anger, disgust or grief is dark.
      return groups.anger + groups.sorrow > 0.12 && emotion > 0.3 ? "dark" : "tense";
    }
    return "sad";
  }
  return groups.wonder > 0.3 ? "mysterious" : "reflective";
}

// How the mood moves through a chapter. Every sentence is read; each
// sentence's mood comes from the sentences around it (a window of about a
// paragraph either side), and the music only changes when a new mood holds
// for a while, so it follows scenes rather than single lines.
const WINDOW = 6; // sentences either side
const HOLD = 8; // a new mood must last this many sentences
const MIN_SEGMENT = 12; // and a segment at least this long

export function chapterSegments(scores) {
  if (!scores.length) return [{ at: 0, mood: "reflective", intensity: 1 }];
  const local = scores.map((_, i) => {
    const profile = chapterProfile(scores.slice(Math.max(0, i - WINDOW), i + WINDOW + 1));
    return { mood: moodFromProfile(profile), arousal: profile.arousal, emotion: profile.emotion };
  });
  const segments = [{ at: 0, mood: local[0].mood }];
  let run = null; // { mood, from, length } of a mood that might take over
  for (let i = 1; i < local.length; i++) {
    const current = segments[segments.length - 1];
    const m = local[i].mood;
    if (m === current.mood) {
      run = null;
      continue;
    }
    run = run && run.mood === m ? { ...run, length: run.length + 1 } : { mood: m, from: i, length: 1 };
    if (run.length >= HOLD && run.from - current.at >= MIN_SEGMENT) {
      segments.push({ at: run.from, mood: m });
      run = null;
    }
  }
  // Louder in intense passages, softer in quiet ones.
  segments.forEach((seg, k) => {
    const end = segments[k + 1]?.at ?? local.length;
    const part = local.slice(seg.at, end);
    const arousal = part.reduce((n, x) => n + x.arousal, 0) / part.length;
    const emotion = part.reduce((n, x) => n + x.emotion, 0) / part.length;
    seg.intensity = +Math.min(1.3, Math.max(0.7, 0.85 + 0.5 * arousal * Math.min(1, emotion * 2))).toFixed(2);
  });
  return segments;
}

// The whole book: { chapters: [[{ at: sentence, mood, intensity }]], moods:
// [the main mood of each chapter] }.
export async function bookMoods(book, classify) {
  const chapters = [];
  const moods = [];
  for (const chapter of book.chapters) {
    const sentences = chapter.paras.flat();
    const scores = [];
    for (let i = 0; i < sentences.length; i += 32) {
      const batch = sentences.slice(i, i + 32);
      const real = batch.map((t, k) => (t.trim().length > 3 ? k : -1)).filter((k) => k >= 0);
      const out = real.length ? await classify(real.map((k) => batch[k])) : [];
      const byIndex = new Map(real.map((k, j) => [k, out[j]]));
      batch.forEach((_, k) => scores.push(byIndex.get(k) || [{ label: "neutral", score: 1 }]));
    }
    const segments = chapterSegments(scores);
    chapters.push(segments);
    // Main mood: the one covering the most sentences.
    const cover = {};
    segments.forEach((seg, k) => {
      cover[seg.mood] = (cover[seg.mood] || 0) + ((segments[k + 1]?.at ?? sentences.length) - seg.at);
    });
    moods.push(Object.entries(cover).sort((x, y) => y[1] - x[1])[0][0]);
  }
  return { chapters, moods };
}
