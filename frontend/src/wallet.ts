const K = 'sundebt_v3';
const today = () => new Date().toISOString().slice(0, 10);

export type SessionLog = {
  duration: number;
  earned: number;
  xp: number;
  conf: 'confirmed' | 'estimated' | 'unavailable';
  date: string;
  steps: number | null;
  stepsSupported: boolean;
  screenVisible: number;
  screenHidden: number;
  lux: number | null;
  cameraLum: number | null;
  mission: string;
};

export type Wallet = {
  day: string;
  sunMinutes: number;
  sunDebt: number;
  earnedToday: number;
  spentToday: number;
  solXP: number;
  sessions: SessionLog[];
  gateLog: { app: string; mins: number; date: string }[];
};

export const CAP = 90;
export const STEP_BONUS_DIVISOR = 100;

export function loadWallet(): Wallet {
  try {
    const raw = localStorage.getItem(K);
    if (!raw) return freshWallet();
    const w: Wallet = { ...freshWallet(), ...JSON.parse(raw) };
    if (w.day !== today()) {
      w.day = today();
      w.earnedToday = 0;
      w.spentToday = 0;
    }
    return w;
  } catch {
    return freshWallet();
  }
}

export function saveWallet(w: Wallet) {
  localStorage.setItem(K, JSON.stringify(w));
}

function freshWallet(): Wallet {
  return {
    day: today(),
    sunMinutes: 0,
    sunDebt: 0,
    earnedToday: 0,
    spentToday: 0,
    solXP: 0,
    sessions: [],
    gateLog: [],
  };
}

export const SOL_STAGES = [
  { xp: 0, emoji: '🌱', name: 'Seed', desc: 'A seed. Wake me with sunlight.' },
  { xp: 30, emoji: '🌿', name: 'Sprout', desc: 'Sprouting. I felt that sun.' },
  { xp: 100, emoji: '🪴', name: 'Plant', desc: 'Leaves out. Keep getting sun.' },
  { xp: 250, emoji: '🌳', name: 'Tree', desc: 'Full tree. Go touch some grass.' },
];

export const MISSIONS = [
  'Spend 5 minutes outside without your phone.',
  'Notice three things you normally overlook.',
  'Take a short walk in a familiar, comfortable place.',
  'Sit somewhere comfortable outdoors for 10 minutes.',
  'Notice a plant or tree from a safe public place.',
  'Listen to the sounds around you for 2 minutes.',
  'Walk on a path or paved area that feels comfortable.',
  'Watch the sky change for 5 minutes.',
];

export function getSolStage(xp: number) {
  let stage = SOL_STAGES[0];
  for (const s of SOL_STAGES) if (xp >= s.xp) stage = s;
  return stage;
}

export function getMission(sessionCount: number) {
  return MISSIONS[sessionCount % MISSIONS.length];
}

export function computeConfidence(
  lux: number | null,
  cameraLum: number | null
): 'confirmed' | 'estimated' | 'unavailable' {
  // Browser light readings are never proof of outdoor exposure.
  if (lux !== null || cameraLum !== null) return 'estimated';
  return 'unavailable';
}
