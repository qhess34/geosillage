// Thin typed client for the local backend API.

export interface ProjectItem {
  id: string
  name: string
  created_at: number
  photo_count: number
}

export interface Job {
  id: string
  kind: string
  state: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
  done: number
  total: number
  message: string | null
  created_at: number
  updated_at: number
}

export interface Summary {
  total: number
  geolocated: number
  no_gps: number
  no_date: number
  duplicates: number
  invalid_coords: number
  gps_jumps: number
  gps_anomalies: number
  interruptions: number
  same_time: number
  unreadable: number
  missing_files: number
  is_360: number
  start: number | null
  end: number | null
  duration_s: number | null
  distance_m: number
  thumbs_done: number
  thumbs_failed: number
  cameras: { make: string | null; model: string | null; count: number }[]
}

export interface Project {
  id: string
  name: string
  created_at: number
  settings: Record<string, number>
  source_dirs: string[]
  summary: Summary
  jobs: Job[]
}

// Column arrays as sent by /photos (compact for 10k+ photos)
export interface PhotoRow {
  id: number
  idx: number
  ts: number | null
  lat: number | null
  lon: number | null
  lat_orig: number | null
  lon_orig: number | null
  flags: number
  thumb: number
  sequence_id: number | null
  is_360: number
}

export interface PhotoDetail extends PhotoRow {
  path: string
  filename: string
  size: number
  ts_text: string | null
  gps_ts: number | null
  alt: number | null
  heading_exif: number | null
  gps_track: number | null
  gps_dop: number | null
  make: string | null
  model: string | null
  width: number | null
  height: number | null
  projection: string | null
  flag_names: string[]
}

export interface FsListing {
  path: string
  parent: string | null
  dirs: string[]
  jpeg_count: number
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* not json */
    }
    throw new Error(msg)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  projects: () => req<ProjectItem[]>('GET', '/api/projects'),
  createProject: (name: string) => req<{ id: string }>('POST', '/api/projects', { name }),
  deleteProject: (id: string) => req<void>('DELETE', `/api/projects/${id}`),
  project: (id: string) => req<Project>('GET', `/api/projects/${id}`),
  updateProject: (id: string, body: object) => req<Project>('PATCH', `/api/projects/${id}`, body),
  importPaths: (id: string, paths: string[]) => req<{ job_id: string }>('POST', `/api/projects/${id}/import`, { paths }),
  checkFiles: (id: string) => req<{ job_id: string }>('POST', `/api/projects/${id}/check-files`),
  retryThumbs: (id: string) => req<{ job_id: string }>('POST', `/api/projects/${id}/thumbnails?retry_failed=true`),
  cancelJob: (id: string, job: string) => req<unknown>('POST', `/api/projects/${id}/jobs/${job}/cancel`),
  async photos(id: string): Promise<PhotoRow[]> {
    const r = await req<{ fields: string[]; rows: unknown[][] }>('GET', `/api/projects/${id}/photos`)
    return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])) as unknown as PhotoRow)
  },
  photo: (id: string, photo: number) => req<PhotoDetail>('GET', `/api/projects/${id}/photos/${photo}`),
  exif: (id: string, photo: number) => req<Record<string, unknown>>('GET', `/api/projects/${id}/photos/${photo}/exif`),
  fs: (path: string) => req<FsListing>('GET', `/api/fs?path=${encodeURIComponent(path)}`),
  thumbUrl: (id: string, photo: number) => `/api/projects/${id}/photos/${photo}/thumb`,
  imageUrl: (id: string, photo: number) => `/api/projects/${id}/photos/${photo}/image`,
}

// Must match backend/app/db.py
export const FLAGS = {
  NO_GPS: 1,
  NO_DATE: 2,
  DUPLICATE: 4,
  INVALID_COORD: 8,
  GPS_JUMP: 16,
  GAP_BEFORE: 32,
  UNREADABLE: 64,
  SAME_TIME: 128,
  MISSING_FILE: 256,
} as const

export const FLAG_LABELS: Record<string, string> = {
  no_gps: 'Sans GPS',
  no_date: 'Sans date',
  duplicate: 'Doublon',
  invalid_coord: 'Coordonnées invalides',
  gps_jump: 'Saut GPS',
  gap_before: 'Interruption avant cette photo',
  unreadable: 'Illisible',
  same_time: 'Même horodatage que la précédente',
  missing_file: 'Fichier source introuvable',
}
