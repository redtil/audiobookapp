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

// Moods of a whole book: one per chapter, smoothed so a single odd chapter
// doesn't flip the music when its neighbours agree.
export async function bookMoods(book, classify) {
  const moods = [];
  const profiles = [];
  for (const chapter of book.chapters) {
    const sentences = chapter.paras.flat().filter((s) => s.trim().length > 3);
    // A sample of up to 120 sentences spread through the chapter is plenty.
    const step = Math.max(1, Math.floor(sentences.length / 120));
    const sample = sentences.filter((_, i) => i % step === 0).slice(0, 120);
    const scores = [];
    for (let i = 0; i < sample.length; i += 16) {
      scores.push(...(await classify(sample.slice(i, i + 16))));
    }
    const profile = chapterProfile(scores);
    profiles.push(profile);
    moods.push(sample.length ? moodFromProfile(profile) : "reflective");
  }
  for (let i = 1; i < moods.length - 1; i++) {
    if (moods[i - 1] === moods[i + 1] && moods[i] !== moods[i - 1] && profiles[i].emotion < 0.25) moods[i] = moods[i - 1];
  }
  return moods;
}
