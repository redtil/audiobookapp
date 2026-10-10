// The voices offered in the app, best-rated first. scripts/fetch-model.mjs
// bundles these with the site.
export const VOICES = [
  { id: "af_heart", name: "Heart", accent: "US", gender: "female" },
  { id: "af_bella", name: "Bella", accent: "US", gender: "female" },
  { id: "af_nicole", name: "Nicole", accent: "US", gender: "female", note: "soft" },
  { id: "af_aoede", name: "Aoede", accent: "US", gender: "female" },
  { id: "af_kore", name: "Kore", accent: "US", gender: "female" },
  { id: "am_fenrir", name: "Fenrir", accent: "US", gender: "male" },
  { id: "am_michael", name: "Michael", accent: "US", gender: "male" },
  { id: "am_puck", name: "Puck", accent: "US", gender: "male" },
  { id: "bf_emma", name: "Emma", accent: "UK", gender: "female" },
  { id: "bm_george", name: "George", accent: "UK", gender: "male" },
  { id: "bm_fable", name: "Fable", accent: "UK", gender: "male" },
];

export const voiceLabel = (id) => {
  const v = VOICES.find((x) => x.id === id);
  return v ? `${v.name} (${v.accent}, ${v.gender})` : id;
};
