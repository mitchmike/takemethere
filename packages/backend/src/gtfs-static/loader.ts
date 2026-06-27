import pg from 'pg';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { Readable } from 'stream';
import copyFrom from 'pg-copy-streams';
import { MELBOURNE_LINES } from '@takemethere/shared';
import { config } from '../config.js';

const lineNameMap = new Map(MELBOURNE_LINES.map(l => [l.name.toLowerCase(), l.lineId]));

function resolveLineId(routeLongName: string): string {
  const lower = routeLongName.toLowerCase();
  for (const [name, id] of lineNameMap) {
    if (lower.includes(name)) return id;
  }
  return lower.replace(/\s+/g, '-');
}

function gtfsTimeToSeconds(timeStr: string | undefined): number | null {
  if (!timeStr || !timeStr.trim()) return null;
  const [h, m, s] = timeStr.trim().split(':').map(Number);
  return h * 3600 + m * 60 + (s ?? 0);
}

function escapeTsv(val: string | number | null): string {
  if (val === null || val === undefined) return '\\N';
  return String(val).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

async function downloadGtfs(url: string): Promise<Buffer> {
  console.log(`Downloading GTFS from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download GTFS: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readCsv(zip: AdmZip, filename: string): Record<string, string>[] {
  const entry = zip.getEntry(filename);
  if (!entry) throw new Error(`${filename} not found in GTFS zip`);
  let content = entry.getData().toString('utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

async function copyRows(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: (string | number | null)[][],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = client.query(
      copyFrom.from(`COPY ${table} (${columns.join(', ')}) FROM STDIN WITH (FORMAT text, NULL '\\N')`),
    );
    const readable = Readable.from(
      rows.map(row => row.map(escapeTsv).join('\t') + '\n'),
    );
    readable.on('error', reject);
    stream.on('error', reject);
    stream.on('finish', resolve);
    readable.pipe(stream);
  });
}

export type ProgressStep = 'downloading' | 'routes' | 'stops' | 'trips' | 'stop_times' | 'view' | 'done';
export type ProgressCallback = (step: ProgressStep, count?: number) => void;

export async function run(onProgress?: ProgressCallback): Promise<void> {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  const client = await pool.connect();

  try {
    onProgress?.('downloading');
    const zipBuffer = await downloadGtfs(config.PTV_GTFS_URL ?? 'https://data.ptv.vic.gov.au/downloads/gtfs.zip');
    const outer = new AdmZip(zipBuffer);

    const innerEntry = outer.getEntry('2/google_transit.zip');
    if (!innerEntry) throw new Error('Metro rail zip (2/google_transit.zip) not found');
    const zip = new AdmZip(innerEntry.getData());

    // -- Routes --
    const routes = readCsv(zip, 'routes.txt').filter(r => r.route_type === '400');
    for (const r of routes) {
      await client.query(
        `INSERT INTO routes (route_id, route_short_name, route_long_name, route_type, route_color, line_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (route_id) DO UPDATE SET
           route_short_name=EXCLUDED.route_short_name, route_long_name=EXCLUDED.route_long_name,
           route_color=EXCLUDED.route_color, line_id=EXCLUDED.line_id`,
        [r.route_id, r.route_short_name, r.route_long_name, 400, r.route_color || null, resolveLineId(r.route_long_name)],
      );
    }
    onProgress?.('routes', routes.length);

    // -- Stops --
    const stops = readCsv(zip, 'stops.txt');
    await client.query('TRUNCATE stops CASCADE');
    await copyRows(client, 'stops', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
      stops.map(s => [s.stop_id, s.stop_name, parseFloat(s.stop_lat), parseFloat(s.stop_lon)]));
    onProgress?.('stops', stops.length);

    // -- Trips --
    const routeIds = new Set(routes.map(r => r.route_id));
    const trips = readCsv(zip, 'trips.txt').filter(t => routeIds.has(t.route_id));
    await client.query('TRUNCATE trips CASCADE');
    await copyRows(client, 'trips', ['trip_id', 'route_id', 'service_id', 'trip_headsign', 'direction_id'],
      trips.map(t => [t.trip_id, t.route_id, t.service_id, t.trip_headsign || null, parseInt(t.direction_id) || 0]));
    onProgress?.('trips', trips.length);

    // -- Stop times --
    onProgress?.('stop_times');
    const tripIds = new Set(trips.map(t => t.trip_id));
    const stopTimes = readCsv(zip, 'stop_times.txt').filter(st => tripIds.has(st.trip_id));

    await client.query('DROP INDEX IF EXISTS stop_times_stop_id_idx');
    await client.query('DROP INDEX IF EXISTS stop_times_trip_id_idx');
    await client.query('TRUNCATE stop_times');

    await copyRows(
      client,
      'stop_times',
      ['trip_id', 'stop_sequence', 'stop_id', 'arrival_time', 'departure_time'],
      stopTimes.map(st => [
        st.trip_id,
        parseInt(st.stop_sequence),
        st.stop_id,
        gtfsTimeToSeconds(st.arrival_time),
        gtfsTimeToSeconds(st.departure_time),
      ]),
    );

    await client.query('CREATE INDEX stop_times_stop_id_idx ON stop_times (stop_id)');
    await client.query('CREATE INDEX stop_times_trip_id_idx ON stop_times (trip_id)');
    onProgress?.('stop_times', stopTimes.length);

    onProgress?.('view');
    await client.query('REFRESH MATERIALIZED VIEW line_station_order');
    onProgress?.('done');

  } finally {
    client.release();
    await pool.end();
  }
}
