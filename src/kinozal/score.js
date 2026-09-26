// Picks the "best" release for a movie:
// 1080p (or 4K), 7–15 GB, subtitles (original + subs preferred), gold, many seeds.

const GB = 1024 ** 3
const IDEAL_MIN = 7 * GB
const IDEAL_MAX = 15 * GB

export function scoreRelease (r) {
  let score = 0
  const reasons = []
  const warnings = []

  if (r.resolution === 1080 || r.resolution === 2160) {
    score += 30
    reasons.push(r.resolution === 2160 ? '4K' : '1080p')
  } else if (r.resolution === 720) {
    score += 12
    warnings.push('только 720p')
  } else {
    warnings.push(r.resolution ? `${r.resolution}p` : 'качество не указано')
  }

  const gb = r.size / GB
  if (r.size >= IDEAL_MIN && r.size <= IDEAL_MAX) {
    score += 25
    reasons.push('размер 7–15 ГБ')
  } else if (r.size < IDEAL_MIN) {
    score += 25 * Math.max(0, (gb - 1) / 6)
    warnings.push('меньше 7 ГБ')
  } else {
    score += 25 * Math.max(0.3, 1 - (gb - 15) / 40)
    warnings.push('больше 15 ГБ')
  }

  if (r.seeds <= 0) {
    score -= 40
    warnings.push('нет сидов')
  } else {
    score += 20 * Math.min(1, Math.log10(r.seeds + 1) / Math.log10(200))
    if (r.seeds < 5) warnings.push('мало сидов')
    else reasons.push(`${r.seeds} сидов`)
  }

  if (r.subs) {
    score += 15
    reasons.push('субтитры')
    if (!r.voice) {
      score += 5
      reasons.push('оригинал')
    }
  }

  if (r.gold) {
    score += 10
    reasons.push('золотая')
  }

  return { score: Math.round(score * 10) / 10, reasons, warnings }
}

export function rankReleases (releases) {
  return releases
    .map(r => ({ ...r, ...scoreRelease(r) }))
    .sort((a, b) => b.score - a.score || b.seeds - a.seeds)
}

export const normTitle = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function movieKey (r) {
  return `${normTitle(r.titles[0])}|${r.year || ''}`
}

/** Group search results into movies. */
export function groupMovies (releases) {
  const map = new Map()
  for (const r of releases) {
    const key = movieKey(r)
    let m = map.get(key)
    if (!m) {
      m = { key, title: r.titles[0], altTitles: r.titles.slice(1), year: r.year, releases: [] }
      map.set(key, m)
    }
    m.releases.push(r)
  }
  return [...map.values()].map(m => {
    const ranked = rankReleases(m.releases)
    return {
      key: m.key,
      title: m.title,
      altTitles: m.altTitles,
      year: m.year,
      count: ranked.length,
      maxSeeds: Math.max(...ranked.map(r => r.seeds)),
      resolutions: [...new Set(ranked.map(r => r.resolution).filter(Boolean))].sort((a, b) => b - a),
      hasGold: ranked.some(r => r.gold),
      best: ranked[0]
    }
  }).sort((a, b) => b.maxSeeds - a.maxSeeds)
}

/** Does a release belong to the given movie (same main title or alt title, same year)? */
export function sameMovie (r, movie) {
  if (movie.year && r.year && movie.year !== r.year) return false
  const wanted = new Set([movie.title, ...(movie.altTitles || [])].map(normTitle))
  return r.titles.some(t => wanted.has(normTitle(t)))
}
