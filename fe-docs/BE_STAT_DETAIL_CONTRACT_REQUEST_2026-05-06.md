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

## Skill Section Contract (Character & Creature)
Selain stat, FE juga butuh contract eksplisit untuk section `skills` agar authoring dan detail page konsisten.

```ts
skills: Array<{
  id: string;              // unique id (uuid/string)
  name: string;            // nama skill
  category: string;        // contoh: combat, support, utility, command
  level: number;           // 0-100
  description: string;     // deskripsi singkat skill
  icon?: string;           // optional icon/image url
  color?: string;          // optional accent hue/hex
}>
```

Aturan minimum:
- `skills` wajib selalu ada sebagai array (boleh kosong `[]`), jangan `null`.
- setiap item wajib punya `id`, `name`, `category`, `level`, `description`.
- `level` integer `0-100`.
- urutan item dari BE dipertahankan FE saat render.
- jika `icon` berupa file/image URL, FE akan lewat proxy file system (authenticated proxy path) sebelum render.

Endpoint yang terdampak:
- `GET /api/characters/:id`
- `GET /api/creatures/:id`
- endpoint list (jika menampilkan preview skills)
- endpoint create/update character & creature harus menerima dan mengembalikan struktur `skills` yang sama.

## Feature Section Contract (Non-Living: Place, Technology, Project, Other Lore)
Untuk entity non-living, FE memakai section `features` (bukan `skills`).

```ts
features: Array<{
  id: string;              // unique id (uuid/string)
  title: string;           // judul fitur
  summary: string;         // ringkasan singkat
  details?: string;        // optional detail panjang
  icon?: string;           // optional icon/image url
  color?: string;          // optional accent hue/hex
  tags?: string[];         // optional klasifikasi
}>
```

Aturan minimum:
- `features` wajib selalu ada sebagai array (boleh kosong `[]`), jangan `null`.
- setiap item minimal punya `id`, `title`, `summary`.
- urutan item dari BE dipertahankan FE saat render.
- jika `icon` berupa file/image URL, FE akan lewat proxy file system (authenticated proxy path) sebelum render.

Endpoint yang terdampak:
- `GET /api/places/:id`
- `GET /api/technology/:id`
- `GET /api/projects/:id`
- `GET /api/other/:id`
- endpoint create/update untuk entitas di atas harus menerima dan mengembalikan struktur `features` yang sama.

## Wiring FE Saat Ini
- FE sudah pakai warna accent/theme untuk radar detail karakter dan creature.
- FE saat ini masih fallback ke field lama agar tidak breaking saat rollout BE.
- Saat BE kirim `detail` real per kategori, FE tinggal bind ke object tersebut.
- FE author panel sudah create/edit `skills` untuk character dan creature, sehingga perlu parity contract BE di read/write payload.
- FE author panel juga sudah create/edit `features` untuk non-living entities, sehingga perlu parity contract BE yang setara.
