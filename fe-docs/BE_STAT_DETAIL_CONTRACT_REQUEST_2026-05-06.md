# BE Request — Stat Detail Breakdown Contract (2026-05-06)

## Ringkasan
Frontend sekarang menampilkan **primary stat** + **stat detail** per kategori di Character Detail dan Creature Detail.

## Character Contract
Primary stat:
- combat
- intelligence
- charisma
- stealth
- perception

`perception` menggantikan `endurance` sebagai stat utama karakter.

```ts
character.stats = {
  combat: number;
  intelligence: number;
  charisma: number;
  stealth: number;
  perception: number;
  endurance?: number; // fallback transisi
  detail?: {
    combat?: { strength: number; defense: number; agility: number; endurance: number; adaptation: number; };
    intelligence?: { iq: number; eq: number; sq: number; };
    charisma?: { persuasion: number; intimidation: number; manipulation: number; };
    stealth?: { presenceControl: number; silence: number; environmentControl: number; visualMasking: number; };
    perception?: { acuity: number; focus: number; intuition: number; };
  };
}
```

## Creature Contract
Primary stat:
- combat
- cognition
- predation
- senses
- ferocity

Fallback transisi dari field lama:
- cognition <- intelligence
- predation <- stealth
- senses <- endurance

```ts
creature.stats = {
  combat: number;
  cognition: number;
  predation: number;
  senses: number;
  ferocity: number;

  // fallback transisi
  intelligence?: number;
  stealth?: number;
  endurance?: number;

  detail?: {
    combat?: { strength: number; defense: number; agility: number; endurance: number; adaptation: number; };
    cognition?: { problemSolving: number; memory: number; instinct: number; };
    predation?: { ambush: number; camouflage: number; quietude: number; trapping: number; };
    senses?: { tracking: number; detection: number; awareness: number; };
    ferocity?: { intimidation: number; dominance: number; hostility: number; };
  };
}
```

## Aturan Perhitungan
Semua primary stat dihitung sebagai rata-rata metrik detail masing-masing kategori (integer 0-100).

## Wiring FE Saat Ini
- FE sudah pakai warna accent/theme untuk radar detail karakter dan creature.
- FE saat ini masih fallback ke field lama agar tidak breaking saat rollout BE.
- Saat BE kirim `detail` real per kategori, FE tinggal bind ke object tersebut.
