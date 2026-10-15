// A quick guess at a passage's mood from the words in it, for choosing
// background music when the server hasn't analysed the book. Word lists are
// our own; each word found adds to its moods, and the strongest wins.

const WORDS = {
  tense: "suddenly danger chase hide hid hiding run ran running escape fled flee trap trapped threat warning gun shot shots knife blade attack attacked alarm panic hurry quickly silence footsteps breath breathless heart pounding watching followed caught risk desperate urgent explosion soldiers enemy",
  dark: "death dead die died dying blood bloody kill killed murder corpse grave darkness dark evil fear feared afraid terror horror scream screamed nightmare war cruel pain agony torture shadow shadows despair hell doom",
  sad: "sad sorrow grief grieve mourn mourning tears tear wept weep weeping cry cried lonely alone loss lost miss missed farewell goodbye funeral regret broken heartbroken empty sorry pity tragic tragedy melancholy",
  joyful: "joy happy happiness laugh laughed laughing smile smiled smiling delight delighted glad cheer celebrate celebration bright sunshine dance danced dancing wonderful fun play played playing hope hopeful excited free",
  romantic: "love loved loving lover kiss kissed kisses embrace embraced tender tenderly gentle gently heart hearts darling dear beloved touch touched warmth beautiful softly caress wedding married longing desire",
  mysterious: "strange stranger mystery mysterious secret secrets hidden unknown whisper whispered whispers fog mist ancient legend riddle puzzle clue curious wonder wondered silent ghost magic spell dream dreams shadowy",
  epic: "battle battles army armies king kings kingdom empire glory victory triumph hero heroes heroic sword swords march marched charge throne legend mighty storm thunder conquer conquest rise destiny fate",
  calm: "calm quiet peace peaceful still gentle soft slowly rest rested sleep slept morning garden river sea water breeze meadow sky clouds tea home warm evening sunset field trees birds",
  reflective: "think thought thoughts mind idea ideas believe belief understand reason reasons question questions perhaps consider wisdom knowledge truth meaning nature life history science memory remember remembered learn learned",
};

const lookup = new Map();
for (const [mood, list] of Object.entries(WORDS)) {
  for (const w of list.split(" ")) lookup.set(w, [...(lookup.get(w) || []), mood]);
}

export function guessMood(text) {
  const score = Object.fromEntries(Object.keys(WORDS).map((m) => [m, 0]));
  let words = 0;
  for (const m of text.toLowerCase().matchAll(/[a-z]+/g)) {
    words++;
    for (const mood of lookup.get(m[0]) || []) score[mood]++;
  }
  // Reflective is the gentle default; other moods need a clear signal.
  score.reflective *= 0.6;
  score.calm *= 0.8;
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return words && n / words > 0.002 ? best : "reflective";
}

export function chapterMood(chapter) {
  return guessMood(chapter.paras.flat().join(" "));
}
