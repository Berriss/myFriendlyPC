export const HIGH_RARITIES = new Set(["SEC", "OUR", "UR", "SR", "S", "SY", "HR"]);
export const FOIL_RARITIES = new Set(["R", "RR", "OSR", "S", "SY", "SR", "UR", "OUR", "HR", "SEC"]);

export const HOLOLIVE_COLORS = [
  "White",
  "Green",
  "Red",
  "Blue",
  "Purple",
  "Yellow",
  "Colorless",
  "Multi-color",
];

export const CHEER_COLORS = [
  "White",
  "Green",
  "Red",
  "Blue",
  "Purple",
  "Yellow",
];

export const DECK_COLOR_META = {
  White: { label: "White", hex: "#cbd5e1", barClass: "bar-fill-white", dotClass: "dot-white" },
  Green: { label: "Green", hex: "#22c55e", barClass: "bar-fill-green", dotClass: "dot-green" },
  Red: { label: "Red", hex: "#ef4444", barClass: "bar-fill-red", dotClass: "dot-red" },
  Blue: { label: "Blue", hex: "#3b82f6", barClass: "bar-fill-blue", dotClass: "dot-blue" },
  Purple: { label: "Purple", hex: "#a855f7", barClass: "bar-fill-purple", dotClass: "dot-purple" },
  Yellow: { label: "Yellow", hex: "#eab308", barClass: "bar-fill-yellow", dotClass: "dot-yellow" },
  Colorless: { label: "Neutral", hex: "#64748b", barClass: "bar-fill-colorless", dotClass: "dot-colorless" },
  "Multi-color": {
    label: "Multi",
    hex: "linear-gradient(135deg, #ef4444 0%, #3b82f6 50%, #22c55e 100%)",
    barClass: "bar-fill-multi",
    dotClass: "dot-multi",
  },
};

export const MAIN_GROUP_ORDER_RANK = {
  debut: 1,
  "1st": 2,
  "2nd": 3,
  spot: 4,
  other: 5,
  support: 6,
};

export const WPDF_SECTIONS = [
  { id: "oshi", label: "Oshi" },
  { id: "main", label: "Cartas (Holomem & Support)" },
  { id: "cheer", label: "Cheer" },
  { id: "sealed", label: "Sellados" },
];
