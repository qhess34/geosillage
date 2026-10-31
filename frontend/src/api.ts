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
  headings: HeadingStats
  sources: SourcesState
  corrected_positions: number
  jobs: Job[]
}

export interface SourcesState {
  modified: number
  moved: number
}

export type ExportMode = 'copy' | 'move' | 'in_place'

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
  rank: number | null
  is_360: number
  heading: number | null // final heading
  heading_state: string | null
  heading_manual: number | null
  pos_method: string | null // corrected position method, null = original
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
  heading_auto: number | null
  heading_auto_state: string | null
  heading_stale: number
  sequence_offset: number
  heading_final: number | null
  moved_from: string | null
  source_written_at: number | null
  time_offset: number | null
  flag_names: string[]
}

export interface HeadingStats {
  total: number
  manual: number
  computed: number
  uncertain: number
  missing: number
  stale: number
  with_heading_pct: number
}

export interface Sequence {
  id: number
  name: string
  heading_offset: number
  count: number
  start_idx: number
  end_idx: number
  start: number
  end: number
  duration_s: number
  distance_m: number
  anomalies: number
  gps_jumps: number
  corrected: number
  headings: HeadingStats
}

export interface UndoState {
  undo: string | null
  redo: string | null
}

export interface SeqState {
  sequences: Sequence[]
  undo: UndoState
}

export interface SyncPoint {
  photo_id: number
  offset_s: number
}

export interface Proposal {
  start_idx: number
  end_idx: number
  count: number
  reason: string
}

export interface ExportRecord {
  id: number
  ts: number
  sequence_name: string
  path: string
  photo_count: number
  report: {
    count: number
    with_heading: number
    without_heading: string[]
    corrected_positions: number
    excluded_gps_jumps?: string[]
    foreign_files?: string[]
    mode?: ExportMode
    problems: Record<string, string>
    panoramax_compat: boolean
  }
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
  sequences: (id: string) => req<SeqState>('GET', `/api/projects/${id}/sequences`),
  createSequence: (id: string, start_idx: number, end_idx: number) =>
    req<SeqState & { excluded: number }>('POST', `/api/projects/${id}/sequences`, { start_idx, end_idx }),
  createSequences: (id: string, segments: [number, number][]) =>
    req<SeqState>('POST', `/api/projects/${id}/sequences/bulk`, { segments }),
  proposals: (id: string, gap_s: number, max_dist_m: number, min_photos: number) =>
    req<Proposal[]>('GET', `/api/projects/${id}/sequences/proposals?gap_s=${gap_s}&max_dist_m=${max_dist_m}&min_photos=${min_photos}`),
  updateSequence: (id: string, sid: number, body: { name?: string; heading_offset?: number }) =>
    req<SeqState>('PATCH', `/api/projects/${id}/sequences/${sid}`, body),
  setBounds: (id: string, sid: number, start_idx: number, end_idx: number) =>
    req<SeqState>('PUT', `/api/projects/${id}/sequences/${sid}/bounds`, { start_idx, end_idx }),
  deleteSequence: (id: string, sid: number) => req<SeqState>('DELETE', `/api/projects/${id}/sequences/${sid}`),
  splitSequence: (id: string, sid: number, photo: number) =>
    req<SeqState>('POST', `/api/projects/${id}/sequences/${sid}/split?photo_id=${photo}`),
  mergeSequences: (id: string, ids: number[]) => req<SeqState>('POST', `/api/projects/${id}/sequences/merge`, { ids }),
  removePhotos: (id: string, ids: number[]) => req<SeqState>('POST', `/api/projects/${id}/sequences/remove-photos`, { ids }),
  undo: (id: string) => req<SeqState & { done: string }>('POST', `/api/projects/${id}/undo`),
  redo: (id: string) => req<SeqState & { done: string }>('POST', `/api/projects/${id}/redo`),
  setHeading: (id: string, photo: number, value: number | null) =>
    req<{ undo: UndoState }>('PUT', `/api/projects/${id}/photos/${photo}/heading`, { value }),
  headingRange: (id: string, start_idx: number, end_idx: number, mode: 'offset' | 'set' | 'clear', value = 0) =>
    req<{ changed: number; skipped: number; undo: UndoState }>('POST', `/api/projects/${id}/headings/range`, {
      start_idx,
      end_idx,
      mode,
      value,
    }),
  recomputeHeadings: (id: string) => req<HeadingStats>('POST', `/api/projects/${id}/headings/recompute`),
  exportSequences: (
    id: string,
    out_dir: string | null,
    sequence_ids: number[] | null,
    panoramax_compat: boolean,
    exclude_gps_jumps: boolean,
    mode: ExportMode,
  ) =>
    req<{ job_id: string; out_dir: string | null }>('POST', `/api/projects/${id}/export`, {
      out_dir,
      sequence_ids,
      panoramax_compat,
      exclude_gps_jumps,
      mode,
    }),
  track: (id: string) => req<{ runs: [number, number, number][][]; max_extrapolation_s: number }>('GET', `/api/projects/${id}/track`),
  syncOffset: (id: string, photo: number, lat: number, lon: number) =>
    req<{ offset_s: number; lat: number; lon: number }>('GET', `/api/projects/${id}/timesync/offset?photo_id=${photo}&lat=${lat}&lon=${lon}`),
  syncApply: (
    id: string,
    body: { offset_s: number; scope: 'all' | 'sequence' | 'range'; sequence_id?: number; start_idx?: number; end_idx?: number; keep_manual: boolean },
  ) => req<{ changed: number; kept_manual: number; uncovered: number; undo: UndoState }>('POST', `/api/projects/${id}/timesync/apply`, body),
  syncPoints: (id: string) => req<{ points: SyncPoint[]; last_offset_s: number | null }>('GET', `/api/projects/${id}/timesync/points`),
  saveSyncPoints: (id: string, points: SyncPoint[]) => req<{ points: SyncPoint[] }>('PUT', `/api/projects/${id}/timesync/points`, points),
  restoreSources: (id: string) => req<{ job_id: string }>('POST', `/api/projects/${id}/sources/restore`),
  setPosition: (id: string, photo: number, lat: number | null, lon: number | null) =>
    req<{ undo: UndoState }>('PUT', `/api/projects/${id}/photos/${photo}/position`, lat == null ? {} : { lat, lon }),
  positionsBatch: (
    id: string,
    body: { start_idx: number; end_idx: number; mode: 'offset' | 'along' | 'revert'; east_m?: number; north_m?: number; meters?: number },
  ) => req<{ changed: number; skipped: number; undo: UndoState }>('POST', `/api/projects/${id}/positions/batch`, body),
  exports: (id: string) => req<ExportRecord[]>('GET', `/api/projects/${id}/exports`),
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

// Sequence colours (cycled), readable on light and dark basemaps
export const SEQ_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#c026d3']

export function seqColor(seqs: Sequence[], sid: number | null): string {
  if (sid == null) return '#9ca3af'
  const i = seqs.findIndex((s) => s.id === sid)
  return i < 0 ? '#9ca3af' : SEQ_COLORS[i % SEQ_COLORS.length]
}
